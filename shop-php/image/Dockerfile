FROM composer:2.8 AS composer

FROM php:8.3-apache-bookworm

# The opentelemetry extension is what lets the auto-instrumentation packages hook Slim, PDO and Guzzle.
COPY --from=mlocati/php-extension-installer:2.7 /usr/bin/install-php-extensions /usr/local/bin/
RUN install-php-extensions opentelemetry pdo_mysql zip

COPY --from=composer /usr/bin/composer /usr/local/bin/composer
COPY apache-site.conf /etc/apache2/sites-available/000-default.conf
RUN a2disconf other-vhosts-access-log

WORKDIR /var/www/html
COPY composer.json composer.lock ./
RUN composer install --no-dev --no-interaction --no-progress --optimize-autoloader --no-scripts
COPY src ./src
COPY public ./public
RUN composer dump-autoload --no-dev --optimize

# Version-control details for telemetry, from build args (see README, "Building the images"). Every OpenTelemetry
# SDK, including the agents the Dash0 operator injects, reads OTEL_RESOURCE_ATTRIBUTES; the operator appends its
# own k8s.* and service.* attributes to it. Don't set OTEL_RESOURCE_ATTRIBUTES in the manifest: that would replace this.
ARG VCS_REVISION=unknown
ARG VCS_REPOSITORY_URL=unknown
LABEL org.opencontainers.image.revision=$VCS_REVISION org.opencontainers.image.source=$VCS_REPOSITORY_URL
ENV OTEL_RESOURCE_ATTRIBUTES=vcs.ref.head.revision=$VCS_REVISION,vcs.repository.url.full=$VCS_REPOSITORY_URL

EXPOSE 80
