# Meridian Auth Expiry Notifications & Re-login Flow

**Date:** 2026-04-11
**Status:** Approved

## Problem

When ShareTab runs with `AI_PROVIDER=meridian`, the Claude OAuth token can expire. When this happens, Meridian falls back to OCR silently. The admin has no way to know auth expired until they notice degraded receipt scan quality or manually check the admin dashboard. Re-authenticating requires SSH into the container to run `claude login`.

## Solution

Three capabilities:

1. **Background health poller** that detects auth expiry and emails the admin
2. **Admin dashboard re-login flow** that lets the admin re-authenticate without SSH
3. **Configurable notification frequency** so the admin controls email volume

## Component 1: Meridian Health Poller

### File: `src/server/lib/meridian-health-poller.ts`

A singleton module that runs a `setInterval` (every 5 minutes) inside the Next.js server process.

**Behavior:**

- Fetches `http://127.0.0.1:{MERIDIAN_PORT}/health` and parses the JSON response
- Tracks state: `healthy | unhealthy | unknown` plus timestamps (`lastHealthyAt`, `lastUnhealthyAt`, `lastEmailSentAt`)
- On transition healthy -> unhealthy:
  - Sends email to `ADMIN_EMAIL` immediately
  - Email includes: error message, link to admin dashboard, instruction to re-authenticate
- On continued unhealthy:
  - Reads `meridianNotifyInterval` from `SystemSetting` table
  - Compares `lastEmailSentAt` against the configured interval
  - Sends reminder email if enough time has passed (unless set to "once per incident")
- On transition unhealthy -> healthy:
  - Resets incident flag so future expiry triggers a new email
  - Logs recovery
- Only activates when `AI_PROVIDER=meridian` -- no-ops otherwise

**Initialization:**

Called from a new `src/instrumentation.ts` file (Next.js instrumentation hook -- runs once on server startup). This is the standard Next.js pattern for server-side initialization. No instrumentation hook exists yet in this project, so one will be created.

### Email content

Subject: `[ShareTab] Claude AI authentication expired`

Body includes:
- What happened (Meridian health check returned unhealthy)
- The error from Meridian (e.g., "Not logged in. Run: claude login")
- Link to admin dashboard to trigger re-login
- Timestamp

When the poller also has a login URL available (from an active login flow), it includes that too.

## Component 2: Admin Re-login Flow

### Backend -- new tRPC procedures in `admin.ts`

**`admin.getMeridianAuthStatus`** (query)
- Fetches Meridian's `/health` endpoint
- Returns `{ status: "healthy" | "unhealthy" | "degraded" | "not_running", email?: string, error?: string }`
- Used by the dashboard to show current auth state and whether to show the re-login button

**`admin.startMeridianLogin`** (mutation)
- Only one login at a time -- returns error if one is already in progress
- Spawns `claude login` child process using the existing `/usr/local/bin/claude` wrapper
- Captures the OAuth URL from stdout (parses for `https://claude.ai/oauth/...` or `https://platform.claude.com/oauth/...`)
- Stores the child process handle in a module-level variable
- Sends email to admin with the OAuth URL
- Returns `{ url: string }` to the dashboard
- Sets a 5-minute timeout that kills the child process if no code is submitted
- Logs `MERIDIAN_LOGIN_STARTED` to audit log

**`admin.completeMeridianLogin`** (mutation)
- Input: `{ code: string }`
- Writes the authorization code to the child process's stdin
- Waits for the process to exit
- Returns `{ success: boolean, error?: string }`
- On success: clears the provider cache so the next health check picks up the new auth
- Logs `MERIDIAN_LOGIN_COMPLETED` or `MERIDIAN_LOGIN_FAILED` to audit log

### Frontend -- enhanced `SystemHealthSection`

The existing AI Provider card in the admin dashboard gets enhanced when `aiProvider === "meridian"`:

**When healthy:**
- Shows green dot, "meridian", "Available" badge (existing behavior)
- Small text showing authenticated email from health endpoint

**When unhealthy:**
- Shows yellow/red dot, "meridian", "Unavailable" badge
- "Re-authenticate" button appears
- Clicking calls `startMeridianLogin`:
  - Shows the OAuth URL as a clickable link ("Open this link to authenticate")
  - Shows a text input labeled "Paste authorization code"
  - Shows a "Complete Login" button
