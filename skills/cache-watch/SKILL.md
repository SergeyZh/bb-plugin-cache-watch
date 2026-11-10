---
name: cache-watch
description: Inspect prompt-cache usage and manage explicitly requested, time-limited cache keepalive for BB threads.
---

Use `bb cache-watch status <thread-id> --json` to read the most recent cache telemetry. Reading status does not warm the cache. Never describe the expiry estimate as confirmed current cache state.

Users can see their thread's telemetry directly in the **Cache** segment above its composer; click to expand exact counts and report time. BB's context-card layout instead shows a **Prompt cache** section. These surfaces bind to their own thread, refresh every 30 seconds, and offer manual refresh. Viewing them never enables keepalive; their explicit enable/renew and stop controls manage that thread, with a duration in hours.

The compact summary shows read/write sums for the latest turn through its last
usage report. Expanded details show read and write as `step 1 + step 2 + … = total`
rounded to thousands (`k`), including all-zero written sums. Per-request tables
are not displayed. Composer details have bounded scrolling; the highlighted Cache row with a
chevron toggles them open/closed. There is no separate Close button there. The overall cache-use indicator uses the FIRST
request in that turn, not its last request or the sum. Positive reads mean reuse,
zero reads mean no reuse, and missing counts remain unknown. A hit also shows the share of the first request's prompt that was read (`hit 40%`);
a new session's first request can be a partial hit on a prefix cached by other
sessions. Turn history rows show the number of requests in each turn. Writes alone are
not reuse; a reported zero write count does not prove no cache was created.
Duplicate cumulative reports are skipped. New turns wait for new usage. Missing
boundaries, counter resets and provider session changes yield unavailable sums;
lookup is bounded to 500 relevant events. Combined reports are marked and the
first-request indicator stays unknown if the first report combines requests.
Cost stays in expanded details. These facts describe recorded requests, separate
from estimated TTL. A miss does not prove expiry: prefixes/routing can change.

The composer summary is right-aligned and includes an estimated time-left countdown, updated locally each second. Provider expiry takes precedence. For Codex and Central Codex with reported cache activity but no expiry, the display assumes 30 minutes after the latest report, explicitly marked `assumed 30m`. The same expiry estimate drives keepalive scheduling, 5 minutes before expiry. TTL text is green before estimated expiry, red after it, and neutral when unknown. `TTL not reported` means there is no expiry estimate. Neither colors nor `Estimated TTL elapsed` confirm the live cache state.

Assistant replies have an independent Cache marker in their message action row.
Click it for the saved statistics of that message's turn, including first-request
cache use. Several messages in one turn share a snapshot; none of this UI edits
agent messages or prompts. To view full-session statistics in place, expand Cache in that session and click
Session statistics (also available in the Prompt cache card). Its dialog is bound
to the pane's thread, scrolls within a viewport limit, and keeps Close visible.
The standalone Cache Watch page has its own scrolling and no implicit current
thread when opened globally; choose a watch or enter a Thread ID. It shows session token/read/write
subtotals, API cost equivalents, keepalive cost/count, and paginated turn history.

Statistics persist in the plugin SQLite database. Thread event and idle/failed
listeners collect usage even without an open panel. First reads backfill all
available relevant events with a durable cursor. Missing historical telemetry
cannot be reconstructed: the UI counts unreported turns and unattributed reports
instead of silently reporting zero or a complete cost. Only known values are
summed. Codex cached tokens are already included in input. Request/response text
is not saved. Deleting a thread deletes its plugin statistics. Disabling pauses
collection, with backfill on later access for telemetry BB still retains.

The expanded panel and status JSON also show estimated latest-turn cost, cache
read savings, and input cache-hit rate for supported Codex and Claude Code models. Amounts use
provider-specific bundled Standard API short-context USD rates dated 2026-11-01. They are reference
estimates, not actual subscription, Central, or credit charges. Tools, speed,
regional and long-context surcharges are excluded. Write uncertainty produces a
range. Savings refer only to cache reads; they exclude keepalive/write costs.
Missing models, boundaries, counter resets and mid-turn fallbacks produce an
unavailable estimate. During a running turn, estimates cover reported usage so far.

