#!/usr/bin/env bash
#
# Runs every check in the project. Local checks write temporary caches. Database checks are opt-in and isolated.
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
  bash -c 'cd supabase/functions/ingest-reading && deno test index.test.ts notifications.test.ts ../_shared/gmail.test.ts'
run "Edge Function tests — send-test-sms" \
  bash -c 'cd supabase/functions/send-test-sms && deno test index.test.ts sms-provider.test.ts'
run "Edge Function tests — scoped Pi gateway" \
  bash -c 'cd supabase/functions/pi-gateway && deno test index.test.ts'
run "Edge Function typecheck" \
  bash -c 'cd supabase/functions/ingest-reading && deno check index.ts index.test.ts && cd ../send-test-sms && deno check index.ts index.test.ts && cd ../pi-gateway && deno check index.ts index.test.ts'
run "Web tests" \
  bash -c 'cd web && deno test lib/*.test.ts'
run "Web typecheck" \
  bash -c 'cd web && npx tsc --noEmit'
run "Pi tests — delivery, history, lifecycle, monitoring windows and tunnel retries" \
  bash -c "cd pi-server && '$PY' -m pytest -q"
run "Firmware network validation, storage and timer checks" bash scripts/verify-firmware.sh

run "Migration SQL parses" "$PY" scripts/check_sql_syntax.py
run "RPC contract (SQL vs TypeScript)" \
  deno run --allow-read scripts/check-rpc-contract.ts

if [ "${LPMAS_VERIFY_DATABASE:-0}" = 1 ]; then
  run "Fresh database migrations, RLS, replay, leases and concurrency" bash scripts/verify-database.sh
else
  echo "── Database integration"
  echo "   SKIPPED this run. Run LPMAS_VERIFY_DATABASE=1 bash scripts/verify.sh for an isolated Docker database."
  echo
fi

if [ "$fail" -eq 0 ]; then
  echo "All runnable checks passed."
else
  echo "One or more checks FAILED."
fi
exit "$fail"
