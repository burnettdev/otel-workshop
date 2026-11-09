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
EXPOSE 8080
ENTRYPOINT ["java", "-jar", "/app/payment.jar"]
