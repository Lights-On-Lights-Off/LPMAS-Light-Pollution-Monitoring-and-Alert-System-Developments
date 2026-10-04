#!/usr/bin/env bash
# Fresh, isolated Supabase PostgreSQL; no ports, volumes, or live credentials.
set -euo pipefail
cd "$(dirname "$0")/.."
container="lpmas-verify-$$"
image="public.ecr.aws/supabase/postgres:17.6.1.171"
logfile="$(mktemp /tmp/lpmas-db-verify.XXXXXX)"
cleanup() { docker stop "$container" >/dev/null 2>&1 || true; }
trap cleanup EXIT
docker run --rm -d --name "$container" --network none -e POSTGRES_PASSWORD=lpmas-disposable-test "$image" >/dev/null
ready=0
for attempt in $(seq 1 45); do
  if { docker logs "$container" 2>&1 | grep -Fq '[1] LOG:  database system is ready to accept connections'; } && docker exec "$container" pg_isready -U postgres >/dev/null 2>&1; then ready=1; break; fi
  sleep 1
done
if [ "$ready" != 1 ]; then docker logs "$container"; exit 1; fi
for migration in supabase/migrations/*.sql; do
  if [[ "$migration" == "supabase/migrations/0022_cloud_greenhouse_episodes.sql" ]]; then
    if ! docker exec -i "$container" psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 < scripts/test-greenhouse-notifications.sql >"$logfile" 2>&1; then cat "$logfile"; exit 1; fi
    tail -1 "$logfile"
  fi
  # Check the previous release contract before applying its intentional replacement.
  if [[ "$migration" == "supabase/migrations/0019_greenhouse_notifications.sql" ]]; then
    if ! docker exec -i "$container" psql -U postgres -d postgres -v ON_ERROR_STOP=1 < scripts/test-pilot-database.sql >"$logfile" 2>&1; then cat "$logfile"; exit 1; fi
    tail -1 "$logfile"
    python3 scripts/test-pilot-concurrency.py "$container"
    # This repair is independent of the deferred notification/Pi cutover.
    # Verify it against the existing 0018 release before applying that cutover.
    if ! docker exec -i "$container" psql -U postgres -d postgres -v ON_ERROR_STOP=1 < supabase/migrations/0021_recycle_bin_safe_delete.sql >"$logfile" 2>&1; then cat "$logfile"; exit 1; fi
    if ! docker exec -i "$container" psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 < scripts/test-recycle-bin.sql >"$logfile" 2>&1; then cat "$logfile"; exit 1; fi
    tail -1 "$logfile"
    # postgres-only image initializes a minimal Auth stub; real Supabase Auth
    # owns this column. Change only the disposable stub as its superuser.
    docker exec "$container" psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -c 'alter table auth.users add column if not exists email_confirmed_at timestamptz' >/dev/null
  fi
  echo "Applying $migration"
  if ! { echo 'begin;'; cat "$migration"; echo; echo 'commit;'; } | docker exec -i "$container" psql -U postgres -d postgres -v ON_ERROR_STOP=1 >"$logfile" 2>&1; then
    cat "$logfile"; exit 1
  fi
done
if ! docker exec -i "$container" psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 < scripts/test-cloud-episodes.sql >"$logfile" 2>&1; then
  cat "$logfile"; exit 1
fi
tail -1 "$logfile"
python3 scripts/test-pilot-concurrency.py "$container"
echo "Database verification passed; disposable container removed on exit."
