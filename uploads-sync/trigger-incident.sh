#!/usr/bin/env bash
# Starts an on-demand run of the uploads-sync CronJob while academy-site holds the uploads volume.
# The job's pod stays Pending until the volume is released (see recover.sh).
set -euo pipefail

NS=otel-workshop
JOB="uploads-sync-manual-$(date +%s)"

kubectl create job -n "$NS" --from=cronjob/uploads-sync "$JOB"

echo "Waiting for the pod of $JOB to be scheduled..."
for _ in $(seq 1 15); do
  sleep 2
  reason=$(kubectl get events -n "$NS" --field-selector type=Warning \
    -o jsonpath="{range .items[?(@.involvedObject.name)]}{.involvedObject.name} {.reason}{'\n'}{end}" \
    | awk -v job="$JOB" 'index($1, job) == 1 { print $2 }' | tail -1)
  [ -n "$reason" ] && break
done

kubectl get pods -n "$NS" -l job-name="$JOB"
echo
kubectl get events -n "$NS" --field-selector type=Warning --sort-by=.lastTimestamp \
  -o custom-columns=OBJECT:.involvedObject.name,REASON:.reason,MESSAGE:.message | grep -E "^OBJECT|^$JOB" || true
echo
echo "Incident running. Run ./recover.sh to take academy-site down so the job can finish."
