# otel-workshop

Workshop demo environment: a small online shop ("Maker Supply") made of services in five languages, so a single checkout trace runs from the browser through PHP, Go, Python and Java. Everything runs in the `otel-workshop` namespace and is monitored by the Dash0 operator that is already installed on the cluster.

Every component lives in its own subfolder as plain YAML manifests. Files inside a folder are numbered so that `kubectl apply -f <folder>/` creates them in the right order. Services with their own image keep the Dockerfile and source in an `image/` subfolder, which `kubectl apply -f <folder>/` does not read.

```
browser ──► shop-web (storefront, nginx /api proxy)
                 │
loadgen ──► shop-php (PHP, Slim) ──┬──► recommendations-node (Node.js, Express) ──┐
                 │                 ├──► inventory-go (Go)                         ├──► mysql
                 │                 ├──► pricing-py (Python, FastAPI) ─────────────┘
                 │                 └──► payment-java (Java, Spring Boot)
                 └──────────────────────────────────────────────────────────────────► mysql
```

## Prerequisites

- `kubectl` access to the cluster.
- The Dash0 operator installed (`dash0-system` namespace), with a `Dash0OperatorConfiguration` that has a Dash0 export configured. The monitoring resource below has no export of its own, so telemetry goes to that default export.
- Docker with `buildx` and push access to a container registry, to build the three service images (see "Building the images").

## Configure for your environment

The manifests contain placeholders for the values that differ per environment. Replace them before deploying:

| Placeholder | Where | Replace with |
| --- | --- | --- |
| `REGISTRY` | `image:` in `shop-php/`, `pricing-py/`, `shop-web/` | The registry you push the images to, e.g. `ghcr.io/your-org` |
| `YOUR_REGION` | `DASH0_OTLP_ENDPOINT` in `shop-web/10-shop-web.yaml` | Your Dash0 region, as shown on the Endpoints page in Dash0 settings, e.g. `eu-west-1` |
| `YOUR_DATASET` | `DASH0_DATASET` in `shop-web/10-shop-web.yaml` | The dataset in your operator's export: `kubectl get dash0operatorconfiguration -o jsonpath='{.items[0].spec.exports[0].dash0.dataset}'` |
| `REPLACE_WITH_INGEST_ONLY_TOKEN` | `shop-web/00-dash0-web-secret.yaml` | An ingest-only Dash0 auth token (see "shop-web"; better created with `kubectl create secret` than written into the file) |
| `shop.example.com` | `shop-web/optional/ingress.yaml` | Only if you use the optional Ingress |

For example:

```sh
grep -rlE 'REGISTRY/|YOUR_REGION|YOUR_DATASET' --include='*.yaml' . | xargs sed -i.bak \
  -e 's#REGISTRY/#ghcr.io/your-org/#' -e 's#YOUR_REGION#eu-west-1#' -e 's#YOUR_DATASET#default#'
```

## Components

| Folder | What it contains |
| --- | --- |
| [`base/`](base/) | The `otel-workshop` namespace and its `Dash0Monitoring` resource |
| [`mysql/`](mysql/) | MySQL 8.4 with a seeded `products` table (12 rows) |
| [`pricing-py/`](pricing-py/) | Python FastAPI service, `GET /price/{id}` |
| [`shop-php/`](shop-php/) | PHP 8.3 Slim app, the API behind the storefront: `GET /products`, `GET /products/{id}`, `GET`/`POST /checkout`, `GET /slow` |
| [`recommendations-node/`](recommendations-node/) | Node.js Express service, `GET /recommendations?product={id}` |
| [`inventory-go/`](inventory-go/) | Go service, `GET /stock/{id}` |
| [`payment-java/`](payment-java/) | Java Spring Boot service, `POST /payments`, with a switchable failure rate |
| [`loadgen/`](loadgen/) | curl loop calling the product list, a product page, checkout and `/slow` every 3 seconds |
| [`academy-site/`](academy-site/) | nginx site, 1 replica, mounting the exclusive `uploads` PVC |
| [`uploads-sync/`](uploads-sync/) | CronJob that needs the same PVC, plus `trigger-incident.sh` and `recover.sh` |
| [`shop-web/`](shop-web/) | Storefront (nginx) with the Dash0 Web SDK and Session Replay, proxying `/api` to shop-php |
| [`memory-leak/`](memory-leak/) | Optional: a Deployment that leaks memory until it's OOMKilled. Not deployed by default |
| [`alerts/`](alerts/) | `PrometheusRule` resources that the operator syncs into Dash0 check rules |
| [`synthetics/`](synthetics/) | Optional: Dash0 synthetic checks against the storefront, run from a private location in the cluster |

