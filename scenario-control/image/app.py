"""scenario-control: a web page that switches the workshop scenarios on and off.

It does what the scripts in each scenario's folder do (slow-checkout.sh, payment-failures.sh, oom-crashloop.sh,
trigger-incident.sh, recover.sh), through the Kubernetes API with the pod's service account. Standard library
only. Served under /flags, the path the Ingress routes here.
"""

import html
import json
import signal
import ssl
import sys
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

SA_DIR = "/var/run/secrets/kubernetes.io/serviceaccount"
API = "https://kubernetes.default.svc"
NS = open(f"{SA_DIR}/namespace").read().strip()
SSL_CONTEXT = ssl.create_default_context(cafile=f"{SA_DIR}/ca.crt")
BASE = "/flags"
PAYMENT_FAILURE_RATE_ON = "0.3"


def log(level, message, **attrs):
    print(json.dumps({"time": datetime.now(timezone.utc).isoformat(), "level": level, "service": "scenario-control",
                      "message": message, **attrs}), flush=True)


def k8s(method, path, body=None, content_type="application/json"):
    # The token is re-read on every call because Kubernetes rotates projected service account tokens.
    token = open(f"{SA_DIR}/token").read().strip()
    request = urllib.request.Request(API + path, method=method,
                                     data=json.dumps(body).encode() if body is not None else None)
    request.add_header("Authorization", f"Bearer {token}")
    request.add_header("Content-Type", content_type)
    with urllib.request.urlopen(request, context=SSL_CONTEXT, timeout=10) as response:
        return json.load(response)


def merge_patch(path, body):
    return k8s("PATCH", path, body, "application/merge-patch+json")


def deployment_path(name):
    return f"/apis/apps/v1/namespaces/{NS}/deployments/{name}"


def configmap_value(name, key):
    return k8s("GET", f"/api/v1/namespaces/{NS}/configmaps/{name}")["data"].get(key, "")


def set_flag_and_restart(configmap, key, value, deployment):
    """Sets a flag and restarts the deployment that reads it, like `kubectl rollout restart`: the flags are
    environment variables, so they're only read when the container starts."""
    merge_patch(f"/api/v1/namespaces/{NS}/configmaps/{configmap}", {"data": {key: value}})
    restarted_at = datetime.now(timezone.utc).isoformat()
    merge_patch(deployment_path(deployment), {"spec": {"template": {"metadata": {"annotations": {
        "kubectl.kubernetes.io/restartedAt": restarted_at}}}}})


def scale(deployment, replicas):
    merge_patch(deployment_path(deployment), {"spec": {"replicas": replicas}})


def rolling_out(deployment):
    d = k8s("GET", deployment_path(deployment))
    want, status = d["spec"]["replicas"], d.get("status", {})
    return (status.get("observedGeneration", 0) < d["metadata"]["generation"]
            or status.get("updatedReplicas", 0) < want
            or status.get("replicas", 0) != want
            or status.get("availableReplicas", 0) < want)


def pending_sync_jobs():
    pods = k8s("GET", f"/api/v1/namespaces/{NS}/pods?labelSelector=app.kubernetes.io/name%3Duploads-sync"
                      "&fieldSelector=status.phase%3DPending")["items"]
    return sorted({p["metadata"]["labels"]["job-name"] for p in pods})


def trigger_sync_job():
    """Like `kubectl create job --from=cronjob/uploads-sync`."""
    cronjob = k8s("GET", f"/apis/batch/v1/namespaces/{NS}/cronjobs/uploads-sync")
    template = cronjob["spec"]["jobTemplate"]
    name = f"uploads-sync-manual-{int(time.time())}"
    k8s("POST", f"/apis/batch/v1/namespaces/{NS}/jobs", {
        "apiVersion": "batch/v1",
        "kind": "Job",
        "metadata": {
            "name": name,
            "labels": template.get("metadata", {}).get("labels", {}),
            "annotations": {"cronjob.kubernetes.io/instantiate": "manual"},
            "ownerReferences": [{"apiVersion": "batch/v1", "kind": "CronJob", "name": "uploads-sync",
                                 "uid": cronjob["metadata"]["uid"], "controller": True}],
        },
        "spec": template["spec"],
    })
    return name


