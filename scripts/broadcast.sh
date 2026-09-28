#!/usr/bin/env bash
# Thin wrapper around scripts/broadcast.ts - see that file for full docs.
#
# Example:
#   SUPER_ADMIN_EMAIL=you@pypecrm.com SUPER_ADMIN_PASSWORD='...' \
#     ./scripts/broadcast.sh --title "Heads up" --message "..." --severity warning --audience all
set -euo pipefail
cd "$(dirname "$0")/.."
npx tsx scripts/broadcast.ts "$@"