### Deploy everything

```sh
kubectl apply -f base/00-namespace.yaml
kubectl apply -f base/10-dash0-monitoring.yaml
kubectl wait -n otel-workshop dash0monitoring/dash0-monitoring-resource --for=condition=Available --timeout=60s

kubectl apply -f mysql/
kubectl wait -n otel-workshop deploy/mysql --for=condition=Available --timeout=180s
kubectl apply -f pricing-py/ -f recommendations-node/ -f inventory-go/ -f payment-java/ -f shop-php/
kubectl apply -f loadgen/
kubectl apply -f shop-web/        # set the Dash0 auth token first, see "shop-web" below
kubectl apply -f academy-site/ -f uploads-sync/
kubectl apply -f alerts/
```

Apply the namespace before the monitoring resource. If you apply the whole `base/` folder in one command on a fresh cluster, the monitoring resource can fail with `namespaces "otel-workshop" not found`. Running the command again fixes it.

Deploy the monitoring resource before the apps. The operator instruments workloads when they're created, so this avoids a restart.

### base

The `Dash0Monitoring` resource turns on:

- **Auto-instrumentation** (`instrumentWorkloads.mode: all`). The operator instruments existing workloads, which restarts their pods, and also instruments new and updated workloads. To exclude a workload, give it the label `dash0.com/enable=false`.
- **Pod log collection**, **Prometheus scraping** of pods annotated with `prometheus.io/scrape`, and **Kubernetes event collection**.
- **Syncing** of `PersesDashboard` and `PrometheusRule` resources in this namespace to Dash0 dashboards and check rules.
- **Log trace context** (`transform.log_statements`). The apps log JSON lines that include `trace_id`, `span_id` and `level`. These statements copy those fields into the log record's trace context and severity, so each log line links to its trace in Dash0. Lines that aren't JSON, and Kubernetes events, are left untouched.

To check the status, run `kubectl get dash0monitoring -n otel-workshop`. `AVAILABLE` should be `True`.

### mysql

The `shop` database is seeded from the `mysql-init` ConfigMap. Storage is an `emptyDir`, so deleting the pod gives you a freshly seeded database. The credentials in `00-secret.yaml` are demo-only.

### How the services are instrumented

The services show three ways of getting OpenTelemetry data into Dash0:

**Instrumented by the Dash0 operator, with no OpenTelemetry code or settings.** The operator injects its agent into Java, Node.js and .NET workloads, sets the OTLP endpoint, and takes `service.name` from the `app.kubernetes.io/name` label.

- `payment-java`: Spring Boot 3.5 on Java 21. The operator adds the Java agent through `JAVA_TOOL_OPTIONS`. Logs are Spring Boot's structured JSON (`logging.structured.format.console=logstash`).
- `recommendations-node`: Express 5 and mysql2 on Node.js 22. The operator adds the Dash0 Node.js distribution through `NODE_OPTIONS` (`--require`). The distribution's pino instrumentation adds `trace_id` and `span_id` to the JSON log lines. The service is CommonJS on purpose: `--require` hooks only patch modules loaded with `require()`, so an ES-module version (`import`) loses its express, mysql2 and pino instrumentation, and with it the log correlation.

**OpenTelemetry built into the image, because the operator doesn't instrument the runtime.**

- `shop-php` (PHP 8.3, Apache, Slim 4): the `opentelemetry` extension plus `open-telemetry/sdk`, `exporter-otlp` and the `opentelemetry-auto-slim`, `-pdo` and `-guzzle` packages, loaded by `OTEL_PHP_AUTOLOAD_ENABLED=true`. It adds a manual `shipping.quote` span around the checkout logic, with attribute `order.items`. Feature flags come from the `shop-php-flags` ConfigMap (scenario 6). Logs are JSON on stderr.
- `pricing-py` (Python 3.13, FastAPI): `opentelemetry-distro`, with `opentelemetry-bootstrap` installing the FastAPI and PyMySQL instrumentation, started with `opentelemetry-instrument`. Python injection by the operator is opt-in through a Helm value (`operator.instrumentation.enablePythonAutoInstrumentation`), which these manifests don't assume is enabled. Logs are JSON on stdout.

**OpenTelemetry SDK in code**, because the operator can't instrument Go.

