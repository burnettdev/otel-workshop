#!/usr/bin/env bash
# Turns the CPU-starvation scenario on or off: pricing-py gets a 50m CPU limit, so the kernel throttles it.
# Usage: ./cpu-starvation.sh on|off
set -euo pipefail

NS=otel-workshop
case "${1:-}" in
  on)  cpu='"50m"' ;;
  off) cpu=null ;;
  *)   echo "usage: $0 on|off" >&2; exit 1 ;;
esac

# A strategic merge patch changes only this container's CPU limit; null removes it. Changing the pod template
# rolls out a new pod, like a real limit change would.
kubectl patch deployment -n "$NS" pricing-py --type strategic \
  -p "{\"spec\":{\"template\":{\"spec\":{\"containers\":[{\"name\":\"pricing-py\",\"resources\":{\"limits\":{\"cpu\":$cpu}}}]}}}}"
kubectl rollout status -n "$NS" deploy/pricing-py --timeout=120s
echo "CPU starvation is $1 (pricing-py CPU limit: $cpu)."
