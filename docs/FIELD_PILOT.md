# LPMAS field pilot: deployment and verification

This guide supersedes the sensor-sync/Semaphore design notes dated 2026-09-29.
Those notes describe an earlier implementation; current alerts use textbee.

## Current architecture

`ESP32 + BH1750 -> Pi ingestion (legacy registered sensors or authenticated firmware) -> SQLite raw readings + delivery outbox -> transactional Supabase ingestion -> minute history + incident snapshots + notification jobs -> dashboard`

The Pi confirms incidents and resolves them. Three consecutive violation samples
are required, with positive gaps of at most 15 seconds and matching sensor,
greenhouse, and phase. At ten-second sampling, the first-to-third span is about
20 seconds. A safe sample resolves the incident; warnings do not resolve it.

| Phase | Safe | Warning | Violation | Monitoring |
| --- | --- | --- | --- | --- |
| Illumination | lux >= 50 | 30 < lux < 50 | lux <= 30 | Configured inclusive daily window, including overnight windows |
| Dark | lux <= 15 | 15 < lux <= 29 | lux > 29 | Continuous throughout the configured dark-phase dates |

Out-of-window and unconfigured samples are stored as `unclassified`, update the
sensor registry, and do not enter monitoring aggregates or create incidents.
The default dark phase lasts 60 days immediately after illumination; admin
settings can change it. The monitoring timezone is Asia/Manila. Set the Pi
system clock with a reliable time service; a timezone setting does not set it.

The existing ESP32 firmware can keep sending `sensor_id` and `lux`. With no
`LPMAS_DEVICE_KEY` configured, the Pi accepts only IDs in its persisted sensor
registry or greenhouse assignments. It generates and stores a UUID once per
accepted request, so cloud replay remains idempotent. Legacy hardware requests
are not cryptographically authenticated; knowing a registered ID is not proof
of device identity. Sensor-side retries cannot be deduplicated without a
capture UUID, and every accepted legacy request is treated as a new sample.

The optional hardened firmware sends a capture UUID reused on retries and a
shared device key. Once `LPMAS_DEVICE_KEY` is configured, the Pi requires both
valid authentication and the capture UUID; it does not fall back to legacy
input on an authentication failure. Switch this on only after firmware setup.

The Pi stores the UUID, greenhouse/configuration fingerprint, and outbox entry
in one SQLite transaction. Reassignment cannot relabel historical queued
samples. Each confirmed incident has a separate UUID and monotonically
increasing version; late snapshots cannot reopen resolved incidents.

Raw telemetry also appears in the private cloud receipt ledger for ingestion
idempotency and audit. Public monitoring reads aggregate/incident history and
the sensor registry; receipt payloads, credentials, and notification recipient
information remain private. No raw readings or historical records are deleted
by the new pilot migration. Monitor SQLite/outbox disk usage during extended
outages; this path preserves pending deliveries rather than discarding them.

## Historical protocol deployment order (not this release)

The steps below document the older `0016` protocol setup only. The current
cloud-only update follows [MANUAL_UPDATE.md](MANUAL_UPDATE.md) and must not
replace/restart the Pi or change its firmware or credentials.

1. Back up the Pi SQLite database and Supabase data. Stop the Pi service and
   pause hardware posting during this protocol upgrade.
2. Apply migration `0016_field_pilot_delivery.sql` to staging, then verify it.
   On a **fresh database**, apply all migrations in order starting at `0000`.
   `0000_activity_logs.sql` supplies a previously undocumented prerequisite;
   it is harmless on existing installs. If migration tooling reports that this
   earlier prerequisite is missing from an existing history, review/apply the
   no-op prerequisite with the tooling's include-all option. Do not rerun
   already-applied legacy migrations against production.
3. Deploy `ingest-reading` and `send-test-sms` with JWT verification enabled.
   Both handlers also require the exact backend service-role bearer. A user
   JWT or publishable key cannot submit telemetry or send SMS. Provision the
   Edge secret `LPMAS_BACKEND_JWT` with the same legacy service-role JWT used
   by the Pi and web server. Platform-provided `SUPABASE_SERVICE_ROLE_KEY`
   may differ from that externally issued JWT; it remains the database client
   credential, while the explicit backend JWT authorizes these callers.
   Provision through a private environment file, never a command-line value.
   Update the Edge secret together with callers when rotating this credential.
4. Provision `SUPABASE_URL`, `SUPABASE_SECRET_KEY`,
   `SUPABASE_SERVICE_ROLE_KEY` from
   `pi-server/.env.example`. Use the legacy service-role JWT for the Edge
   gateway, not an `sb_secret_*` key. Keep backend keys off the ESP32/browser.