- `inventory-go` (Go 1.26): the OTel Go SDK, `otelhttp` for the server spans and `otelsql` for the database spans. It takes its OTLP endpoint and protocol from the environment variables the operator injects. The operator's injector can't load into a static Go binary, so the manifest supplies what it would otherwise add: `OTEL_SERVICE_NAME`, and `OTEL_RESOURCE_ATTRIBUTES=service.namespace=…` read from the pod's own `app.kubernetes.io/part-of` label through the downward API, the same label the operator uses for the other services. Logs are JSON from `log/slog`, with `trace_id` and `span_id` added by a small handler.

  **Kubernetes attributes for Go.** The operator adds `k8s.*` attributes to the other services through its injector, a preloaded library that doesn't load into a static, libc-free Go binary. For inventory-go, the node collector's `k8s_attributes` processor has to recognise the pod from the connection's source IP instead. That fails when telemetry goes to the collector's host port: on clusters where host-port traffic is source-NATed (k3s with flannel, for example), the collector sees the bridge gateway, not the pod. Install the operator with `operator.collectors.forceUseServiceUrl=true`. The operator then injects the collector's node-local Service URL (`internalTrafficPolicy: Local`) instead of the host port, the pod IP is preserved, and the collector adds the pod, namespace, deployment and node attributes. Restart the workloads afterwards so they pick up the new endpoint.

All services log one JSON object per line with `level`, `message`, `trace_id` and `span_id`, which the transform in `base/` turns into trace-linked log records.

shop-php and pricing-py send traces over OTLP/HTTP to the operator's collector on their own node at `http://$(NODE_IP):40318`. `NODE_IP` comes from `status.hostIP` through the downward API. Port **40318** is the collector's default host port (Helm value `operator.collectors.otlpHttpHostPort`); 4318 is only its container port. If your operator uses a different host port, change it in both manifests.

Because the endpoint is set in those two manifests, the operator doesn't inject its own, and it records a `Warning` event on each of those pods saying so. That's expected. The operator still adds Kubernetes resource attributes such as pod, namespace and node.

`pricing-py` sets `OTEL_INJECTOR_AUTO_INSTRUMENTATION_DISABLED=python`, so turning on the operator's Python injection later won't instrument the service twice.

### shop-web

A small storefront served by nginx: product grid, product pages with recommendations, a cart (kept in `localStorage`), a checkout form and an order confirmation. It's plain JavaScript with client-side routing; the Web SDK records each route change as a page view. The workshop buttons (random checkout, slow query, JavaScript error) are on a separate page at `/lab`, linked from the footer. The Dash0 Web SDK (`@dash0/sdk-web` 0.28.2, script-tag build) runs in the browser with `serviceName: "shop-web"`. The SDK bundles are fetched from npm at image build time and served from the same origin, at `/vendor/`.

- **End-to-end traces:** the page calls shop-php through nginx at `/api/...` → `http://shop-php/...`. Because that's the page's own origin, the SDK adds a `traceparent` header to those requests automatically, without any `propagators` setting. shop-php's spans become children of the browser's request span. nginx isn't traced itself, but its JSON access log records the trace and span IDs from `traceparent`, so `/api` log lines link to the same trace.
- **Session Replay:** turned on by loading `dash0-session-recording.iife.js`. Every input, textarea and select is masked (`maskAllInputs: true`, the default), so the form values show up as asterisks in the replay.
- **Errors:** uncaught errors and unhandled promise rejections are captured by the SDK.
- **CSP:** `script-src 'self'`, `style-src 'self'` and `connect-src 'self' <Dash0 endpoint>`. There are no inline scripts. The SDK settings come from `/dash0-config.js`, which nginx generates from the pod's environment. `blob:` workers aren't allowed, because the recorder only needs one for canvas recording, which is off.

**Set the token before deploying.** The SDK needs an **ingest-only** Dash0 auth token. It's visible to anyone who loads the page, so don't use a token with broader permissions. Either replace `REPLACE_WITH_INGEST_ONLY_TOKEN` in `shop-web/00-dash0-web-secret.yaml`, or create the Secret directly so the token never lands in a file:

```sh
kubectl create secret generic shop-web-dash0 -n otel-workshop \
  --from-literal=DASH0_AUTH_TOKEN=auth_xxx --dry-run=client -o yaml | kubectl apply -f -
kubectl rollout restart -n otel-workshop deploy/shop-web
```

If you create it directly, don't re-apply `shop-web/00-dash0-web-secret.yaml`, because that would put the placeholder back. While the placeholder is in place, the page works but Dash0 rejects the telemetry with `401`, and the browser console shows a warning.

