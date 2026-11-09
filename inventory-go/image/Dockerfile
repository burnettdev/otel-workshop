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
# Version-control details for telemetry, from build args (see README, "Building the images"). Every OpenTelemetry
# SDK, including the agents the Dash0 operator injects, reads OTEL_RESOURCE_ATTRIBUTES; the operator appends its
# own k8s.* and service.* attributes to it. Don't set OTEL_RESOURCE_ATTRIBUTES in the manifest: that would replace this.
ARG VCS_REVISION=unknown
ARG VCS_REPOSITORY_URL=unknown
LABEL org.opencontainers.image.revision=$VCS_REVISION org.opencontainers.image.source=$VCS_REPOSITORY_URL
ENV OTEL_RESOURCE_ATTRIBUTES=vcs.ref.head.revision=$VCS_REVISION,vcs.repository.url.full=$VCS_REPOSITORY_URL

EXPOSE 8080
ENTRYPOINT ["/inventory"]
