# Build the jar on the build machine's architecture (it's architecture-independent), run on a glibc JRE.
FROM --platform=$BUILDPLATFORM maven:3.9-eclipse-temurin-21 AS build
WORKDIR /src
COPY pom.xml ./
RUN mvn -q -B dependency:go-offline
COPY src ./src
RUN mvn -q -B package -DskipTests

FROM eclipse-temurin:21-jre
COPY --from=build /src/target/payment.jar /app/payment.jar
USER 65534
# Version-control details for telemetry, from build args (see README, "Building the images"). Every OpenTelemetry
# SDK, including the agents the Dash0 operator injects, reads OTEL_RESOURCE_ATTRIBUTES; the operator appends its
# own k8s.* and service.* attributes to it. Don't set OTEL_RESOURCE_ATTRIBUTES in the manifest: that would replace this.
ARG VCS_REVISION=unknown
ARG VCS_REPOSITORY_URL=unknown
LABEL org.opencontainers.image.revision=$VCS_REVISION org.opencontainers.image.source=$VCS_REPOSITORY_URL
ENV OTEL_RESOURCE_ATTRIBUTES=vcs.ref.head.revision=$VCS_REVISION,vcs.repository.url.full=$VCS_REPOSITORY_URL

EXPOSE 8080
ENTRYPOINT ["java", "-jar", "/app/payment.jar"]