Claude Code costs use Anthropic model cards and an Anthropic pricing link, not
OpenAI rates. Claude input excludes cache read/write tokens; its combined cached
counter includes reads plus writes and is not a cache-read counter. Price uncached
input, output, reads and writes separately. Unknown fields/models stay unknown.
Writes use a 5m–1h price range because BB's aggregate TTL does not expose the split.
Claude Code Telemetry reports per-request 5m/1h write lifetimes: those writes use
exact 1.25×/2× rates, and only writes with an unknown lifetime keep the range.
`turn.writeLifetimes` in `status --json` holds the turn split (`fiveMinuteTokens`,
`oneHourTokens`, `unknownTokens`); it is null when no lifetime is reported.
BB emits Claude result usage as turn aggregates: first-request reuse is unknown,
not inferred from the turn total. Provider/model/rate source and token categories
are saved across reloads; legacy snapshots rebuild from retained telemetry.

The separate `claude-code-telemetry` provider supplies per-request metadata.
Pair its THREAD-scoped `claude-code-telemetry/usage` extension event with the next
TURN-scoped usage by sequence within a turn; do not read only current extension
state. Source, message ID, actual model and incomplete are saved in each step.
Only matching complete request metadata can establish the first cache hit/miss.
Absent, malformed, stale and incomplete metadata stay conservative. `*` in the
formulas marks combined/unattributed usage; `†` marks incomplete requests, never aggregate remainders. Exact-zero remainder
terms are omitted per formula; rounded nonzero and unknown terms stay visible.
Hover shows request identity/model/cache facts. Aggregate remainders contribute
tokens but are not individual requests. A remainder without a model makes full
turn cost unavailable; observed requests use their actual Anthropic model rate.
Built-in `claude-code` remains aggregate-only. No existing sessions are migrated.

Provider usage reports may aggregate multiple model requests within one turn. Do not describe the reported read count as the size of the live cache or assume input-token totals have identical meanings across providers.

Enable only when the user asks to keep a thread's cache warm: `bb cache-watch start <thread-id> --hours 6`. Explain that this version sends ordinary paid turns visible in the transcript and asks for an OK reply. Tools are discouraged by the ping prompt, not technically disabled. Pings are due 5 minutes before the estimated expiry. Unknown or elapsed expiry waits for fresh telemetry. Each estimated deadline permits at most one attempt. Existing fixed-interval leases migrate to this policy on reload. Users can invoke `/keepalive start`, `/keepalive stop`, or `/keepalive status` for their current session. The scheduler sweeps every minute. There is no silent native prewarm integration in this version.

List leases with `bb cache-watch list --json`. Stop future pings and cancel deferred pings with `bb cache-watch stop <thread-id>`; a turn already started is not interrupted. Do not respond to a keepalive by resuming prior tasks, running tools, or renewing its lease. Reply `OK` only.

For control without invoking the LLM, use BB's command palette
(Cmd+Shift+P on macOS, Ctrl+Shift+P elsewhere), search for `Keepalive` and select
Show status, Enable paid keepalive for 6 hours, Renew paid keepalive for 6 hours,
or Stop keepalive. These commands target the selected session and show results
as notifications. The `/keepalive` skill itself invokes the agent/LLM.

## Display templates

The plugin settings include **Status templates** with separate editors for
**Thread header** and **Thread context**, presets, Save template, previews, and
a compact variable/syntax reference. Variables include `hours`, `minutes`,
`seconds`, `totalSeconds`, `state` (`warm`/`expired`/`unknown`), `firstRequest`
(`hit`/`miss`/`unknown`), `firstHit` (true/false/null), turn token counts, and
estimated USD `cost`/`costMin`/`costMax`. Use `{{seconds | pad2}}`,
`{{cost | usd:2}}`, or `{{#if firstRequest == "hit"}}✓{{else}}?{{/if}}`.
The Default preset loads the original template for that location; Save template applies it.
The template is stored by the plugin, separately from declarative CLI settings,
and survives reloads. It does not alter agent prompts or keepalive scheduling.

Context template formatting: `{{#mono}}…{{/mono}}` marks only that block as
monospace with the TTL color, for example
`Cache · {{#mono}}{{minutes | pad2}}:{{seconds | pad2}}{{/mono}} left`.
Unmarked context text uses the ordinary font. The Default context template
marks its countdown; the header retains its monospace style and omits markers.
