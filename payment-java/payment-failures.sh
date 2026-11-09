#!/usr/bin/env bash
# Turns payment failures on or off. "on" fails 30% of payments by default; pass a rate from 0.0 to 1.0
# to change that.
# Usage: ./payment-failures.sh on [rate] | off
set -euo pipefail

NS=otel-workshop
case "${1:-}" in
  on)  rate="${2:-0.3}" ;;
  off) rate=0 ;;
  *)   echo "usage: $0 on [rate] | off" >&2; exit 1 ;;
esac

kubectl patch configmap -n "$NS" payment-java-flags --type merge -p "{\"data\":{\"PAYMENT_FAILURE_RATE\":\"$rate\"}}"
# Environment variables are read at container start, so restart to pick up the new value.
kubectl rollout restart -n "$NS" deploy/payment-java
kubectl rollout status -n "$NS" deploy/payment-java --timeout=180s
echo "Payment failure rate is now $rate."
