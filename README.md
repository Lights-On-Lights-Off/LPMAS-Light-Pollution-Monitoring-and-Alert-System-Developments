# LPMAS — Light Pollution Monitoring and Alert System

Refactored starting point for the real system, built on top of the earlier
LPIMAS scaffold. Adapted to match the confirmed project architecture:

- **Sensor data lives on the Raspberry Pi** (Flask + SQLite) — NOT in the
  cloud, because Flowerland's WiFi doesn't reliably cover the whole farm.
  This is the single source of truth for readings, phases, and incidents.
- **Supabase is used ONLY for user accounts/auth** — no sensor data is
  stored there. This keeps the core monitoring pipeline fully functional
  even with no internet access; only login requires connectivity.
- **Detection logic is phase-aware**, covering both:
  - **Illumination phase** (30 days) — range check, 70–100 lux, during the
    confirmed 6:30 PM–11:00 PM operating window.
  - **Dark phase** (60 days) — single ceiling check (reused from the
    original scaffold's intrusion-detection logic, which already fit).

## Structure

```
lpmas/
├── web/            Next.js dashboard (adapted from the original scaffold)
├── pi-server/       Flask backend — runs ON the Raspberry Pi
├── supabase/        Auth-only migration (profiles, roles — no sensor data)
└── docs/
    └── esp32-example.ino   ESP32 sketch, posts to the Pi's local IP
```

The original scaffold's `apps/api` (Express, cloud-hosted) has been
removed — `pi-server` replaces it entirely and runs locally on the Pi.

## Setup

### 1. Pi server (run this on the Raspberry Pi)

```bash
cd pi-server
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
python app.py
```

Starts on `http://0.0.0.0:5000`. Find the Pi's IP with `hostname -I` —
you'll need it for both the ESP32 sketch and the web dashboard's `.env`.

A default illumination phase (70–100 lux, 6:30 PM–11:00 PM, 30 days from
today) is seeded automatically on first run. Adjust via the `/api/phases`
endpoint or directly in `lpmas.db` as needed.

### 2. ESP32

Open `docs/esp32-example.ino` in Arduino IDE. Update:
- `ssid` / `password` — must be a **2.4GHz** network (ESP32 doesn't support 5GHz)
- `serverUrl` — the Pi's IP from step 1
- `sensorId` — unique per unit (`sensor1`, `sensor2`, `sensor3`)

### 3. Web dashboard

```bash
cd web
cp .env.example .env.local
# edit .env.local: set NEXT_PUBLIC_PI_API_URL to the Pi's IP
npm install
npm run dev
```

Runs without Supabase configured — falls back to demo data automatically.
Add Supabase credentials to `.env.local` once auth is set up (see below).

### 4. Supabase (auth only, optional until needed)

```bash
# In the Supabase SQL editor, run:
supabase/migrations/0001_auth_only.sql
```

This creates `profiles` (with `admin` / `manager` / `technician` roles)
and a trigger that auto-creates a profile on signup. No sensor/incident
tables are created here by design.

## What changed from the original LPIMAS scaffold

| Area | Original | Refactored |
|---|---|---|
| Sensor data storage | Supabase Postgres (cloud) | SQLite on the Pi (local) |
| Backend | Express API on Render (cloud) | Flask on the Pi (local) |
| Detection logic | Dark-phase ceiling only | Dark-phase ceiling **+** illumination-phase range |
| ESP32 target | Cloud API URL | Pi's local IP |
| Batches/greenhouses concept | Multi-greenhouse, planting batches | Simplified to phases (matches current single-greenhouse pilot with 3 sensors) |
| Auth | Full Supabase (data + auth) | Supabase for auth only |

## Next steps

- Wire up sensors 2 and 3 via the TCA9548A multiplexer once available
- Add email/SMS alerting for open incidents (Resend integration from the
  original scaffold can be reused once the Pi has internet for outbound
  alerts specifically — this doesn't affect core monitoring, which stays
  local-first)
- Set up Supabase project and test the login flow end-to-end
- Customize dashboard styling/branding
# LPMAS-Light-Pollution-Monitoring-and-Alert-System-Developments
