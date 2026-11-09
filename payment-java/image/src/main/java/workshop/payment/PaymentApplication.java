package workshop.payment;

import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ThreadLocalRandom;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

/**
 * Payment service for the workshop shop. There is no OpenTelemetry code here: the Dash0 operator adds
 * the Java agent through JAVA_TOOL_OPTIONS, which traces Spring MVC and puts trace_id/span_id into the
 * logging context, so they appear in the JSON log lines.
 */
@SpringBootApplication
@RestController
public class PaymentApplication {

    private static final Logger log = LoggerFactory.getLogger(PaymentApplication.class);

    /** Share of payments that fail with a provider error, 0.0 to 1.0. Set by PAYMENT_FAILURE_RATE. */
    private final double failureRate;

    public PaymentApplication(@Value("${PAYMENT_FAILURE_RATE:0}") double failureRate) {
        this.failureRate = failureRate;
    }

    public static void main(String[] args) {
        SpringApplication.run(PaymentApplication.class, args);
    }

    record PaymentRequest(String orderId, long amountCents, String currency) {}

    record PaymentResponse(String paymentId, String orderId, String status) {}

    static class PaymentProviderException extends RuntimeException {
        PaymentProviderException(String message) {
            super(message);
        }
    }

    @PostMapping("/payments")
    public PaymentResponse pay(@RequestBody PaymentRequest request) throws InterruptedException {
        if (request.amountCents() <= 0) {
            throw new IllegalArgumentException("amountCents must be positive");
        }
        // Pretend to talk to a payment provider.
        Thread.sleep(ThreadLocalRandom.current().nextLong(80, 250));
        if (ThreadLocalRandom.current().nextDouble() < failureRate) {
            throw new PaymentProviderException("payment provider timed out");
        }
        String paymentId = "pay_" + UUID.randomUUID().toString().substring(0, 8);
        log.info("payment authorized orderId={} amountCents={} paymentId={}", request.orderId(), request.amountCents(), paymentId);
        return new PaymentResponse(paymentId, request.orderId(), "authorized");
    }

    @ExceptionHandler(PaymentProviderException.class)
    @ResponseStatus(HttpStatus.BAD_GATEWAY)
    Map<String, String> providerFailed(PaymentProviderException e) {
        log.error("payment failed: {}", e.getMessage());
        return Map.of("error", e.getMessage());
    }

    @ExceptionHandler(IllegalArgumentException.class)
    @ResponseStatus(HttpStatus.BAD_REQUEST)
    Map<String, String> badRequest(IllegalArgumentException e) {
        log.warn("rejected payment request: {}", e.getMessage());
        return Map.of("error", e.getMessage());
    }
}
