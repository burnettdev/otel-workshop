<?php

declare(strict_types=1);

namespace Shop;

use OpenTelemetry\API\Trace\Span;

/**
 * One JSON object per line on stderr, with the active trace context so logs correlate with traces.
 */
final class Log
{
    public static function info(string $message, array $fields = []): void
    {
        self::write('INFO', $message, $fields);
    }

    public static function warning(string $message, array $fields = []): void
    {
        self::write('WARNING', $message, $fields);
    }

    public static function error(string $message, array $fields = []): void
    {
        self::write('ERROR', $message, $fields);
    }

    private static function write(string $level, string $message, array $fields): void
    {
        $entry = [
            'time' => (new \DateTimeImmutable())->format('Y-m-d\TH:i:s.vP'),
            'level' => $level,
            'service' => 'shop-php',
            'message' => $message,
        ];
        $ctx = Span::getCurrent()->getContext();
        if ($ctx->isValid()) {
            $entry['trace_id'] = $ctx->getTraceId();
            $entry['span_id'] = $ctx->getSpanId();
        }
        file_put_contents('php://stderr', json_encode($entry + $fields, JSON_UNESCAPED_SLASHES) . "\n");
    }
}
