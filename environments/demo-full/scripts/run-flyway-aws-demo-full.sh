#!/bin/bash
# run-flyway-aws-demo-full.sh — delegates to the shared ECS run-task migration script.
set -euo pipefail
exec "$(dirname "$0")/../../../scripts/shared/run-flyway-ecs.sh" "${1:-demo-full}"