The ingest endpoint is the `DASH0_OTLP_ENDPOINT` env var in `shop-web/10-shop-web.yaml`, without `/v1/...`. It's set to `https://ingress.YOUR_REGION.aws.dash0.com` (see "Configure for your environment"). Keep it in the same organization and region as the operator's export, or frontend and backend telemetry end up in different places. The same value goes into the CSP `connect-src`, and the auth token must come from the same organization.

`DASH0_DATASET` must match the dataset in the operator's export (`kubectl get dash0operatorconfiguration -o jsonpath='{.items[0].spec.exports[0].dash0.dataset}'`). If the two differ, the browser span and the backend spans of a trace land in different datasets. Propagation still works, but in Dash0 the browser trace appears to stop at the browser.

**Open it:**

```sh
kubectl port-forward -n otel-workshop svc/shop-web 8081:80
```

Then browse to <http://localhost:8081>. Use `localhost` rather than another hostname: browsers treat `http://localhost` as a secure context but not other plain-HTTP hosts. `shop-web/optional/ingress.yaml` exposes the page through Traefik instead. It isn't applied by default, because it needs DNS and a TLS secret in `otel-workshop`; the file explains what to set up.

### Building the images

All six services are built from their `image/` folders; no prebuilt images are published. Build for your nodes' CPU architecture (`kubectl get nodes -o jsonpath='{.items[*].status.nodeInfo.architecture}'`), here `amd64`, and push to your registry. Build from a clean checkout, so the commit you pass in is the code in the image:

```sh
REV=$(git rev-parse HEAD)
REPO=https://github.com/your-org/otel-workshop   # your copy of this repository

docker buildx build --platform linux/amd64 --build-arg VCS_REVISION=$REV --build-arg VCS_REPOSITORY_URL=$REPO -t REGISTRY/otel-workshop/shop-php:0.3.2 --push shop-php/image
docker buildx build --platform linux/amd64 --build-arg VCS_REVISION=$REV --build-arg VCS_REPOSITORY_URL=$REPO -t REGISTRY/otel-workshop/pricing-py:0.1.1 --push pricing-py/image
docker buildx build --platform linux/amd64 --build-arg VCS_REVISION=$REV --build-arg VCS_REPOSITORY_URL=$REPO -t REGISTRY/otel-workshop/recommendations-node:0.1.2 --push recommendations-node/image
docker buildx build --platform linux/amd64 --build-arg VCS_REVISION=$REV --build-arg VCS_REPOSITORY_URL=$REPO -t REGISTRY/otel-workshop/inventory-go:0.1.3 --push inventory-go/image
docker buildx build --platform linux/amd64 --build-arg VCS_REVISION=$REV --build-arg VCS_REPOSITORY_URL=$REPO -t REGISTRY/otel-workshop/payment-java:0.1.1 --push payment-java/image
docker buildx build --platform linux/amd64 --build-arg VCS_REVISION=$REV --build-arg VCS_REPOSITORY_URL=$REPO -t REGISTRY/otel-workshop/shop-web:0.2.2 --push shop-web/image
```

**Version-control attributes.** The two build args end up in the telemetry, so every span, log and metric says which commit and repository it came from:

- shop-php, pricing-py, recommendations-node and payment-java set `OTEL_RESOURCE_ATTRIBUTES=vcs.ref.head.revision=<commit>,vcs.repository.url.full=<repo>` in the image. Every OpenTelemetry SDK reads that variable, including the Java and Node.js agents the Dash0 operator injects. The operator appends its own `k8s.*` and `service.*` attributes to the variable rather than replacing it. Don't set `OTEL_RESOURCE_ATTRIBUTES` in those manifests: a container env var replaces the image's value instead of merging with it.
- inventory-go compiles the values into the binary (`go build -ldflags -X`) and adds them in code, because its manifest needs `OTEL_RESOURCE_ATTRIBUTES` for `service.namespace` (see "How the services are instrumented").
- shop-web passes the same values to the browser SDK as `additionalSignalAttributes`. In the browser they're attributes on each signal, because the Web SDK doesn't take custom resource attributes.
- The images also get the standard `org.opencontainers.image.revision` and `org.opencontainers.image.source` labels.

If you leave out the build args, the attributes say `unknown`.

The Go and Java images compile on your machine's own architecture and only the final stage targets the nodes', so cross-building is quick. The PHP image compiles the `opentelemetry` extension under emulation and takes a few minutes. If you change a tag, update the `image:` field in the matching `10-*.yaml` manifest.

