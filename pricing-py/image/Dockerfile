FROM python:3.13-slim-bookworm

WORKDIR /app
COPY requirements.txt .
# opentelemetry-bootstrap installs the instrumentations matching the libraries above (FastAPI, PyMySQL, ...).
RUN pip install --no-cache-dir -r requirements.txt \
 && opentelemetry-bootstrap -a install \
 && pip check

COPY app.py main.py ./

USER 65534
# Version-control details for telemetry, from build args (see README, "Building the images"). Every OpenTelemetry
# SDK, including the agents the Dash0 operator injects, reads OTEL_RESOURCE_ATTRIBUTES; the operator appends its
# own k8s.* and service.* attributes to it. Don't set OTEL_RESOURCE_ATTRIBUTES in the manifest: that would replace this.
ARG VCS_REVISION=unknown
ARG VCS_REPOSITORY_URL=unknown
LABEL org.opencontainers.image.revision=$VCS_REVISION org.opencontainers.image.source=$VCS_REPOSITORY_URL
ENV OTEL_RESOURCE_ATTRIBUTES=vcs.ref.head.revision=$VCS_REVISION,vcs.repository.url.full=$VCS_REPOSITORY_URL

EXPOSE 8000
CMD ["opentelemetry-instrument", "python", "main.py"]
