---
name: cache-watch
description: Inspect prompt-cache usage and manage explicitly requested, time-limited cache keepalive for BB threads.
---

Use `bb cache-watch status <thread-id> --json` to read the most recent cache telemetry. Reading status does not warm the cache. Never describe the expiry estimate as confirmed current cache state.

Users can see their thread's telemetry directly in the **Cache** segment above its composer; click to expand exact counts and report time. BB's context-card layout instead shows a **Prompt cache** section. These surfaces bind to their own thread, refresh every 30 seconds, and offer manual refresh. They never enable keepalive.

The composer summary is right-aligned and includes an estimated time-left countdown, updated locally each second. Provider expiry takes precedence. For Codex and Central Codex with reported cache activity but no expiry, the display assumes 30 minutes after the latest report, explicitly marked `assumed 30m`. This display-only fallback does not change keepalive scheduling. TTL text is green before estimated expiry, red after it, and neutral when unknown. `TTL not reported` means there is no expiry estimate. Neither colors nor `Estimated TTL elapsed` confirm the live cache state.

Provider usage reports may aggregate multiple model requests within one turn. Do not describe the reported read count as the size of the live cache or assume input-token totals have identical meanings across providers.

Enable only when the user asks to keep a thread's cache warm: `bb cache-watch start <thread-id> --minutes 4 --hours 6`. Explain that this version sends ordinary paid turns visible in the transcript and asks for an OK reply. Tools are discouraged by the ping prompt, not technically disabled. Select an interval below the known TTL; do not assume a provider has an hour-long cache. The scheduler sweeps every minute. There is no silent native prewarm integration in this version.

List leases with `bb cache-watch list --json`. Stop future pings and cancel deferred pings with `bb cache-watch stop <thread-id>`; a turn already started is not interrupted. Do not respond to a keepalive by resuming prior tasks, running tools, or renewing its lease. Reply `OK` only.
