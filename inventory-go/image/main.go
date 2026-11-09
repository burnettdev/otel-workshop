// inventory-go: stock lookups for the workshop shop.
//
// The Dash0 operator can't instrument Go, so this service uses the OpenTelemetry Go SDK directly.
// The OTLP endpoint and protocol come from the environment variables the operator injects
// (OTEL_EXPORTER_OTLP_ENDPOINT, OTEL_EXPORTER_OTLP_PROTOCOL), and service.name from OTEL_SERVICE_NAME.
package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/XSAM/otelsql"
	_ "github.com/go-sql-driver/mysql"
	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"go.opentelemetry.io/otel/propagation"
	sdkresource "go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	semconv "go.opentelemetry.io/otel/semconv/v1.43.0"
	"go.opentelemetry.io/otel/trace"
)

// traceHandler adds the active trace and span IDs to every JSON log line, so logs correlate with traces.
type traceHandler struct{ slog.Handler }

func (h traceHandler) Handle(ctx context.Context, r slog.Record) error {
	if sc := trace.SpanContextFromContext(ctx); sc.IsValid() {
		r.AddAttrs(slog.String("trace_id", sc.TraceID().String()), slog.String("span_id", sc.SpanID().String()))
	}
	return h.Handler.Handle(ctx, r)
}

func (h traceHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	return traceHandler{h.Handler.WithAttrs(attrs)}
}

func (h traceHandler) WithGroup(name string) slog.Handler {
	return traceHandler{h.Handler.WithGroup(name)}
}

// withRoute sets the server span's name and http.route to the matched route template, e.g.
// "GET /stock/{id}", instead of the raw path. Span names must stay low-cardinality: one per route, not
// one per product id. otelhttp can't do this itself because it starts the span before the mux routes.
func withRoute(mux *http.ServeMux) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, pattern := mux.Handler(r); pattern != "" {
			// Patterns are registered as "METHOD /path"; http.route is the path part only.
			route := pattern
			if _, path, found := strings.Cut(pattern, " "); found {
				route = path
			}
			span := trace.SpanFromContext(r.Context())
			span.SetName(r.Method + " " + route)
			span.SetAttributes(semconv.HTTPRoute(route))
		}
		mux.ServeHTTP(w, r)
	})
}

func setupTracing(ctx context.Context) (func(context.Context) error, error) {
	exporter, err := otlptracehttp.New(ctx)
	if err != nil {
		return nil, err
	}
	res, err := sdkresource.Merge(sdkresource.Default(), sdkresource.NewSchemaless(semconv.ServiceName("inventory-go")))
	if err != nil {
		return nil, err
	}
	tp := sdktrace.NewTracerProvider(sdktrace.WithBatcher(exporter), sdktrace.WithResource(res))
	otel.SetTracerProvider(tp)
	otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(propagation.TraceContext{}, propagation.Baggage{}))
	return tp.Shutdown, nil
}

func main() {
	opts := &slog.HandlerOptions{
		// Level names the shared log transform recognises: INFO, WARN, ERROR.
		ReplaceAttr: func(_ []string, a slog.Attr) slog.Attr {
			switch a.Key {
			case slog.TimeKey:
				a.Key = "time"
			case slog.MessageKey:
				a.Key = "message"
			}
			return a
		},
	}
	logger := slog.New(traceHandler{slog.NewJSONHandler(os.Stdout, opts)}).With("service", "inventory-go")
	slog.SetDefault(logger)

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	shutdown, err := setupTracing(ctx)
	if err != nil {
		logger.Error("tracing setup failed", "error", err)
		os.Exit(1)
	}

	dsn := fmt.Sprintf("%s:%s@tcp(%s:3306)/%s?timeout=3s", os.Getenv("DB_USER"), os.Getenv("DB_PASSWORD"), os.Getenv("DB_HOST"), os.Getenv("DB_NAME"))
	db, err := otelsql.Open("mysql", dsn, otelsql.WithAttributes(semconv.DBSystemNameMySQL, semconv.ServerAddress(os.Getenv("DB_HOST")), semconv.DBNamespace(os.Getenv("DB_NAME"))),
		// Do not record the driver's internal "skip fast-path" signal as an error on DB spans.
		otelsql.WithSpanOptions(otelsql.SpanOptions{DisableErrSkip: true}))
	if err != nil {
		logger.Error("db open failed", "error", err)
		os.Exit(1)
	}
	defer db.Close()

	mux := http.NewServeMux()
	mux.HandleFunc("GET /stock/{id}", func(w http.ResponseWriter, r *http.Request) {
		id, err := strconv.Atoi(r.PathValue("id"))
		if err != nil {
			http.Error(w, `{"error":"invalid id"}`, http.StatusBadRequest)
			return
		}
		var stock int
		err = db.QueryRowContext(r.Context(), "SELECT stock FROM products WHERE id = ?", id).Scan(&stock)
		if errors.Is(err, sql.ErrNoRows) {
			logger.WarnContext(r.Context(), "unknown product", "product.id", id)
			http.Error(w, `{"error":"unknown product"}`, http.StatusNotFound)
			return
		}
		if err != nil {
			logger.ErrorContext(r.Context(), "stock lookup failed", "product.id", id, "error", err)
			http.Error(w, `{"error":"stock lookup failed"}`, http.StatusInternalServerError)
			return
		}
		logger.InfoContext(r.Context(), "checked stock", "product.id", id, "stock", stock)
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"id": id, "stock": stock, "available": stock > 0})
	})

	server := &http.Server{
		Addr: ":8080",
		// otelhttp creates a server span per request; withRoute names it after the matched route template.
		Handler:           otelhttp.NewHandler(withRoute(mux), "inventory-go"),
		ReadHeaderTimeout: 5 * time.Second,
	}
	go func() {
		logger.Info("listening", "addr", server.Addr)
		if err := server.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
			logger.Error("server failed", "error", err)
			os.Exit(1)
		}
	}()

	<-ctx.Done()
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	server.Shutdown(shutdownCtx)
	shutdown(shutdownCtx)
}
