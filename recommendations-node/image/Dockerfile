# Debian-based (glibc) Node.js image. The Dash0 operator injects its Node.js distribution at deploy time.
FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY server.js ./
USER node
# Version-control details for telemetry, from build args (see README, "Building the images"). Every OpenTelemetry
# SDK, including the agents the Dash0 operator injects, reads OTEL_RESOURCE_ATTRIBUTES; the operator appends its
# own k8s.* and service.* attributes to it. Don't set OTEL_RESOURCE_ATTRIBUTES in the manifest: that would replace this.
ARG VCS_REVISION=unknown
ARG VCS_REPOSITORY_URL=unknown
LABEL org.opencontainers.image.revision=$VCS_REVISION org.opencontainers.image.source=$VCS_REPOSITORY_URL
ENV OTEL_RESOURCE_ATTRIBUTES=vcs.ref.head.revision=$VCS_REVISION,vcs.repository.url.full=$VCS_REPOSITORY_URL

EXPOSE 3000
CMD ["node", "server.js"]
