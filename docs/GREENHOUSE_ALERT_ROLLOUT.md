# Greenhouse notifications and Google email rollout

## Current state

This change prepares one opening and one recovery attempt per greenhouse episode,
for each of SMS and email. It is not a declaration that production is ready.
Sending is disabled until the coordinated rollout is complete.

### Cloud ownership — 2026-10-04

The owner requires the Pi to stay untouched. Migration `0022` moves episode
confirmation, recovery, context closure, and persistent membership into Supabase.
It consumes the existing idempotent reading deliveries; no Pi application,
dependency, device, service, or polling change is needed. Pi sensor reports keep
their existing lifecycle and are displayed separately from cloud episodes.
Earlier local Pi changes are excluded from this release.

The project is `fnyzvtajcpuufgfzutqw`. Google OAuth configuration, verified account
mapping, manager contact selection, administrator consent, and real SMS/email
receipt remain activation dependencies. Keep sending disabled until completed.

## Behavior

- Three consecutive violation samples from the same sensor and monitoring
  context, at most 15 seconds apart, confirm a sensor incident.
- Overlapping sensor incidents share one persistent greenhouse episode. Further
  violations, acknowledgments, restarts, and duplicate deliveries do not generate
  another opening notification.
- Each affected sensor needs three consecutive safe samples, with the same
  timing and context requirements, before its report resolves. An offline or
  warning-level affected sensor cannot satisfy recovery.
- The episode resolves only after all of its affected sensor incidents resolve
  safely. Context expiry, reassignment, or changed configuration closes it
  without claiming safe lighting or sending a recovery message.
- Recovery creates a separate SMS and email event. A new confirmed violation
  after closure starts a new episode.
- Unattempted openings are suppressed if their episode closes, or a newer
  greenhouse episode has already reached the cloud. Old snapshots cannot reopen
  a terminal episode. Existing active incidents become legacy cloud members at upgrade, without
  replaying opening alerts. Old receipt timestamps initialize per-sensor
  high-water marks; historical backlogs never generate current notifications.
- Positive sample gaps must be at most 15 seconds. Recovery also requires all
  affected sensors to have fresh safe samples within the offline threshold
  (capped at 15 seconds). Configuration hashes match the unchanged Pi.
- Cloud notification jobs expire after 15 seconds if still unattempted, preventing
  delayed activation from sending an obsolete opening or recovery backlog.

## What the no-retry guarantee means

The database permanently consumes an attempt before the worker contacts the
provider. A unique constraint covers episode + opening/recovery + channel.
Concurrent workers cannot claim the same attempt; a database trigger prevents
consumed attempts from being reset. Neither automatic nor operator retries are
available for incident messages. The older retrying sender is retired.

This guarantees at most one application submission attempt, **not exactly one
delivered SMS or email**. A crash after consuming the attempt but before sending
can lose the message. A timeout after sending can leave acceptance unknown. A
worker crash can also lose other jobs consumed in its batch. Providers/carriers
can split, delay, or duplicate messages independently. Opening/recovery text is
ASCII and below 160 characters to avoid normal SMS segmentation.

Readings and incident snapshots still use their existing durable delivery retries;
those retries preserve monitoring history and cannot reset notification attempts.
The legacy `retry_notifications` worker tick name now means "consume new jobs".

## Accounts and Google configuration

1. Obtain the real administrator Gmail, manager email, and manager phone. Map
   them to the existing account UUIDs; do not create replacement UUIDs or change
   roles. Keep a working administrator session until the new login is verified.
2. Review the email mapping before changing Auth accounts. Do not mark an address
   confirmed merely because it looks valid. Verify control through Google login
   or an actual confirmation flow. Replace known testing passwords as part of
   owner-controlled account setup; do not retain shared testing credentials in
   production. Check that Google sign-in returns the original account UUID.
3. In Google Cloud, configure an OAuth web client for basic Google sign-in.
   Register Supabase's exact Auth callback:
   `https://fnyzvtajcpuufgfzutqw.supabase.co/auth/v1/callback`.
4. Configure the Google provider in Supabase Auth. Keep public signup disabled
   (`enable_signup=false`) and email confirmation enabled. Only approved existing
   accounts may sign in. Do not enable broad signup to make OAuth work.
5. Add the exact dashboard `/auth/callback` URL to Supabase's redirect allowlist.
   Avoid wildcard production redirects. Set `NEXT_PUBLIC_GOOGLE_SIGN_IN_ENABLED=true`
   only after existing approved accounts can sign in and unknown accounts are
   rejected.
