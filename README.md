# LPMAS: Light Pollution Monitoring and Alert System — Development

![status](https://img.shields.io/badge/status-active%20development-orange)
![maintenance](https://img.shields.io/badge/maintenance-active-brightgreen)
![repository](https://img.shields.io/badge/repository-development-yellow)

---

## 🛠️ About This Repository

This is the **active development repository** for LPMAS. All new features, updates, experiments, and bug fixes happen here first.

Once changes are complete, fully tested, and verified stable, they are merged into the main (production) repository:

**🔗 Main Repository:**
https://github.com/Lights-On-Lights-Off/LPMAS-Light-Pollution-Monitoring-and-Alert-System.git


---

## 🔄 Workflow

1. Build and test new features/fixes in this repository
2. Verify stability through testing
3. Once approved, changes are pushed to the main repository
4. The main repository always reflects the last stable, production-ready version

---

## ⚠️ Note

This repository may contain **unstable, incomplete, or experimental code** at any given time.
For the stable/production version, please refer to the main repository above.

## Monitoring data setup

The monitoring application uses real hardware:

`ESP32 + BH1750 -> Raspberry Pi Flask (existing firmware supported) -> SQLite readings + durable outbox -> Supabase receipts / minute aggregates / incident snapshots -> dashboard`

The Pi keeps its existing sensor incident lifecycle. Supabase confirms greenhouse
episodes from the unchanged reading deliveries and deduplicates UUID deliveries;
notifications use a durable queue, the **textbee** SMS gateway, and authorized
Gmail sending. The cloud greenhouse rollout records at most one opening and
one recovery attempt per channel and episode. Public monitoring
is read-only. Managers configure greenhouses and respond to incidents; admins
manage accounts and system/SMS settings.

### Setup and deployment

Follow [the field-pilot guide](docs/FIELD_PILOT.md) for the coordinated protocol
upgrade, hardware provisioning, migration order, notification semantics, and
72-hour acceptance checks. Apply **all migrations in order starting at 0000**
on a fresh Supabase database. For existing installs, review pending migrations
against the deployed worker versions before applying them. The prepared
[greenhouse notification and Google email rollout](docs/GREENHOUSE_ALERT_ROLLOUT.md)
uses Supabase migration `0022` without a Pi update. Sending stays disabled until
Google authorization, real recipients, and delivery checks are complete.
Password recovery setup is in [the authentication guide](docs/SUPABASE_AUTH_SETUP.md).
Current live rollout progress is recorded in [the deployment status](docs/DEPLOYMENT_STATUS.md).

For the Pi, install `pi-server/requirements.txt`, provision `pi-server/.env`
from `.env.example`, then run `python3 pi-server/app.py`. For the web app,
install dependencies and use `npm run dev`. Backend credentials must never
be prefixed `NEXT_PUBLIC_`. Production Pi origins must use HTTPS; an explicit
local HTTP origin is permitted only for development.

### Fixed classification rules

During the configured illumination monitoring window:

- `lux >= 50`: safe
- `30 < lux < 50`: warning
- `lux <= 30`: violation

During the continuous dark phase (60 days by default):

- `lux <= 15`: safe
- `15 < lux <= 29`: warning
- `lux > 29`: violation

Other samples are stored as unclassified. Three consecutive violation samples
with gaps no larger than 15 seconds confirm an incident. At ten-second sampling,
the first-to-third span is approximately twenty seconds. Supabase tracks three
consecutive safe samples for each affected sensor independently of Pi reports;
the greenhouse recovers after every affected sensor has fresh safe readings.
Opening and recovery create separate SMS and email attempts. Consumed attempts
are never retried; provider acceptance is displayed separately from actual
recipient delivery, which needs a real handset and mailbox check. These new
episode semantics run in Supabase using the existing Pi payload. Out-of-order,
stale, future, and mismatched-context readings cannot confirm current alerts.
The Pi application, services, dependencies, and polling frequency stay unchanged.

Managers can export hardware activity from the Pi's raw SQLite readings.
Historical greenhouse assignments remain attached to those readings.

### Verification

```bash
bash scripts/verify.sh
LPMAS_VERIFY_DATABASE=1 bash scripts/verify.sh # isolated Docker database
npm run build
```

The tests do not send real messages or modify live Supabase projects. Staging
and hardware acceptance steps are documented in the field-pilot guide.
