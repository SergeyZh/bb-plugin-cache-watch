---
name: cache-watch
description: Inspect prompt-cache usage and manage explicitly requested, time-limited cache keepalive for BB threads.
---

Use `bb cache-watch status <thread-id> --json` to read the most recent cache telemetry. Reading status does not warm the cache. Never describe the expiry estimate as confirmed current cache state.

Users can see their thread's telemetry directly in the **Cache** segment above its composer; click to expand exact counts and report time. BB's context-card layout instead shows a **Prompt cache** section. These surfaces bind to their own thread, refresh every 30 seconds, and offer manual refresh. Viewing them never enables keepalive; their explicit enable/renew and stop controls manage that thread, with a duration in hours.

The composer summary is right-aligned and includes an estimated time-left countdown, updated locally each second. Provider expiry takes precedence. For Codex and Central Codex with reported cache activity but no expiry, the display assumes 30 minutes after the latest report, explicitly marked `assumed 30m`. The same expiry estimate drives keepalive scheduling, 5 minutes before expiry. TTL text is green before estimated expiry, red after it, and neutral when unknown. `TTL not reported` means there is no expiry estimate. Neither colors nor `Estimated TTL elapsed` confirm the live cache state.

Provider usage reports may aggregate multiple model requests within one turn. Do not describe the reported read count as the size of the live cache or assume input-token totals have identical meanings across providers.

Enable only when the user asks to keep a thread's cache warm: `bb cache-watch start <thread-id> --hours 6`. Explain that this version sends ordinary paid turns visible in the transcript and asks for an OK reply. Tools are discouraged by the ping prompt, not technically disabled. Pings are due 5 minutes before the estimated expiry. Unknown or elapsed expiry waits for fresh telemetry. Each estimated deadline permits at most one attempt. Existing fixed-interval leases migrate to this policy on reload. Users can invoke `/keepalive start`, `/keepalive stop`, or `/keepalive status` for their current session. The scheduler sweeps every minute. There is no silent native prewarm integration in this version.

List leases with `bb cache-watch list --json`. Stop future pings and cancel deferred pings with `bb cache-watch stop <thread-id>`; a turn already started is not interrupted. Do not respond to a keepalive by resuming prior tasks, running tools, or renewing its lease. Reply `OK` only.

For control without invoking the LLM, use BB's command palette
(Cmd+Shift+P on macOS, Ctrl+Shift+P elsewhere), search for `Keepalive` and select
Show status, Enable paid keepalive for 6 hours, Renew paid keepalive for 6 hours,
or Stop keepalive. These commands target the selected session and show results
as notifications. The `/keepalive` skill itself invokes the agent/LLM.
