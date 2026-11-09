# Cross-compile on the build machine's architecture; the result is a static binary for TARGETARCH.
FROM --platform=$BUILDPLATFORM golang:1.26-bookworm AS build
ARG TARGETARCH
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY *.go ./
# Version-control details for telemetry, from build args (see README, "Building the images"), compiled into the
# binary. Unlike the other images, this one doesn't set OTEL_RESOURCE_ATTRIBUTES: the operator's injector can't
# load into a static binary, so the manifest uses OTEL_RESOURCE_ATTRIBUTES for service.namespace instead.
ARG VCS_REVISION=unknown
ARG VCS_REPOSITORY_URL=unknown
RUN CGO_ENABLED=0 GOOS=linux GOARCH=$TARGETARCH go build -trimpath \
    -ldflags="-s -w -X main.vcsRevision=$VCS_REVISION -X main.vcsRepositoryURL=$VCS_REPOSITORY_URL" -o /inventory .

FROM gcr.io/distroless/static-debian12:nonroot
ARG VCS_REVISION=unknown
ARG VCS_REPOSITORY_URL=unknown
LABEL org.opencontainers.image.revision=$VCS_REVISION org.opencontainers.image.source=$VCS_REPOSITORY_URL
COPY --from=build /inventory /inventory

EXPOSE 8080
ENTRYPOINT ["/inventory"]