# The stuck-job recovery takes a couple of minutes, so it runs in the background; recovery_step is shown on the page.
recovery_lock = threading.Lock()
recovery_step = ""


def recover_sync_job(job):
    """Like recover.sh: take academy-site down so the job can mount the volume, wait for the job, bring the site back."""
    global recovery_step
    try:
        recovery_step = "Scaling academy-site to 0 (site goes down)"
        log("INFO", "stuck job recovery started", **{"k8s.job.name": job})
        scale("academy-site", 0)
        deadline = time.time() + 600
        recovery_step = f"Volume released, waiting for {job} to finish"
        while time.time() < deadline:
            status = k8s("GET", f"/apis/batch/v1/namespaces/{NS}/jobs/{job}").get("status", {})
            if status.get("succeeded") or status.get("failed"):
                break
            time.sleep(3)
        recovery_step = "Scaling academy-site back to 1"
        scale("academy-site", 1)
        log("INFO", "stuck job recovery finished", **{"k8s.job.name": job})
    except Exception as e:
        log("ERROR", "stuck job recovery failed", **{"k8s.job.name": job, "error": str(e)})
        scale("academy-site", 1)
    finally:
        recovery_step = ""
        recovery_lock.release()


def scenarios():
    """Current state of each scenario, as (id, title, description, state, is_on, actions)."""
    slow = configmap_value("shop-php-flags", "CHECKOUT_SLOW_QUERY") == "true"
    rate = configmap_value("payment-java-flags", "PAYMENT_FAILURE_RATE") or "0"
    leak = k8s("GET", deployment_path("memory-leak"))["spec"]["replicas"] > 0
    stuck = pending_sync_jobs()

    def restarting(deployment):
        return " (restarting " + deployment + ")" if rolling_out(deployment) else ""

    if recovery_step:
        sync_state, sync_actions = "Recovering: " + recovery_step, []
    elif stuck:
        sync_state, sync_actions = "Stuck: " + ", ".join(stuck) + " is Pending", [("recover", "Recover")]
    else:
        sync_state, sync_actions = "Off", [("trigger", "Trigger")]
    return [
        ("slow-checkout", "Slow checkout",
         "Every checkout runs a 2-second SQL query inside shipping.quote. Alert: CheckoutLatencyHigh.",
         ("On" if slow else "Off") + restarting("shop-php"), slow, [("off", "Turn off")] if slow else [("on", "Turn on")]),
        ("payment-failures", "Failing payments",
         f"payment-java fails {float(PAYMENT_FAILURE_RATE_ON):.0%} of payments with HTTP 502.",
         (f"On ({float(rate):.0%})" if float(rate) > 0 else "Off") + restarting("payment-java"), float(rate) > 0,
         [("off", "Turn off")] if float(rate) > 0 else [("on", "Turn on")]),
        ("oom-crashloop", "OOMKilled crash loop",
         "memory-leak leaks 2 MiB/s against a 96Mi limit and crash loops. Alert: ContainerCrashLooping.",
         "On" if leak else "Off", leak, [("off", "Turn off")] if leak else [("on", "Turn on")]),
        ("stuck-sync-job", "Sync job stuck behind a volume",
         "An uploads-sync run waits for the volume academy-site holds. Recover takes the site down for ~90 s. "
         "Alert: JobPodPending.",
         sync_state, bool(stuck) or bool(recovery_step), sync_actions),
    ]


def act(scenario, action):
    if scenario == "slow-checkout" and action in ("on", "off"):
        set_flag_and_restart("shop-php-flags", "CHECKOUT_SLOW_QUERY", "true" if action == "on" else "false", "shop-php")
    elif scenario == "payment-failures" and action in ("on", "off"):
        set_flag_and_restart("payment-java-flags", "PAYMENT_FAILURE_RATE",
                             PAYMENT_FAILURE_RATE_ON if action == "on" else "0", "payment-java")
    elif scenario == "oom-crashloop" and action in ("on", "off"):
        scale("memory-leak", 1 if action == "on" else 0)
    elif scenario == "stuck-sync-job" and action == "trigger":
        if pending_sync_jobs():
            return
        trigger_sync_job()
    elif scenario == "stuck-sync-job" and action == "recover":
        jobs = pending_sync_jobs()
        if not jobs or not recovery_lock.acquire(blocking=False):
            return
        threading.Thread(target=recover_sync_job, args=(jobs[0],), daemon=True).start()
    else:
        raise LookupError(f"unknown action {scenario}/{action}")
    log("INFO", f"scenario {scenario}: {action}", **{"scenario.name": scenario, "scenario.action": action})