## Scenarios

To call the shop yourself, port-forward it:

```sh
kubectl port-forward -n otel-workshop svc/shop-php 8080:80
```

The load generator keeps traffic flowing in the background. To pause it, run `kubectl scale -n otel-workshop deploy/loadgen --replicas=0`; to resume, set it back to `1`.

### 1. One checkout trace across four languages

**Trigger:** `curl localhost:8080/checkout`, which checks out a random cart. The load generator also calls it every few seconds, and the storefront's **Place order** button posts the real cart to `POST /checkout`.

**What to show in Dash0:** open a trace for `GET /checkout` from service `shop-php`. The span tree is:

```
GET /checkout                              shop-php       (server)
└─ {closure}                               shop-php       (Slim route)
   ├─ PDO::query / fetchAll                shop-php       (picks 1–4 random products)
   ├─ shipping.quote                       shop-php       (manual span, order.items = 1..4)
   │  ├─ GET (per item)                    shop-php       (Guzzle client)
   │  │  └─ GET /stock/{id}                inventory-go   (server, OTel Go SDK)
   │  │     └─ sql.conn.query …            inventory-go   (otelsql)
   │  └─ GET (per item)                    shop-php       (Guzzle client)
   │     └─ GET /price/{product_id}        pricing-py     (server)
   │        └─ SELECT                      pricing-py     (PyMySQL)
   └─ POST                                 shop-php       (Guzzle client)
      └─ POST /payments                    payment-java   (server, operator-injected Java agent)
```

Points to make: the W3C `traceparent` header carries the context across every hop, whichever way each service is instrumented. The manual `shipping.quote` span sits naturally between the automatic spans. Filter on `order.items` to compare large and small orders.

Product pages add a fifth language: `GET /products/{id}` on shop-php calls `GET /recommendations` on `recommendations-node`, which queries MySQL through mysql2. The load generator opens a random product page each round.

### 2. Slow database query

**Trigger:** `curl localhost:8080/slow`. It takes about 2 seconds.

**What to show in Dash0:** the `GET /slow` trace is dominated by a single `PDO::query` span with `db.query.text = SELECT SLEEP(2) AS slept`. Compare `shop-php` latency per route: `/slow` sits at about 2 s, while `/products` and `/checkout` take a fraction of a second.

### 3. Logs correlated with traces

**Trigger:** any request.

**What to show in Dash0:** open the `GET /checkout` trace and go to its logs. You'll see lines from four services with the same trace ID: `order placed` from `shop-php`, `checked stock` from `inventory-go` and `priced product` from `pricing-py` for each item, and `payment authorized` from `payment-java`. The `/slow` route logs `slow query finished` at `WARNING` severity.

To see the raw lines:

```sh
kubectl logs -n otel-workshop deploy/shop-php --tail=5
kubectl logs -n otel-workshop deploy/payment-java --tail=5
```

### 4. Sync job stuck behind an exclusive volume

The incident: `academy-site` runs as a single replica that holds the `uploads` volume. The nightly `uploads-sync` CronJob needs the same volume, so its pod can't start and stays Pending. The fix at the time was to take the site down so the job could run, which caused an outage.

**Trigger:**

```sh
./uploads-sync/trigger-incident.sh
```

This creates a job from the CronJob (`kubectl create job --from=cronjob/uploads-sync ...`). The job's pod stays `Pending` with a warning event:

```
FailedScheduling  0/1 nodes are available: 1 node(s) unavailable due to PersistentVolumeClaim
                  with ReadWriteOncePod access mode already in-use by another pod. ...
```

**What to show in Dash0:** Kubernetes events from monitored namespaces arrive as log records, so this warning appears in the logs. Filter on namespace `otel-workshop` and on Kubernetes events (`otel.event.name = k8s.event`), and look at the `FailedScheduling` warning for the `uploads-sync-manual-…` pod. The job also stays incomplete and the pod stays Pending, which you can show from the workload or pod views.

**Recover:**

```sh
./uploads-sync/recover.sh
```

This scales `academy-site` to 0, waits for the job to finish (about 90 seconds), then scales the site back to 1. The site is down for that whole window. In Dash0 this shows as `Killing` and `ScalingReplicaSet` events for `academy-site`, followed by the job's pod being scheduled and completing.

