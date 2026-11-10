FROM python:3.13-slim-bookworm

WORKDIR /app
# Standard library only, so there's nothing to install.
COPY app.py .

USER 65534
# Version-control details, from build args (see README, "Building the images"). This service sends no traces,
# so they only go into the image labels.
ARG VCS_REVISION=unknown
ARG VCS_REPOSITORY_URL=unknown
LABEL org.opencontainers.image.revision=$VCS_REVISION org.opencontainers.image.source=$VCS_REPOSITORY_URL

EXPOSE 8080
CMD ["python", "-u", "app.py"]