5. **Optional firmware hardening:** copy `docs/ESP32-config.example.h` to the ignored `ESP32-config.h`, provide
   Wi-Fi credentials, a random device key also set as `LPMAS_DEVICE_KEY` on the Pi, and PEM trust anchors for
   the Vercel and Pi HTTPS certificate chains. Permit NTP for the ESP32 clock
   synchronization required by certificate validation. Compile and flash the updated
   sketch. This path requires certificate validation. Existing firmware can
   continue unchanged when the optional Pi key is unset. Rotate the Wi-Fi credential
   previously committed in the old sketch; Git history still contains it.
6. Deploy the web application, start the updated Pi service, then resume the
   sensors. The Pi adds SQLite columns/outbox tables without replacing its
   historical readings. Retained legacy JSONL retry entries are imported only
   when they can be matched to local measurements. Original files remain for
   audit; unmatched entries need manual review. Legacy incidents lacking
   triggering evidence synchronize but do not create new notification jobs.
7. Configure the textbee API key and one alert recipient in Admin > System
   settings, save, and send a test to a phone you control. Keep the registered
   Android sending device online. SIM/carrier charges and provider plan limits
   apply. See [textbee's sending documentation](https://textbee.dev/docs/sending-sms/sending-sms).
8. Configure SMTP and password-recovery redirect URLs using
   [SUPABASE_AUTH_SETUP.md](SUPABASE_AUTH_SETUP.md). Verify recovery, an expired
   link, an already-used link, and login with the changed password in staging.

Do not roll back only one layer: the old Pi protocol cannot call the new
idempotent handler. If rollback is needed, stop hardware posting and restore
a compatible application set. Preserve new SQLite/outbox data for recovery;
do not drop the new schema to roll back an application.

## Current cloud notification semantics

Supabase migration `0022` tracks greenhouse episodes from unchanged reading
payloads. Three consecutive violations confirm an affected sensor; overlapping
sensors share one episode. Recovery needs three consecutive fresh safe readings
from every affected sensor. Warnings, offline sensors, old configurations, and
expired monitoring windows cannot produce safe recovery. Pi sensor reports retain
their previous lifecycle independently.

Opening and recovery each create one SMS and one email job. An attempt is
permanently consumed before provider contact. Unknown outcomes are never retried,
including operator retries. An unattempted cloud job expires after 15 seconds.
`accepted` is provider acceptance; actual delivery still needs a handset/mailbox
check. Sending stays disabled until real contacts and Gmail consent are ready.

Cloud recovery covers readings already committed to the Pi. The current ESP32
retries a post once and has no persistent sensor-side backlog. A total loss of
ESP32-to-Pi connectivity can therefore lose samples. Test cloud outages while
keeping the hardware-to-Pi connection available; do not claim recovery of
measurements that never reached SQLite.

## Local verification

```bash
bash scripts/verify.sh
LPMAS_VERIFY_DATABASE=1 bash scripts/verify.sh
npm run build
```

The opt-in database check starts a disposable Supabase PostgreSQL container
with no ports, no network, no mounted application data, and no live credentials.
It applies every migration, checks actual grants/RLS, replay deduplication,
incident versioning, legacy lease compatibility, cloud episode recovery, Vault,
restore behavior, and concurrent deliveries/notification attempts, then stops/removes its own container.

No local test sends a real SMS or changes a deployed project. The sketch can
be compiled with Arduino CLI and the installed `esp32:esp32` core using a
temporary copy of the example configuration; that verifies compilation only.
Device provisioning/flashing, live SMTP/SMS, authenticated browser workflows, and the hardware
soak test remain staging/pilot checks.

## 72-hour pilot acceptance

- At least two sensors remain distinguishable in charts and exports.
- Illumination/day-boundary/overnight windows and continuous dark monitoring
  agree between SQLite, aggregates, incidents, and SMS jobs.
- A controlled Supabase outage leaves raw readings and pending deliveries in
  SQLite. Restart the Pi during the outage; restore connectivity and verify
  counts, historical assignments, and incident identities.
- Move a sensor while old deliveries are queued. History retains its original
  greenhouse; subsequent samples use the new assignment after configuration
  reaches the Pi (normally within 30 seconds).
- Introduce safe/warning gaps, prolonged violations, recovery, and a second
  violation. Verify the confirmation sequence, acknowledgement, resolution,
  and at most one opening/recovery attempt per greenhouse episode and channel.
- Check provider rejection, offline Android gateway, and operator retry.
  Confirm receipt on a real handset separately from provider acceptance.
- Check desktop/mobile layouts, keyboard-only dialogs, browser Back, URL
  persistence, disconnected/stale states, and greenhouse delete/restore.
- Check queue backlog, oldest pending timestamp, SD-card free space, Pi service
  logs, Edge logs, cron runs, and notification outcomes daily.

Release to the pilot only after these staging checks pass. Record timestamps,
firmware version, deployment revision, and any discrepancies in the pilot log.