**Alerts:** with `alerts/20-job-alerts-demo.yaml` applied, the check rule `otel-workshop jobs (demo) - JobPodPending` fires one to two minutes after the trigger. That's the 1-minute grace period plus the 30-second metric collection and the 1-minute evaluation interval. The affected resource is the stuck pod. The production rules in `alerts/10-job-alerts.yaml` fire after 10 minutes (`JobPodPending`) and 15 minutes (`CronJobRunNotCompleted`). All of them resolve once `recover.sh` lets the job run.

If nobody runs `recover.sh`, the job gives up after 30 minutes (`activeDeadlineSeconds: 1800`). This has to stay above the 15-minute alert threshold, or the job disappears before that alert can fire. Because the CronJob has `concurrencyPolicy: Forbid`, a stuck run also blocks the next scheduled one. The schedule is `0 2 * * *` (UTC).

#### Why this is not a real Multi-Attach error

The original incident showed `Multi-Attach error` / `FailedAttachVolume`. Many workshop clusters can't reproduce that. The reference setup, a single-node k3s cluster with `local-path` storage, fails on both counts:

- With a single node, the job can't be placed on a different node from the site.
- Node-local storage like `local-path` has no attach step. Without one, Kubernetes never reports Multi-Attach, and an RWO volume can be shared by pods on the same node, so the job would simply run.

The `uploads` claim therefore uses `ReadWriteOncePod`. Kubernetes documents it as supported for CSI volumes, and it also works with k3s `local-path` (tested). The claim uses your cluster's default storage class. With that access mode, the scheduler refuses a second pod while the first one holds the claim. The symptom and the fix are the same as in the incident (pod Pending, warning event, recovered by scaling the site down), but the event is `FailedScheduling`, not `FailedAttachVolume`.

To reproduce the exact Multi-Attach error you need at least two nodes and attachable block storage, for example a managed cluster (EKS with EBS, GKE with Persistent Disk, AKS with Azure Disk) or a multi-node k3s cluster with Longhorn. Then:

1. In `academy-site/00-pvc-uploads.yaml`, set `accessModes: [ReadWriteOnce]` and set `storageClassName` to the attachable class.
2. Leave the job's `podAntiAffinity` in place. It already prefers a node other than the one running `academy-site`. If the scheduler still co-locates them, change it to `requiredDuringSchedulingIgnoredDuringExecution`.

The job pod then lands on the other node and stays in `ContainerCreating` with `FailedAttachVolume: Multi-Attach error for volume ... Volume is already used by pod(s) academy-site-...`. `recover.sh` works unchanged, because a pod in `ContainerCreating` still has phase `Pending`.

### 5. A shopper's journey, with Session Replay

**Trigger:** open <http://localhost:8081> (see "shop-web" above). Open a product, add it to the cart, go to the cart, check out with any made-up details, and click **Place order**. Then open **Workshop lab** in the footer and click **Slow query** and **Throw a JavaScript error**.

**What to show in Dash0:**
- **Website monitoring for `shop-web`:** the session, with a page view per route (home, product, cart, checkout, order confirmation, lab), the `fetch` requests, and the JavaScript error `Demo error: shipping estimate widget failed to render`.
- **The `POST /api/checkout` request span:** open its trace. The browser span is the root, and the full shop-php → inventory-go / pricing-py / payment-java tree from scenario 1 hangs below it. The product page's `GET /api/products/{id}` continues into `recommendations-node`. `/api/slow` shows the 2-second `SELECT SLEEP(2)` span under the browser request.
- **Session Replay for the session:** the whole journey plays back, with every typed value (name, email, address, card number, expiry, CVC) masked.
- **Logs:** the shop-web access log line for each `/api` call carries the same trace ID.

### 6. Slow checkout (optional)

A flag makes every `/checkout` run the same 2-second query as `/slow` (`SELECT SLEEP(2)`), inside the `shipping.quote` span. Checkout latency jumps from under 0.2 s to over 2 s.

**Trigger:**

```sh
./shop-php/slow-checkout.sh on
```

The script sets `CHECKOUT_SLOW_QUERY: "true"` in the `shop-php-flags` ConfigMap and restarts `shop-php`, because environment variables are only read when the container starts. The restart takes a few seconds. A `preStop` delay on the pod means the load generator doesn't see failed requests during the switch.

**What to show in Dash0:**
- Latency for `GET /checkout` on `shop-php` rises to about 2.1 s, while the error rate stays flat.
- In a checkout trace, under `shipping.quote`, there's a `PDO::query` span of about 2 s with `db.query.text = SELECT SLEEP(2) AS slept`, after the calls to `pricing-py`.
- Each slow checkout logs `checkout ran slow query` at `WARNING`, linked to its trace.
- The restart itself shows up as `Killing` and `Scheduled` events for `shop-php` around the time latency changes.

