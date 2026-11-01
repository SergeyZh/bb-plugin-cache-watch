---
name: keepalive
description: Enable, stop, renew, or inspect time-limited prompt-cache keepalive for the current BB session. Use /keepalive start, /keepalive stop, or /keepalive status.
---

Manage keepalive for the current BB thread. Interpret the text after `/keepalive`
as the action: `start` (or `on`), `stop` (or `off`), `status`, or `renew`.
Use an explicitly supplied thread ID only if the user names another thread.
Otherwise obtain the current thread ID from `BB_THREAD_ID` or `bb status`.
Do not guess a thread ID or act on a different session.

- `start` / `on` / `renew`: run `bb cache-watch start <thread-id> --hours 6 --json`.
  Use the user's requested duration instead of 6 hours (range 0.25–24 hours).
  This is explicit authorization to enable paid keepalive; execute directly.
- `stop` / `off`: run `bb cache-watch stop <thread-id> --json`.
- `status`, or no action: run `bb cache-watch status <thread-id> --json`.

Keep the response short. For start/renew explain that pings are ordinary paid
turns, scheduled 5 minutes before estimated expiry, for the selected duration.
Provider expiry takes precedence; Codex without reported expiry uses an
explicitly marked 30-minute assumption after reported cache activity. Unknown
or elapsed expiry waits for fresh telemetry. No fixed 4-minute interval is used.
Renewing replaces the lease and resets counters. Stop cancels deferred pings but
does not interrupt an ongoing turn. Status never enables keepalive.

The current session also has duration, enable/renew, and stop controls in the
expanded **Cache** panel above the composer (or **Prompt cache** context card).
Do not respond to a keepalive ping by running this skill or renewing a lease;
reply `OK` only.

For control without invoking the LLM, use BB's command palette
(Cmd+Shift+P on macOS, Ctrl+Shift+P elsewhere), search for `Keepalive` and select
Show status, Enable paid keepalive for 6 hours, Renew paid keepalive for 6 hours,
or Stop keepalive. These commands target the selected session and show results
as notifications. The `/keepalive` skill itself invokes the agent/LLM.