- On successful completion: shows success message, card refreshes to healthy state
- On error: shows error message with retry option

**When login in progress:**
- Shows spinner with "Waiting for authentication..."
- Still shows the URL and code input

### OAuth flow (how it works end-to-end)

1. Admin clicks "Re-authenticate" in dashboard
2. Server spawns `claude login`, which generates a PKCE authorization URL with `redirect_uri` set to `claude.ai/oauth/code/callback` (the manual flow -- no local redirect server needed)
3. Server captures the URL from stdout, returns it to the dashboard and emails it
4. Admin visits the URL in their browser, authenticates with Claude
5. Claude shows an authorization code on the page
6. Admin copies the code, pastes it into the dashboard text field, clicks "Complete Login"
7. Server writes the code to the `claude login` process's stdin
8. `claude login` exchanges the code + PKCE verifier for access + refresh tokens, stores credentials in `/app/claude/.credentials.json`
9. Server confirms success, clears provider cache, dashboard refreshes

## Component 3: Notification Preferences

### Backend

- New `SystemSetting` key: `meridianNotifyInterval`
- Valid values: `"once"` (default), `"1h"`, `"6h"`, `"24h"`
- New tRPC query: `admin.getMeridianNotifyPreference` -- reads the setting
- New tRPC mutation: `admin.setMeridianNotifyPreference` -- writes the setting, logs `MERIDIAN_NOTIFY_PREFERENCE_CHANGED` to audit log

### Frontend

- New card or subsection near System Health, only visible when `aiProvider === "meridian"`
- Select dropdown with options:
  - "Once per incident" (default)
  - "Every hour"
  - "Every 6 hours"
  - "Every 24 hours"
- Saves on change via tRPC mutation

### How the poller uses it

On each unhealthy poll tick:
1. If no email sent this incident -> send immediately, record `lastEmailSentAt`
2. If email already sent -> read `meridianNotifyInterval` from DB
3. If `"once"` -> skip
4. If interval-based -> compare `now - lastEmailSentAt` against interval, send if exceeded

## Error Handling & Edge Cases

- **Email not configured:** Poller logs a warning on first unhealthy detection instead of crashing. Dashboard re-login flow still works. Health status always visible regardless.
- **Meridian not running yet:** On cold start, connection refused is treated as `unknown` (not unhealthy). Poller does not send email until it has seen at least one `healthy` state. Prevents startup email storm.
- **Concurrent login attempts:** Only one child process at a time. `startMeridianLogin` returns error if one is in progress.
- **Child process cleanup:** 5-minute timeout kills child process if no code submitted. Server shutdown also kills any active login process.
- **Poller lifecycle:** Only starts when `AI_PROVIDER=meridian`. Clears interval on process exit. Incident state resets on server restart (acceptable -- restart also restarts Meridian, first tick re-evaluates).

## Files to Create/Modify

### New files
- `src/server/lib/meridian-health-poller.ts` -- background poller + email sender
- `src/server/lib/meridian-login.ts` -- child process management for re-login flow
- `src/components/admin/meridian-auth-section.tsx` -- dashboard UI for auth status, re-login, and notification preferences

### Modified files
- `src/server/trpc/routers/admin.ts` -- new procedures: `getMeridianAuthStatus`, `startMeridianLogin`, `completeMeridianLogin`, `getMeridianNotifyPreference`, `setMeridianNotifyPreference`
- `src/app/(app)/admin/page.tsx` -- add `MeridianAuthSection` component to the dashboard
- `src/instrumentation.ts` -- new Next.js instrumentation hook to initialize the poller on server boot
- `docker/entrypoint.sh` -- no changes needed (existing `/usr/local/bin/claude` wrapper handles the login command)

### Schema changes
- None -- uses existing `SystemSetting` table with new key values
- New `AdminAction` enum values for audit log: `MERIDIAN_LOGIN_STARTED`, `MERIDIAN_LOGIN_COMPLETED`, `MERIDIAN_LOGIN_FAILED`, `MERIDIAN_NOTIFY_PREFERENCE_CHANGED`
  - These need to be added to the Prisma schema's `AdminAction` enum

## Testing

- Unit tests for poller state machine logic (healthy->unhealthy transitions, email dedup, interval math)
- Unit tests for notification preference validation
- Manual testing: stop Meridian, verify email sent, verify dashboard shows re-login UI, complete re-login flow