**Reset:**

```sh
./shop-php/slow-checkout.sh off
```

Re-applying `shop-php/` also resets the flag to `"false"`.

### 7. OOMKilled crash loop (optional)

A small Python container appends 2 MiB to a list every second and never frees it. Its memory limit is 96Mi, so after about 40 seconds the kernel kills it (`OOMKilled`, exit code 137). Kubernetes restarts it, it leaks again, and the restart delay grows until the pod shows `CrashLoopBackOff`.

**Trigger:**

```sh
./memory-leak/oom-crashloop.sh on
kubectl get pods -n otel-workshop -l app.kubernetes.io/name=memory-leak -w
```

**What to show in Dash0:**
- The `memory-leak` workload's memory usage climbs in a sawtooth toward the 96Mi limit, drops at each kill, and climbs again.
- The container restart count goes up, and the container's last termination reason is `OOMKilled`.
- `BackOff` warning events (`Back-off restarting failed container leaker ...`) appear in the logs as Kubernetes events.
- The container's own logs show `leaked_mib` rising to about 86 before each kill.

**Reset:**

```sh
./memory-leak/oom-crashloop.sh off
```

This deletes the Deployment. The scenario is not part of "Deploy everything", so it only runs while you have it switched on.

### 8. Failing payments (optional)

`payment-java` fails a share of payments with `payment provider timed out` (HTTP 502). The rate comes from the `payment-java-flags` ConfigMap.

**Trigger:**

```sh
./payment-java/payment-failures.sh on        # 30% of payments fail
./payment-java/payment-failures.sh on 1.0    # every payment fails
```

The script sets `PAYMENT_FAILURE_RATE` and restarts `payment-java`, which takes about 15 seconds because of JVM start-up. For a few seconds after that, the old pod finishes its in-flight requests, so the new rate takes full effect shortly after the script returns.

**What to show in Dash0:**
- The error rate of `payment-java` and of `shop-php`'s checkout route rises, while the other services stay healthy. The trace shows where it started: the failing `POST /payments` span in `payment-java`, under shop-php's outgoing `POST` call.
- `payment failed: payment provider timed out` (`ERROR`) from payment-java and `payment failed` (`ERROR`) from shop-php share one trace ID.
- In the storefront, **Place order** shows "We couldn't place your order: payment failed, please try again" and keeps the cart. In Session Replay you can watch the shopper hit the error.

**Reset:**

```sh
./payment-java/payment-failures.sh off
```

## Synthetic checks

[`synthetics/10-storefront-checks.yaml`](synthetics/10-storefront-checks.yaml) defines three Dash0 synthetic checks, each running every minute. The operator syncs them into Dash0 (folder `/otel-workshop`).

| Check | Request | Degraded above | Critical |
| --- | --- | --- | --- |
| Storefront: home page | `GET /` | 1 s | not 200, or above 3 s |
| Storefront: product catalogue API | `GET /api/products` | 1 s | not 200, or above 3 s |
| Storefront: synthetic checkout | `GET /api/checkout` (random cart, full inventory → pricing → payment path) | 2 s | not 200, or above 5 s |

Every run sends a `traceparent` header (`addTracingHeaders: true`), so each check result links to the trace it started in shop-web and the backend services. The checkout check also fails during scenario 8 (failing payments), which makes it a good way to show a synthetic catching a backend problem.

The checks target the storefront's in-cluster address, `http://shop-web.otel-workshop.svc.cluster.local`. Dash0's public locations can't reach that, so the checks run from a **private location**: a Dash0 synthetics worker that runs inside the cluster and only connects outbound to Dash0. This needs Dash0 operator 0.156.0 or later.

**1. Enable the synthetics worker in the operator's Helm values:**

```
operator.syntheticsWorker.enabled=true
operator.syntheticsWorker.serverAddress=<Outbound Connector endpoint, host:port>
```

You'll find the Outbound Connector endpoint in Dash0 under Settings → Endpoints → Outbound Connector, for example `outbound-connector.eu-west-1.aws.dash0.com:443`.

**2. Add a worker instance to the operator configuration.** The cluster allows only one `Dash0OperatorConfiguration`, so add a `spec.syntheticsWorker.instances` entry to the one you have (`kubectl edit dash0operatorconfiguration`):

```yaml
spec:
  syntheticsWorker:
    instances:
      - locationId: dc-example-1          # how the location appears in Dash0
        authorization:
          secretRef:
            name: dash0-authorization-secret   # a secret in the operator's namespace
            key: token
        replicas: 2
```

