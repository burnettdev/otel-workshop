# Fetch the pinned Dash0 Web SDK bundles from npm (npm verifies the tarball integrity) and serve them
# from the same origin as the site, so the CSP doesn't need a third-party script source.
FROM node:22-alpine AS sdk
WORKDIR /sdk
RUN npm pack --silent @dash0/sdk-web@0.28.2 && tar xzf dash0-sdk-web-0.28.2.tgz

FROM nginx:1.27-alpine
COPY --from=sdk /sdk/package/dist/dash0.iife.js /sdk/package/dist/dash0-session-recording.iife.js /usr/share/nginx/html/vendor/
COPY site/ /usr/share/nginx/html/
# Rendered by the nginx image's entrypoint (envsubst) into /etc/nginx/conf.d/default.conf at start.
COPY default.conf.template /etc/nginx/templates/default.conf.template
# Version-control details, from build args (see README, "Building the images"). nginx passes them to the browser
# SDK as additionalSignalAttributes via /dash0-config.js.
ARG VCS_REVISION=unknown
ARG VCS_REPOSITORY_URL=unknown
LABEL org.opencontainers.image.revision=$VCS_REVISION org.opencontainers.image.source=$VCS_REPOSITORY_URL
ENV DASH0_VCS_REVISION=$VCS_REVISION DASH0_VCS_REPOSITORY_URL=$VCS_REPOSITORY_URL
# Only substitute our own variables, never nginx's.
ENV NGINX_ENVSUBST_FILTER=^DASH0_
