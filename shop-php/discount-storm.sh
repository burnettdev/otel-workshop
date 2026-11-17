#!/usr/bin/env bash
# Turns the discount-query-storm scenario on or off: checkout runs one discount query per active code (N+1).
# Usage: ./discount-storm.sh on|off
set -euo pipefail

NS=otel-workshop
case "${1:-}" in
  on)  value=true ;;
  off) value=false ;;
  *)   echo "usage: $0 on|off" >&2; exit 1 ;;
esac

kubectl patch configmap -n "$NS" shop-php-flags --type merge -p "{\"data\":{\"DISCOUNT_QUERY_PER_CODE\":\"$value\"}}"
# Environment variables are read at container start, so restart to pick up the new value.
kubectl rollout restart -n "$NS" deploy/shop-php
kubectl rollout status -n "$NS" deploy/shop-php --timeout=120s
echo "Discount query storm is $1 (DISCOUNT_QUERY_PER_CODE=$value)."
