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

EXPOSE 80
