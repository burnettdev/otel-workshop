#!/usr/bin/env bash
# Turns the OOMKilled crash-loop scenario on or off.
# Usage: ./oom-crashloop.sh on|off
set -euo pipefail

NS=otel-workshop
DIR="$(cd "$(dirname "$0")" && pwd)"

case "${1:-}" in
  on)
    kubectl apply -f "$DIR/10-memory-leak.yaml"
    echo "memory-leak deployed. It leaks ~2 MiB/s against a 96Mi limit, so expect the first OOMKill after ~40 s."
    echo "Watch it with: kubectl get pods -n $NS -l app.kubernetes.io/name=memory-leak -w"
    ;;
  off)
    kubectl delete -f "$DIR/10-memory-leak.yaml" --ignore-not-found
    echo "memory-leak removed."
    ;;
  *)
    echo "usage: $0 on|off" >&2
    exit 1
    ;;
esac
