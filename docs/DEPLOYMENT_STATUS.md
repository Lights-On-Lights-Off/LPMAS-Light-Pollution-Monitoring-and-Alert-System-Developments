# LPMAS deployment status

## Cloud-only rollout — 2026-10-04

The owner authorized migrations, commit/push, and cloud configuration while
requiring the Raspberry Pi to remain unchanged. This release excludes the
older local Pi edits. Supabase migration `0022` derives greenhouse episodes
from the existing reading deliveries; no new Pi processing or polling is added.

Completed on project `fnyzvtajcpuufgfzutqw`:

- Migrations `0019`, `0020`, `0021`, and `0022` applied through the CLI.
  A subsequent dry run reports no pending migrations (23 total, `0000`–`0022`).
- `ingest-reading` version 16 deployed with JWT verification enabled.
  `pi-gateway` version 2 deployed with its existing scoped Pi-token check and
  JWT verification disabled, matching the prior gateway configuration.
  `send-test-sms` version 12 remains unchanged.
- Empty Trash SQL repair is applied; role grants and the explicit safeupdate
  condition are verified. Dashboard recipient/Gmail changes are prepared in code.
- Rollback-only live cloud checks passed for unchanged Pi payloads, deduplication,
  multi-sensor episodes, interrupted recovery, offline members, configuration
  changes, dark-phase recovery, and expired notification jobs. The first test
  fixture assumed 15 seconds while production uses 11; it was made explicit
  within the rollback transaction, and the stricter 11-second case is also tested.
- HTTP checks verified the existing backend worker tick, rejection of public/
  unauthenticated callers, invalid classification rejection before database
  writes, and scoped gateway authorization.
- Existing counts remain: 22,057 receipts, 50 minute aggregates, 14 sensor
  incidents, two sensors, and two Auth users. No fixture greenhouses or new
  notification jobs remain. Production offline threshold remains 11 seconds.
- Application schema/data and the prior two Edge sources are backed up privately
  under ignored `deploy/backups/2026-10-04-*` paths. These application backups
  are not a complete backup of managed Auth/storage schemas.

Verification of the release selection using the committed Pi files passed:
322 application tests, Edge/web type checks, firmware host checks, all 23
migrations executed on a disposable database, SQL/RPC contracts, concurrent
cloud episode/notification checks, and the production web build. The existing
multiple-lockfile workspace warning remains.

## Activation still pending

Notification sending is disabled (`greenhouse_notifications_enabled=false`),
and Gmail is not authorized. No real messages were sent. Google project
`lpmas-510605` needs OAuth clients/configuration, verified administrator account
mapping, and sender consent. The intended Gmail does not currently match the
existing administrator Auth email. Manager recipient/contact details and real
handset/mailbox checks remain required. Public signup stays disabled.

The dashboard code still needs deployment through the existing web hosting
workflow and authenticated browser QA. No Pi source, device, service, credential,
or dependency was changed during this rollout. Latest sensor timestamps observed
were from 2026-10-03; fresh hardware telemetry was not verified.

Follow [MANUAL_UPDATE.md](MANUAL_UPDATE.md) and
[GREENHOUSE_ALERT_ROLLOUT.md](GREENHOUSE_ALERT_ROLLOUT.md) for the cloud-only
activation steps. The older record below is historical and superseded where it
instructs a Pi replacement or describes the old notification sender.

## Historical manual Pi/web handoff

### Independent manager/admin fixes — prepared 2026-10-02

`0021_recycle_bin_safe_delete.sql` repairs Empty Trash without changing the Pi
or notification protocol. It adds an explicit deletion condition while keeping
the manager/admin role check, and returns the actual deleted-row count. Isolated
database verification reproduced the old safeupdate error and confirmed the fix
against the existing `0018` release, independently of `0019`/`0020`.

The admin SMS configuration now has an Add button opening a modal to choose a
verified manager and save their phone together. Cancel leaves the saved contact
unchanged. The saved manager and number are shown on the card; unrelated system
configuration saves no longer overwrite them. This does not send a test message
or enable the deferred notification rollout.

These fixes are local, not deployed. Apply only the standalone SQL repair on the
existing deployment and deploy the web changes when performing this update.
Do not batch-push the pending `0019`/`0020` notification cutover to install this
repair. Applying the SQL through the SQL editor also requires reconciling the
CLI migration history before a later migration rollout. No Pi update is needed
for either of these fixes.

