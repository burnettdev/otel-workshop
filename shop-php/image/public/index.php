<?php

declare(strict_types=1);

use GuzzleHttp\Client;
use OpenTelemetry\API\Globals;
use OpenTelemetry\API\Trace\StatusCode;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;
use Shop\Log;
use Slim\Factory\AppFactory;

require __DIR__ . '/../vendor/autoload.php';

function db(): PDO
{
    return new PDO(
        sprintf('mysql:host=%s;dbname=%s;charset=utf8mb4', getenv('DB_HOST'), getenv('DB_NAME')),
        getenv('DB_USER'),
        getenv('DB_PASSWORD'),
        [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_TIMEOUT => 3],
    );
}

// Deliberately slow query, used by /slow and by /checkout when CHECKOUT_SLOW_QUERY=true.
function slowQuery(): int
{
    return (int) db()->query('SELECT SLEEP(2) AS slept')->fetchColumn();
}

function json(Response $response, array $body, int $status = 200): Response
{
    $response->getBody()->write(json_encode($body, JSON_UNESCAPED_SLASHES));
    return $response->withHeader('Content-Type', 'application/json')->withStatus($status);
}

function client(string $urlEnv): Client
{
    return new Client(['base_uri' => getenv($urlEnv), 'timeout' => 3]);
}

final class OutOfStock extends RuntimeException
{
}

/**
 * Checks stock, prices the items and quotes shipping (inside the shipping.quote span), then charges
 * the payment service. $items is a list of ['id' => int, 'qty' => int].
 */
function checkout(Response $response, array $items): Response
{
    $tracer = Globals::tracerProvider()->getTracer('shop-php');
    $span = $tracer->spanBuilder('shipping.quote')->startSpan();
    $span->setAttribute('order.items', count($items));
    $scope = $span->activate();
    try {
        $inventory = client('INVENTORY_URL');
        $pricing = client('PRICING_URL');
        $lines = [];
        $weight = 0;
        foreach ($items as $item) {
            $stock = json_decode((string) $inventory->get("/stock/{$item['id']}")->getBody(), true);
            if ($stock['stock'] < $item['qty']) {
                throw new OutOfStock("product {$item['id']} is out of stock");
            }
            $line = json_decode((string) $pricing->get("/price/{$item['id']}")->getBody(), true);
            $line['qty'] = $item['qty'];
            $lines[] = $line;
            $weight += $line['weight_g'] * $item['qty'];
        }
        // Pretend to ask a carrier for a rate.
        usleep(random_int(50, 150) * 1000);
        if (getenv('CHECKOUT_SLOW_QUERY') === 'true') {
            slowQuery();
            Log::warning('checkout ran slow query', ['db.sleep_seconds' => 2]);
        }
        $shipping = 499 + intdiv($weight, 500) * 150;
        $subtotal = array_sum(array_map(fn ($l) => $l['price_cents'] * $l['qty'], $lines));
    } catch (OutOfStock $e) {
        Log::warning('checkout rejected', ['error' => $e->getMessage()]);
        return json($response, ['error' => $e->getMessage()], 409);
    } catch (Throwable $e) {
        $span->recordException($e);
        $span->setStatus(StatusCode::STATUS_ERROR, $e->getMessage());
        Log::error('checkout failed', ['error' => $e->getMessage()]);
        return json($response, ['error' => 'checkout failed'], 502);
    } finally {
        $scope->detach();
        $span->end();
    }

    $orderId = 'ord_' . bin2hex(random_bytes(4));
    try {
        $payment = json_decode((string) client('PAYMENT_URL')->post('/payments', ['json' => [
            'orderId' => $orderId,
            'amountCents' => $subtotal + $shipping,
            'currency' => 'EUR',
        ]])->getBody(), true);
    } catch (Throwable $e) {
        Log::error('payment failed', ['order.id' => $orderId, 'error' => $e->getMessage()]);
        return json($response, ['error' => 'payment failed, please try again', 'order_id' => $orderId], 502);
    }

    Log::info('order placed', [
        'order.id' => $orderId,
        'order.items' => count($items),
        'order.total_cents' => $subtotal + $shipping,
    ]);
    return json($response, [
        'order_id' => $orderId,
        'payment_id' => $payment['paymentId'],
        'lines' => $lines,
        'subtotal_cents' => $subtotal,
        'shipping_cents' => $shipping,
        'total_cents' => $subtotal + $shipping,
    ]);
}

$app = AppFactory::create();
$app->addRoutingMiddleware();
$app->addBodyParsingMiddleware();
$app->addErrorMiddleware(false, false, false);

$app->get('/products', function (Request $request, Response $response) {
    $products = db()->query('SELECT id, name, price_cents, stock FROM products ORDER BY id')->fetchAll(PDO::FETCH_ASSOC);
    Log::info('listed products', ['products.count' => count($products)]);
    return json($response, ['products' => $products]);
});

// The route has no regex constraint ({id:[0-9]+}) because the Slim instrumentation uses the pattern verbatim
// as span name and http.route; the id is validated here instead.
$app->get('/products/{id}', function (Request $request, Response $response, array $args) {
    if (!ctype_digit($args['id'])) {
        return json($response, ['error' => 'unknown product'], 404);
    }
    $statement = db()->prepare('SELECT id, name, price_cents, weight_g, stock FROM products WHERE id = ?');
    $statement->execute([(int) $args['id']]);
    $product = $statement->fetch(PDO::FETCH_ASSOC);
    if ($product === false) {
        return json($response, ['error' => 'unknown product'], 404);
    }

    // Recommendations are optional: if the service fails, the product page still renders.
    $recommendations = [];
    try {
        $body = client('RECOMMENDATIONS_URL')->get('/recommendations', ['query' => ['product' => $product['id']]])->getBody();
        $recommendations = json_decode((string) $body, true)['recommendations'];
    } catch (Throwable $e) {
        Log::warning('recommendations unavailable', ['product.id' => $product['id'], 'error' => $e->getMessage()]);
    }

    Log::info('viewed product', ['product.id' => $product['id']]);
    return json($response, ['product' => $product, 'recommendations' => $recommendations]);
});

// Random cart, used by the load generator and the curl-based scenarios.
$app->get('/checkout', function (Request $request, Response $response) {
    $count = random_int(1, 4);
    $ids = db()->query("SELECT id FROM products WHERE stock > 0 ORDER BY RAND() LIMIT $count")->fetchAll(PDO::FETCH_COLUMN);
    return checkout($response, array_map(fn ($id) => ['id' => (int) $id, 'qty' => 1], $ids));
});

// Checkout of the storefront's cart: {"items": [{"id": 1, "qty": 2}, ...]}.
$app->post('/checkout', function (Request $request, Response $response) {
    $items = [];
    foreach ((array) ($request->getParsedBody()['items'] ?? []) as $item) {
        $id = (int) ($item['id'] ?? 0);
        $qty = (int) ($item['qty'] ?? 0);
        if ($id > 0 && $qty > 0 && $qty <= 10) {
            $items[] = ['id' => $id, 'qty' => $qty];
        }
    }
    if ($items === []) {
        return json($response, ['error' => 'cart is empty'], 400);
    }
    return checkout($response, $items);
});

$app->get('/slow', function (Request $request, Response $response) {
    $result = slowQuery();
    Log::warning('slow query finished', ['db.sleep_seconds' => 2]);
    return json($response, ['slept' => $result]);
});

$app->run();
