#!/usr/bin/env bash
# Turns the OOMKilled crash-loop scenario on or off by scaling the memory-leak Deployment between 1 and 0.
# Usage: ./oom-crashloop.sh on|off
set -euo pipefail

NS=otel-workshop

case "${1:-}" in
  on)
    kubectl scale -n "$NS" deploy/memory-leak --replicas=1
    echo "memory-leak started. It leaks ~2 MiB/s against a 96Mi limit, so expect the first OOMKill after ~40 s."
    echo "Watch it with: kubectl get pods -n $NS -l app.kubernetes.io/name=memory-leak -w"
    ;;
  off)
    kubectl scale -n "$NS" deploy/memory-leak --replicas=0
    echo "memory-leak stopped."
    ;;
  *)
    echo "usage: $0 on|off" >&2
    exit 1
    ;;
esac