Once the worker is up, the operator deploys `dash0-operator-synthetics-worker-<locationId>` in its namespace and reports `ready` per instance under `status.syntheticsWorker`. The location appears in Dash0 when its worker connects; you don't create it in the UI. The `locationId` is permanent in your Dash0 organization and can't be removed or reused, so choose it deliberately.

On the reference cluster (operator 0.159.0) this works with the operator configuration that Helm creates (`operator.dash0Export.enabled=true`). Dash0's synthetics-worker docs say a manually managed configuration is required, so if the instance disappears after the operator restarts, install with `operator.dash0Export.enabled=false` and manage the configuration yourself; [`synthetics/private-location/operator-configuration.example.yaml`](synthetics/private-location/operator-configuration.example.yaml) is a starting point.

**3. Deploy the checks.** Replace `YOUR_LOCATION_ID` in `synthetics/10-storefront-checks.yaml` with the same location ID, then:

```sh
kubectl apply -f synthetics/
kubectl get dash0syntheticchecks -n otel-workshop
```

Each check reports its sync result in its own status (`kubectl describe dash0syntheticcheck -n otel-workshop storefront-home`). The checks have no notification channels; add channel IDs under `spec.notifications.channels` if you want alerts.

## Alerts

The Dash0 operator turns `PrometheusRule` resources into Dash0 check rules for every namespace with a `Dash0Monitoring` resource. This namespace has `synchronizePrometheusRules: true`, which is also the default. The `PrometheusRule` CRD is already installed on this cluster. Each check rule is named `<group name> - <alert>`.

| Rule | Fires when | File |
| --- | --- | --- |
| `otel-workshop jobs - JobPodPending` | A pod owned by a Job in `otel-workshop` has been Pending for 10 minutes | `10-job-alerts.yaml` |
| `otel-workshop jobs - CronJobRunNotCompleted` | An `uploads-sync` run still has active pods 15 minutes after it started | `10-job-alerts.yaml` |
| `otel-workshop jobs (demo) - JobPodPending` | Same as `JobPodPending`, after 1 minute | `20-job-alerts-demo.yaml` |

The queries use Dash0's metric naming: the metric is selected with `{otel_metric_name="k8s.pod.phase", otel_metric_type="gauge"}`, and dots in attribute names become underscores (`k8s.job.name` → `k8s_job_name`). `k8s.pod.phase` comes from the operator's `k8s_cluster` receiver, where `1` means Pending. Pod metrics get `k8s_job_name` from the operator's `k8s_attributes` processor, so `k8s_job_name!=""` restricts the rule to pods owned by a Job.

**Limits of `CronJobRunNotCompleted`.** `k8s_cluster` has no metric for a CronJob's last schedule time, so the rule measures time since the Job started. A CronJob creates its Job at the scheduled time, so for scheduled runs this is effectively the same thing. The rule uses `k8s.job.active_pods`, which counts Pending and Running pods, rather than `k8s.cronjob.active_jobs`, because the CronJob doesn't count jobs created with `kubectl create job --from=cronjob/...` as active. It matches jobs by name (`uploads-sync-.+`), and it does not detect runs that never started at all.

To check that the rules synced:

```sh
kubectl get dash0monitoring -n otel-workshop dash0-monitoring-resource -o jsonpath='{.status.prometheusRuleSynchronizationResults}'
```

Each `PrometheusRule` should show `"synchronizationStatus":"successful"` and `"invalidRulesTotal":0`. After the workshop, run `kubectl delete -f alerts/20-job-alerts-demo.yaml`; the operator then deletes that check rule from Dash0.

## Teardown

```sh
kubectl delete -f alerts/
kubectl delete -f synthetics/ --ignore-not-found
kubectl delete -f memory-leak/ --ignore-not-found
kubectl delete -f shop-web/ -f shop-web/optional/ --ignore-not-found
kubectl delete -f uploads-sync/ -f academy-site/
kubectl delete -f loadgen/ -f shop-php/ -f payment-java/ -f inventory-go/ -f recommendations-node/ -f pricing-py/ -f mysql/
kubectl delete -f base/10-dash0-monitoring.yaml   # lets the operator remove instrumentation cleanly
kubectl delete -f base/00-namespace.yaml
```

Delete the monitoring resource before the namespace. If the namespace is deleted first, the operator's finalizer on the monitoring resource can leave the namespace stuck in `Terminating`.
