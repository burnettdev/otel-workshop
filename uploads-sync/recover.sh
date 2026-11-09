#!/usr/bin/env bash
# Recovers the way the incident was resolved: take academy-site down so the stuck uploads-sync job
# can mount the volume, wait for the job to finish, then bring the site back.
# The site is unavailable for the duration of the sync (~90 s).
set -euo pipefail

NS=otel-workshop

job=$(kubectl get pods -n "$NS" -l app.kubernetes.io/name=uploads-sync --field-selector status.phase=Pending \
  -o jsonpath='{.items[0].metadata.labels.job-name}' 2>/dev/null || true)
if [ -z "$job" ]; then
  echo "No Pending uploads-sync pod found. Run ./trigger-incident.sh first." >&2
  exit 1
fi
echo "Stuck job: $job"

echo "$(date -u +%H:%M:%S) Scaling academy-site to 0 (site goes down)"
kubectl scale -n "$NS" deploy/academy-site --replicas=0
kubectl wait -n "$NS" pod -l app.kubernetes.io/name=academy-site --for=delete --timeout=120s

echo "$(date -u +%H:%M:%S) Volume released, waiting for $job to finish"
kubectl wait -n "$NS" "job/$job" --for=condition=Complete --timeout=600s
kubectl logs -n "$NS" "job/$job" --tail=5

echo "$(date -u +%H:%M:%S) Scaling academy-site back to 1"
kubectl scale -n "$NS" deploy/academy-site --replicas=1
kubectl rollout status -n "$NS" deploy/academy-site --timeout=180s
echo "$(date -u +%H:%M:%S) Recovered"
