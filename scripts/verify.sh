#!/usr/bin/env bash
#
# Runs every check in the project. Safe to run at any time; touches nothing.
#
#   ./scripts/verify.sh
#
# Two checks are environment-gated and are reported as SKIPPED rather than
# silently passing, because a green run that quietly skipped the database
# would misrepresent what has actually been verified.
set -uo pipefail
cd "$(dirname "$0")/.."

fail=0
run() {
  local label="$1"; shift
  echo "── $label"
  if "$@" 2>&1 | tail -3; then
    echo "   PASS"
  else
    echo "   FAIL"
    fail=1
  fi
  echo
}

echo "══ LPMAS verification ══"; echo

# The Pi tests need Flask and the SQL parser needs pglast, neither of which
# is a system package. A throwaway venv is created once and reused so the
# checks do not depend on what happens to be installed globally.
VENV="${TMPDIR:-/tmp}/lpmas-verify-venv"
if [ ! -x "$VENV/bin/python" ]; then
  echo "── Preparing a throwaway Python environment (one time)"
  python3 -m venv "$VENV" >/dev/null 2>&1
  "$VENV/bin/pip" install -q -r pi-server/requirements.txt pytest pglast >/dev/null 2>&1
  echo "   READY"
  echo
fi
PY="$VENV/bin/python"

run "Edge Function tests — ingest-reading" \
  bash -c 'cd supabase/functions/ingest-reading && deno test index.test.ts'
run "Edge Function tests — send-test-sms" \
  bash -c 'cd supabase/functions/send-test-sms && deno test index.test.ts'
run "Edge Function typecheck" \
  bash -c 'cd supabase/functions/ingest-reading && deno check index.ts index.test.ts && cd ../send-test-sms && deno check index.ts index.test.ts'
run "Web tests" \
  bash -c 'cd web && deno test lib/*.test.ts'
run "Web typecheck" \
  bash -c 'cd web && npx tsc --noEmit'
run "Pi forwarding tests" \
  bash -c "cd pi-server && '$PY' -m pytest test_forwarding.py -q"
# The monitoring time window's rules — including the overnight wrap that
# migration 0015 mirrors in SQL — live in their own suite.
run "Pi monitoring window tests" \
  bash -c "cd pi-server && '$PY' -m pytest test_monitoring_window.py -q"

run "Migration SQL parses" "$PY" scripts/check_sql_syntax.py
run "RPC contract (SQL vs TypeScript)" \
  deno run --allow-read scripts/check-rpc-contract.ts

# Docker-gated: needs a running daemon, which CI and most laptops do not have.
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  echo "── Migration apply + RLS behaviour"
  echo "   (run 'supabase db reset' manually to exercise migrations against a real database)"
  echo "   SKIPPED — not automated; see docs/ or ask for a manual run"
  echo
else
  echo "── Migrations applied to a real database"
  echo "   SKIPPED — no Docker daemon. The SQL is parsed, never executed."
  echo "   Migrations 0009-0013 and the two Edge Functions are UNVERIFIED"
  echo "   against a live Supabase project."
  echo
fi

if [ "$fail" -eq 0 ]; then
  echo "All runnable checks passed."
else
  echo "One or more checks FAILED."
fi
exit "$fail"
