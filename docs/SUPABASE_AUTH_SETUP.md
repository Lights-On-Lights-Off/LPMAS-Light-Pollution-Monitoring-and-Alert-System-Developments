# Supabase Auth Setup for LPMAS

Covers the settings that make password reset work end to end. Everything
here is in the Supabase dashboard unless stated otherwise.

The reset flow has four moving parts, and a failure in any one of them looks
the same to the user — "the link does nothing". They are listed in the order
you should check them.

---

## 1. Email provider

**Path:** Dashboard → your project → **Authentication** → **Providers** → **Email**

LPMAS needs *some* SMTP provider to send reset mail. Supabase's built-in
email is rate-limited to a handful of messages per hour and is explicitly
not for production, so on a real deployment configure SMTP first (section 4)
and come back here.

Confirm:

- **Email provider** is enabled.
- **Confirm email** is **ON** for production. An unconfirmed account that
  requests a reset gets a different error, and the UI reports it as
  "this account's email address is not confirmed yet" rather than sending
  mail that goes nowhere.

---

## 2. URL configuration

**Path:** Authentication → **URL Configuration**

### Site URL

The canonical origin of the deployed app. Used for any redirect Supabase
generates on its own.

| Environment | Site URL |
| --- | --- |
| Local development | `http://localhost:3000` |
| Production | `https://your-domain.example` |

### Redirect URLs

This is the setting that most often breaks password reset. The link Supabase
emails must be allowed to return to, or the browser refuses the redirect
before your app ever loads.

Add both, always:

```
http://localhost:3000/reset-password
https://your-domain.example/reset-password
```

Add the bare origins too if you expect Supabase to redirect to the site
root anywhere (magic link, email confirmation):

```
http://localhost:3000
https://your-domain.example
```

**Why `/reset-password` specifically:** the recovery link is single-use and
carries a token that establishes a session. If it lands on `/login`, the user
is authenticated but has no form to set a new password. The app's
`resetRedirectTo()` in `web/lib/password-rules.ts` points here, and the
dashboard list has to permit it.

Wildcards such as `https://*.example.com` are supported if you use
preview deploys, but avoid them in production — a wildcard redirect is an
open door for token theft from any host you do not control.

---

## 3. Email templates

**Path:** Authentication → **Email Templates** → **Reset Password**

The default template works. Two things are worth changing:

1. **The link target.** The `{{ .ConfirmationURL }}` variable is what
   Supabase substitutes with your redirect plus the recovery token. Leave it
   intact. If you rewrite the template, keep that variable exactly as
   written — a template that drops it produces a mail with no working link
   and no error anywhere.
2. **The subject line.** The default subject is generic. Something like
   `LPMAS password reset` makes the mail identifiable to a user deciding
   whether to click it.

A minimal template that is known to work:

```html
<p>You asked to reset your LPMAS password.</p>
<p><a href="{{ .ConfirmationURL }}">Choose a new password</a></p>
<p>This link works once and expires shortly. If you did not request it,
you can ignore this message and your password will stay unchanged.</p>
```

---

## 4. SMTP (production)

**Path:** Dashboard → your project → **Email** → **Custom SMTP**

Supabase's built-in SMTP is for development only. Configure a provider —
Semaphore's own account is unrelated, so this is a separate service such as
Resend, Postmark, or SendGrid.

Required fields:

| Field | Notes |
| --- | --- |
| SMTP host | e.g. `smtp.resend.com` |
| Port | `465` (implicit TLS) or `587` (STARTTLS) |
| Username | Usually the API key or a full address |
| Password | The provider's secret |
| Sender address | Must be on a domain you can prove SPF/DKIM for |

Use the **Supabase SMTP** integration, not your own provider's dashboard, so
the project picks the configuration up automatically.

**Proving the domain.** SPF and DKIM must be set on the sending domain, or
the mail will land in spam and the user will conclude the feature is broken.
Verify in the provider's dashboard, then send a test through
Authentication → **Email** → **Send test email** to an address you control.

---

## 5. Local development

```bash
# web/.env.local
NEXT_PUBLIC_SUPABASE_URL=https://your-project-ref.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=your-publishable-or-anon-key
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
```

`NEXT_PUBLIC_*` values reach the browser. The service role key must not be
prefixed that way — it is read server-side only, by the API routes under
`web/app/api/`. `web/.env.local` is git-ignored.

Then:

```bash
cd web && npm run dev
```

---

## 6. Testing the flow

1. Sign in as an existing account to confirm the app works before testing
   recovery.
2. Go to `/login` → **Forgot password?**
3. Enter the account email → **Send reset link**
4. Open the mail → click **Choose a new password**
5. Land on `/reset-password`, set a new password
6. Confirm the old password no longer works and the new one does
7. Re-click the same link from the mail. It must fail with "This reset link
   has expired or has already been used" — if it still works, the token is
   not being single-use and that is a problem worth reporting.

### Testing the failure paths

| What to do | Expected result |
| --- | --- |
| Submit a new address that does not exist | The same neutral confirmation as a real one. It must **not** say "no account found" — that leaks which addresses are registered. |
| Wait for the link to expire, then click it | "This reset link has expired or has already been used", with a link to request a new one |
| Reuse a link that already worked | Same expiry message |
| Submit a password shorter than 8 characters | Inline validation, no request sent |
| Submit two different passwords | "Passwords do not match" |
| Re-enter the old password as the new one | "The new password must be different from the old one" |
| Click the link with `localhost:3000` removed from Redirect URLs | Supabase refuses the redirect. This is the most common cause of a dead link in development. |

---

## 7. Troubleshooting

**"The link does nothing" / redirects to the site root**
The URL is not in Redirect URLs. Check section 2. This is the first thing to
check, every time.

**"Invalid or expired token" immediately, on a link just received**
Check the system clock. Supabase's tokens are time-limited and a skewed
server clock invalidates them. The Pi's clock is set in `pi-server/.env`
via `LPMAS_TIMEZONE`, but the *Supabase* project's clock is what matters for
the token itself.

**The mail never arrives**
Check spam first. Then confirm the SMTP test in section 4 succeeds, and that
SPF/DKIM are actually set. On a project still using the built-in provider,
check the hourly rate limit — a shared test address can exhaust it quickly.

**"Email not confirmed"**
The account was created without confirming its address. Confirm it from
Authentication → **Users**, or have the user sign in once to trigger a new
confirmation.

**Reset works in development but not in production**
The production origin is missing from Redirect URLs, or Site URL still points
at `localhost`. Check both in section 2.

**The user is sent back to /login after clicking**
`resetRedirectTo()` points somewhere other than `/reset-password`. The value
is built in `web/lib/password-rules.ts`; do not "simplify" it to `/login` —
that combination is the bug the flow exists to fix.

**Rate limited while testing**
Password reset is rate-limited per address and per IP. Wait a few minutes
between attempts rather than retrying in a loop.

---

## Where the code lives

| Concern | File |
| --- | --- |
| Password rules, redirect target, error translation | `web/lib/password-rules.ts` |
| Request-a-link page | `web/app/forgot-password/page.tsx` |
| Choose-a-new-password page | `web/app/reset-password/page.tsx` |
| Link from the sign-in form | `web/components/login.tsx` |
| Role model (`admin` / `manager` only) | `web/lib/profile.ts`, migration `0003_remove_technician_role.sql` |
