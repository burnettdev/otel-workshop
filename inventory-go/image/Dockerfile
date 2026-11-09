# Cross-compile on the build machine's architecture; the result is a static binary for TARGETARCH.
FROM --platform=$BUILDPLATFORM golang:1.26-bookworm AS build
ARG TARGETARCH
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY *.go ./
RUN CGO_ENABLED=0 GOOS=linux GOARCH=$TARGETARCH go build -trimpath -ldflags="-s -w" -o /inventory .

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /inventory /inventory
EXPOSE 8080
ENTRYPOINT ["/inventory"]