STYLE = """
body { font-family: system-ui, sans-serif; margin: 0 auto; max-width: 760px; padding: 16px; background: #f6f7f9; color: #1d2330; }
h1 { font-size: 1.4rem; margin: 8px 0 4px; } p.sub { margin: 0 0 16px; color: #5b6475; }
.card { background: #fff; border: 1px solid #dde1e8; border-radius: 10px; padding: 14px 16px; margin-bottom: 12px;
        display: flex; gap: 16px; align-items: center; justify-content: space-between; }
.card h2 { font-size: 1.05rem; margin: 0 0 4px; } .card p { margin: 0 0 6px; color: #5b6475; font-size: .9rem; }
.state { font-weight: 600; font-size: .9rem; } .on .state { color: #b4231b; } .off .state { color: #2f7d32; }
button { font: inherit; padding: 8px 14px; border-radius: 8px; border: 1px solid #1d2330; background: #1d2330; color: #fff; cursor: pointer; white-space: nowrap; }
.on button { background: #fff; color: #1d2330; } .error { background: #fde8e7; border-color: #f2b8b5; }
"""


def page(error=""):
    cards = []
    for sid, title, description, state, is_on, actions in scenarios():
        buttons = "".join(f'<form method="post" action="{BASE}/{sid}/{a}"><button>{html.escape(label)}</button></form>'
                          for a, label in actions)
        cards.append(f'<div class="card {"on" if is_on else "off"}"><div><h2>{html.escape(title)}</h2>'
                     f'<p>{html.escape(description)}</p><span class="state">{html.escape(state)}</span></div>'
                     f'{buttons}</div>')
    error_html = f'<div class="card error">{html.escape(error)}</div>' if error else ""
    return f"""<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="refresh" content="5">
<title>Workshop scenarios</title><style>{STYLE}</style></head><body>
<h1>Workshop scenarios</h1><p class="sub">Namespace {html.escape(NS)}. Refreshes every 5 seconds.</p>
{error_html}{"".join(cards)}</body></html>"""


class Handler(BaseHTTPRequestHandler):
    def send(self, status, body, content_type="text/html; charset=utf-8", headers=()):
        data = body.encode()
        try:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            for name, value in headers:
                self.send_header(name, value)
            self.end_headers()
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass  # The browser navigated away mid-response; nothing to report.

    def do_GET(self):
        if self.path == "/healthz":
            return self.send(200, "ok", "text/plain")
        if self.path.rstrip("/") != BASE:
            return self.send(404, "not found", "text/plain")
        try:
            self.send(200, page())
        except Exception as e:
            log("ERROR", "reading scenario state failed", error=str(e))
            self.send(500, f"reading scenario state failed: {e}", "text/plain")

    def do_POST(self):
        parts = self.path.removeprefix(BASE + "/").split("/")
        if not self.path.startswith(BASE + "/") or len(parts) != 2:
            return self.send(404, "not found", "text/plain")
        try:
            act(*parts)
        except LookupError as e:
            return self.send(404, str(e), "text/plain")
        except (urllib.error.URLError, KeyError) as e:
            log("ERROR", "scenario change failed", **{"scenario.name": parts[0], "scenario.action": parts[1], "error": str(e)})
            return self.send(502, page(f"{parts[0]}/{parts[1]} failed: {e}"))
        # Post/Redirect/Get, so refreshing the page doesn't repeat the action.
        self.send(303, "", headers=[("Location", BASE + "/")])

    def log_message(self, format, *args):
        pass  # The page refreshes every 5 seconds; access logs would only be noise.


if __name__ == "__main__":
    # As PID 1, Python ignores SIGTERM unless it installs a handler, so pods would wait out the grace period.
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    log("INFO", "listening", port=8080)
    ThreadingHTTPServer(("", 8080), Handler).serve_forever()
