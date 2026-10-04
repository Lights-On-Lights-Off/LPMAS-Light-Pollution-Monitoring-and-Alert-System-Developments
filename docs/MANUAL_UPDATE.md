# Cloud and dashboard update — Pi unchanged

This release changes Supabase and the dashboard. Preserve the Pi application,
SQLite database, environment, services, firmware, dependencies, and worker
schedule. Do not install the earlier local Pi episode changes.

## Supabase

Back up application schema/data, then review `supabase db push --linked --dry-run`.
Apply migrations `0019` through `0022` in order. The cloud producer in `0022`
uses the existing reading deliveries. Notification sending defaults to false;
keep it false until contact configuration, OAuth consent, and delivery checks pass.
Deploy `ingest-reading` and `pi-gateway` without changing the existing credentials
or authorization configuration. See [GREENHOUSE_ALERT_ROLLOUT.md](GREENHOUSE_ALERT_ROLLOUT.md).

## Dashboard and Google

Use the existing Vercel project and these existing environment variables:

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY` (or publishable key)
- server-only `SUPABASE_SERVICE_ROLE_KEY`

Gmail authorization also needs server-only `LPMAS_WEB_ORIGIN`,
`GOOGLE_GMAIL_CLIENT_ID`, and `GOOGLE_GMAIL_CLIENT_SECRET`. The Gmail OAuth client
variables must also be Edge secrets. Keep basic Google sign-in OAuth configuration
in Supabase Auth. Enable the Google login button only after approved-account
sign-in and unknown-account rejection are verified.

Configure the Google clients with the exact callback URLs documented in the
rollout guide. Authorize the verified administrator Gmail from System settings;
select the verified manager and save their SMS phone. Do not replace account UUIDs
or mark unverified addresses confirmed to bypass consent.

## Verification

Confirm telemetry ingests without changing the Pi protocol; duplicates count
once and configuration changes cannot produce false recovery. Verify the
manager Empty Trash repair and administrator recipient modal in an authenticated
browser. SQL tests use rollback/disposable fixtures; do not empty real trash as
a verification step. Complete real handset/mailbox tests before declaring alerts
operational. Sending attempts cannot be retried or reset.

The existing textbee Android gateway and provider credentials are still needed
for SMS. [DEPLOYMENT_STATUS.md](DEPLOYMENT_STATUS.md) records what was applied
and which account/browser/device checks remain outstanding.