Supabase setup for the earlier manual handoff was completed. The earlier choice
to replace the Pi app is superseded by the request to leave the Pi untouched.

## Completed on the live project

- Project: `fnyzvtajcpuufgfzutqw` (LPMAS).
- All 17 migrations are applied, including `0000_activity_logs.sql` and
  `0016_field_pilot_delivery.sql`. The migration dry run reports no pending SQL.
- Final idempotent `ingest-reading` and `send-test-sms` handlers are deployed
  with JWT verification and explicit backend authorization.
- `LPMAS_BACKEND_JWT` is provisioned privately to match the existing published
  legacy service-role JWT. No Pi Supabase key replacement is required.
- RLS is enabled on all 11 application tables. Live checks verified public
  monitoring reads, hidden private settings, private receipt/job access,
  backend-only ingestion/notification RPCs, manager/admin job access, and
  profile role-update restrictions.
- The live rollback-only fixture suite passed for receipt deduplication,
  archived sensor liveness, historical assignments, incident versions,
  notification leases/retries, restore collision handling, and role grants.
  Fixtures rolled back without sending SMS.
- HTTP tests confirmed identical deliveries replay once, a changed payload
  with the same UUID is rejected, archived data cannot resurrect a sensor,
  anonymous/client keys cannot call either handler, and both gateways require
  JWTs. The temporary unmonitored HTTP reading/registry entry was removed and
  its absence verified.
- Historical data is preserved: two sensors, 42 legacy minute aggregates,
  and ten legacy incidents. No verification Auth users remain.
- Public signup is disabled because new accounts otherwise receive manager
  privileges. Email login remains enabled; production recovery site/redirect
  URLs are preserved. Only this one Auth property was changed.
- Private schema/public-data and prior function backups are saved under the
  ignored `deploy/backups/2026-10-01-pilot-cutover/` directory. This is not a
  full backup of Auth users or other managed schemas.
- 253 application tests and type checks pass. The production web build passed.
  The optional hardened ESP32 sketch compiled in the earlier verification.

## Historical rollout steps (Pi update now deferred)

1. Replace/restart the Pi's `app.py`, preserving its SQLite database, `.env`,
   tunnel script, dependencies, and services. The updated app supports the
   existing registered sensors' `sensor_id`/`lux` payload and generates durable
   cloud UUIDs on the Pi. No firmware flash or new environment key is required.
2. Deploy the updated web project using the existing Vercel configuration and
   environment variables.

Follow [MANUAL_UPDATE.md](MANUAL_UPDATE.md) for backups, service commands, and
post-update checks. The old Pi's cloud requests are incompatible with the new
handler until `app.py` is updated; its local raw readings/legacy retry file
must be preserved for recovery. No SQL or Edge deployment remains for the user.

## Operational configuration and limits

- Real SMS is not enabled: the textbee API key and recipient are empty.
  Provider credentials/gateway and a real handset check are still needed to
  send/verify alerts. The database and Edge notification infrastructure is
  deployed; no credential or phone number has been invented.
- The database has no greenhouses configured. Assign the real sensors and set
  crop phase dates through the normal dashboard flow after deployment.
- Existing firmware compatibility is not device authentication: an attacker
  knowing a registered sensor ID could forge a request to the Pi's public
  endpoint. It also cannot deduplicate sensor-side retries without capture
  UUIDs. The optional hardened firmware/shared device key address those limits.
  Durable Pi-to-cloud replay is idempotent in either mode.
- Actual Pi installation, fresh hardware telemetry, authenticated browser QA,
  live SMTP/SMS, and the 72-hour pilot have not been performed by this agent.
  They are deployment/operational validation, not unfinished migrations.

## Live verification metadata

```json
{
  "checked_at": "2026-10-01T03:11:37.358219+00:00",
  "functions": [
    {
      "slug": "ingest-reading",
      "version": 13,
      "verify_jwt": true
    },
    {
      "slug": "send-test-sms",
      "version": 11,
      "verify_jwt": true
    }
  ],
  "public_signup_disabled": true,
  "email_login_enabled": true,
  "migration_history": [
    {
      "applied_migrations": 17,
      "pilot_applied": true,
      "prerequisite_applied": true
    }
  ],
  "retained_counts": {
    "historical_aggregates": 42,
    "historical_incidents": 10,
    "notification_jobs": 0,
    "receipts": 0,
    "remaining_auth_fixtures": 0,
    "sensors": 2
  },
  "rls_tables_verified": 11
}
```