6. Enable the Gmail API. Configure a separate OAuth web client for sending with
   the exact dashboard `/api/admin/gmail/callback` redirect. The sending flow asks
   only for `openid`, `email`, and `gmail.send`, not mailbox-reading permissions.
7. Complete the production OAuth audience/publishing configuration and any Google
   verification that applies. External applications left in Testing issue Gmail
   refresh tokens expiring in seven days. Production tokens can still be revoked;
   no sending service can guarantee perpetual authorization.

Google sign-in and Gmail authorization are separate. Supabase's built-in Auth
email service does not send these incident messages. Existing password-reset and
invitation emails still follow their existing Supabase Auth email configuration;
this Gmail change does not silently replace those flows.

## Secrets and access boundaries

Web server environment (never public client variables):

```text
LPMAS_WEB_ORIGIN=https://YOUR_EXACT_DASHBOARD_ORIGIN
GOOGLE_GMAIL_CLIENT_ID=YOUR_SENDING_OAUTH_CLIENT_ID
GOOGLE_GMAIL_CLIENT_SECRET=YOUR_SENDING_OAUTH_CLIENT_SECRET
```

The two `GOOGLE_GMAIL_*` variables must also be Supabase Edge Function secrets.
Keep the basic sign-in OAuth client configuration in Supabase's Google provider
settings. Do not place any client secret or refresh token in `system_settings`,
frontend environment variables, Git, deployment descriptions, or logs.

The administrator authorizes the matching Gmail from System settings. The
callback verifies an existing confirmed administrator session, one-time OAuth
state, PKCE, Google's verified mailbox identity, and the send scope before saving
the refresh token in encrypted Supabase Vault storage. The private authorization
record and credential RPCs are inaccessible to anonymous users and ordinary
authenticated users. Every send checks that the stored sender still belongs to
a verified administrator. The browser receives only safe authorization status.

Select a verified manager account in System settings and save it alongside the
SMS number. The email recipient is resolved from that account's Auth email, not
from browser-submitted arbitrary email text. The recipient and message are saved
at attempt consumption so a concurrent settings edit cannot redirect a consumed
attempt. SMS and email use the same saved message and separate outcomes.

## Cloud-only deployment

1. Back up Supabase application schema/data and record deployed Edge versions.
   Preserve all existing Pi services, credentials, firmware, and queued readings.
2. Apply `0019` through `0022` in order using the migration CLI. `0019` retires
   the retry sender; `0022` installs the cloud producer. Keep the sending switch
   false throughout the rollout. Do not activate the intermediate `0019` state.
3. Deploy `ingest-reading` and `pi-gateway` with the shared Gmail module.
   Preserve their existing authorization and JWT configuration, including the
   scoped non-JWT Pi token gateway. Do not rotate the unchanged Pi credentials.
4. Deploy the web code through the existing Vercel configuration. Configure
   server/Edge OAuth secrets privately after creating the Google clients.
5. Verify the existing approved accounts retain their UUIDs. Complete Google
   sign-in and Gmail sender consent, and save a verified manager and phone.
6. Confirm fresh telemetry, cloud confirmation/recovery, and provider readiness
   before explicitly enabling `greenhouse_notifications_enabled`.
7. Run a controlled opening/recovery test using owner-approved recipients and a
   dedicated test greenhouse. Verify handset/mailbox receipt and per-channel
   outcomes. Provider acceptance alone is not delivery.

Once an attempt has been consumed, never clear the ledger or reset attempts to
"fix" a missing message. Pause new sending and diagnose the outcome. If rollout
fails, keep sending disabled; reverting only the worker code cannot restore the
retired retry API. Any rollback needs a coordinated database/service plan.

## Verification

- Unchanged-Pi payload tests and cloud database checks for simultaneous sensors,
  interrupted recovery, offline members, replay, context changes, and new episodes.
- Edge and web tests, plus TypeScript checks and production build.
- Disposable PostgreSQL migrations, replay/RLS checks, Vault encryption/access
  tests, and six concurrent notification workers consuming one attempt per
  channel without reclaiming unknown outcomes.
- Owner/browser-dependent checks remain required: Google consent, preserved
  account IDs, rejection of unknown accounts, token refresh, and actual SMS/email
  receipt. No production-ready claim until these are verified.

Reference documentation:

- [Supabase Google sign-in](https://supabase.com/docs/guides/auth/social-login/auth-google)
- [Supabase identity linking](https://supabase.com/docs/guides/auth/auth-identity-linking)
- [Gmail send permissions](https://developers.google.com/workspace/gmail/api/auth/scopes)
- [Gmail sending](https://developers.google.com/workspace/gmail/api/guides/sending)
- [Google token expiration](https://developers.google.com/identity/protocols/oauth2#expiration)
