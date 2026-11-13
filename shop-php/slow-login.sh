#!/usr/bin/env bash
# Turns the slow-login scenario on or off: every POST /login runs a user lookup that takes 1.5 s in MySQL.
# Usage: ./slow-login.sh on|off
set -euo pipefail

NS=otel-workshop
case "${1:-}" in
  on)  value=true ;;
  off) value=false ;;
  *)   echo "usage: $0 on|off" >&2; exit 1 ;;
esac

kubectl patch configmap -n "$NS" shop-php-flags --type merge -p "{\"data\":{\"LOGIN_SLOW_QUERY\":\"$value\"}}"
# Environment variables are read at container start, so restart to pick up the new value.
kubectl rollout restart -n "$NS" deploy/shop-php
kubectl rollout status -n "$NS" deploy/shop-php --timeout=120s
echo "Slow login is $1 (LOGIN_SLOW_QUERY=$value)."
