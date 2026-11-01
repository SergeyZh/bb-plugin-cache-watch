# Cache Watch for BB

Inspect prompt-cache usage in [BB](https://getbb.app) and optionally keep selected
idle threads active with time-limited, paid keepalive turns.

Experimental version **0.3.0**. Requires **BB ≥0.48** and **Plugin SDK ≥0.6.104**.
Verified with BB 0.48.1 / SDK 0.6.104 on macOS.

## Thread panel

The right-aligned **Cache** summary above the composer shows **read/write sums
for the latest turn**, through its last provider report, and estimated time left.
Expand it for cache use on the **first request of that turn**, exact counts,
report time, expiry, and manual refresh. Read and written each have an expanded
sum (`request 1 + request 2 + … = turn total`), rounded to thousands of tokens
(`k`). The written sum is shown even when every reported value is zero. The
composer details have a bounded scroll area. The Cache row has Git-style hover highlighting and a chevron; click the same row to collapse it. BB's context-card layout shows the same data
in a **Prompt cache** section. A standalone **Cache Watch** sidebar page is also
available.

- New turns wait for their own usage instead of showing the previous turn's totals.
- Repeated notifications with unchanged cumulative counters are not new requests.
- Unknown write counts remain unknown (`?` in sums); reported zeros remain zero.
  A zero write counter does not establish that the cache was not populated.
- Missing boundaries, counter resets, or session changes make the sum unavailable.
  The history lookup covers at most 500 relevant events. Combined reports are
  marked; first-request reuse remains unknown if the first report combines requests.
- **Hit** means the provider reported cache reads greater than zero, including
  partial reuse. **Miss** means it reported zero reads; cache writes alone are
  not reuse. Missing telemetry is shown as unreported, never as a miss.
- A hit/miss describes the recorded request(s). It does not establish the exact
  cache lifetime: a miss can also reflect changed prompt prefixes or routing.
- Telemetry refreshes every 30 seconds. The countdown ticks locally every second.
- TTL text is green before estimated expiry, red after it, and neutral when unknown.
- Provider expiry takes precedence. When Codex or Central Codex reports cache
  activity without an expiry, the display assumes 30 minutes after the latest
  report and marks it **assumed 30m**. The same estimate drives keepalive scheduling.
- `TTL not reported` means no expiry estimate is available.
  `Estimated TTL elapsed` does not confirm that the cache is cold.
- Usage counts can aggregate several requests in a turn. They are not the size
  of a currently stored cache.

Viewing the panel never enables keepalive or sends a model request.

## Saved turn markers and session statistics

Assistant messages with a turn ID have a **Cache** marker in their message action
row (shown together with the message actions). It shows cache use on that turn's
first request, total cache reads, and the estimated cost when available. Click
it to open a scrollable dialog with that specific turn's saved telemetry. User
messages have no marker. Messages belonging to the same turn share its statistics.
This UI does not change the agent's response or add content to its prompt.

Inside a session, expand **Cache** (or the **Prompt cache** context card) and
click **Session statistics**. It opens a bounded, scrollable dialog for that
pane's session, with a close button outside the scroll area. No Thread ID entry
is needed. The separate **Cache Watch** page also includes **Session statistics**: input/output tokens,
cache reads/writes, reference cost, keepalive count and cost, and expandable turn
history. The standalone page owns its scrolling; it has no implicit selected session
when opened from global navigation, so select a watch or enter a Thread ID there.
Older turns load in pages of 50; totals always cover all saved turns.
Unknown fields are excluded from known subtotals and the number of affected turns
is displayed. Reports without a turn boundary are counted separately and excluded.
Old turns whose usage reports BB no longer retains cannot be reconstructed; they
remain explicitly unreported rather than zero. Pending turns include usage so far.

Statistics use a plugin-owned SQLite database and survive plugin/server reloads.
The plugin listens for thread event updates and completion/failure events, so new
telemetry is recorded without keeping a panel open. Viewing statistics first
backfills all available relevant events in 100-event pages, with a durable cursor
for incremental updates. Duplicate events and snapshots are upserted, not summed
again. Historical turns retain their own model/rate estimate. Input tokens include
cached tokens for Codex; cached reads must not be added to input again.

Only usage, turn boundaries, model selections, and the fixed keepalive marker are
persisted; request and response text are not stored. Deleting a thread removes
its plugin statistics. Telemetry that disappeared before the plugin collected it
is unavailable. Disabling the plugin pauses collection; re-enabling can backfill
reports that BB still retains. These reads do not send model requests or enable
keepalive.

## Claude Code Telemetry

The separate `claude-code-telemetry` provider is supported alongside built-in
`claude-code`. Cache Watch pairs its THREAD-scoped usage metadata with the next
TURN-scoped usage report by sequence inside the turn, consuming each snapshot
once. It reads historical events, not only the latest extension-state snapshot.

A complete `source=request` report with a message ID establishes the first
request's hit/miss. Missing, malformed, stale, mismatched, or incomplete metadata
keeps that fact unknown. Each saved step retains source, message ID, actual model,
input/output/read/write counts and incomplete status. Existing snapshots/cursors
upgrade by re-reading retained history; missing old telemetry cannot be invented.
Only the provider's usage metadata is persisted; unrelated extension payloads are
ignored. This does not change built-in Claude Code's aggregate accounting.

The compact formulas keep their thousand-token rounding. `*` marks combined or
unattributed usage; `†` marks incomplete observed requests and is not applied to aggregate remainders.
Exactly zero remainder terms are omitted from each formula; small nonzero
remainders rounded to `0k` and unknown remainders remain visible. Hover the formula for
request models, message IDs and cache hits. No request table is added.

Costs use Anthropic rates for each observed request's reported model, including
mixed main-agent models. `aggregate-remainder` can include subagents or unseen
requests and has no reliable model: it contributes tokens, but makes full-turn
cost unavailable rather than pricing it as a fabricated request. Interrupted
requests with a reported model have observed-cost estimates only, clearly marked.
The original Claude Code provider still exposes only aggregate turn usage and
cannot establish first-request reuse.

## Cost estimates

The expanded thread panel, context card, standalone page, and `status --json`
include an estimated **latest turn cost**, **cache read savings**, and **input
cache-hit rate** for Codex, Central Codex, and Claude Code. Cost stays in expanded details. During a running turn, the estimate covers usage through the
last provider report; it updates every 30 seconds.

The calculation uses cumulative usage differences across the turn, so repeated
notifications are not charged twice and reasoning tokens are not added to output
again. It uses the model recorded for that turn, not a later model selection.
Missing boundaries, counter resets, provider session changes, mixed turns, and
mid-turn model fallbacks produce an unavailable estimate with an explanation.
The history lookup is bounded to 500 relevant events.

Claude Code uses **Anthropic** pricing and branding. Its input counter excludes
cache reads and writes: all four categories (uncached input, output, cache reads,
cache writes) are priced separately. BB's `cachedInputTokens` for Claude combines
reads and writes, so only the explicit `cacheReadInputTokens` field is used for
reuse. Missing fields remain unknown. Current BB Claude Code usage reports are
turn aggregates, not individual model requests: first-request reuse is therefore
shown as unknown. Repeated result notifications are deduplicated; bridge counter
restarts across turns do not discard that turn's reported usage.

Anthropic rates were checked on **2026-11-01** against
[Claude pricing](https://platform.claude.com/docs/en/about-claude/pricing).
Bundled cards cover Opus 5.5/5/4.8/4.7/4.6/4.5/4.1/4, Sonnet 5.5/5/4.6/4.5/4,
and Haiku 4.5, including dated IDs of those models. Unknown aliases/models have
no estimate. Write cost is a **5-minute–1-hour range** (1.25×–2× base input),
since BB's aggregate TTL cannot separate mixed write lifetimes. Missing Claude
write/read counts yield an unavailable cost rather than an assumed zero. BB does
not expose Claude SDK's reported cost here; this is a local API-rate estimate.

Provider, model, rate source/date, token categories, write range and cost are
persisted for both families. Existing snapshots are rebuilt once from saved
telemetry to correct provider-specific accounting; discarded BB usage cannot be
recovered. Historical Codex input remains inclusive of caches, unlike Claude input.

Amounts are **USD equivalents at Standard API short-context rates**, not actual
bills, Central charges, purchased-credit charges, or subscription-limit usage.
Tool fees, speed modes, regional uplifts, and long-context surcharges are excluded.
Rates were checked on **2026-11-01** against [OpenAI API pricing](https://developers.openai.com/api/docs/pricing)
and are bundled locally; viewing costs makes no external pricing or model calls.
Supported OpenAI rate cards: `gpt-6-astra`, `gpt-6.1-sol`, `gpt-6.1-terra`, `gpt-6-luna`,
and `gpt-5.6-sol` (the published promotional rate). Unknown models have no estimate.

For Codex, when cache-write lifetime is unknown, cost is a range using 30-minute and 12-hour
write rates. When write counts are missing, the lower bound treats uncached input
as ordinary input, and the upper bound allows it all to be 12-hour cache writes.
A reported zero remains zero. Cache read savings compare reading the reported
cached tokens with ordinary input at the same reference rate; they do not deduct
write premiums or keepalive costs and are not a net savings claim.

## Installation

Once the repository and first release are published:

```sh
bb plugin install git:https://github.com/SergeyZh/bb-plugin-cache-watch.git@v0.3.0
```

For compatible 0.x updates, use `@^0.3.0` instead of the exact tag. BB builds Git
installs automatically. See [RELEASING.md](RELEASING.md) for first-publication steps.

For a local source checkout, use Node.js 24 and npm:

```sh
npm ci --include=dev
npm run check
npm run build
bb plugin install .
```

The local path must exist on the BB server machine. No separate API key is
needed: ordinary turns use the thread's configured provider.

## Optional paid keepalive

Nothing is enabled on installation. Expand **Cache** above the session composer
(or **Prompt cache** in the context card) to enable, renew, or stop keepalive for
that session and select its duration. The `/keepalive start`, `/keepalive stop`,
and `/keepalive status` skills manage the current session through the agent
(and invoke the LLM).

For direct control **without the LLM**, open BB's command palette with
**Cmd+Shift+P** (macOS) or **Ctrl+Shift+P**, then search for **Keepalive**:

- **Show status** — displays the current session's state and next ping.
- **Enable paid keepalive for 6 hours**.
- **Renew paid keepalive for 6 hours** — replaces the lease and resets counters.
- **Stop keepalive**.

Commands act on the session selected when invoked, call the plugin directly,
and show results or errors as BB notifications. They are hidden without a
selected session. Use the Cache panel to choose another duration.
`/keepalive start for 2 hours` selects a different duration.

Inspect or manage a specific thread from the CLI with:

```sh
bb cache-watch status thr_example --json
bb cache-watch list --json
bb cache-watch start thr_example --hours 6
bb cache-watch stop thr_example
```

**Each ping is an ordinary paid agent turn, visible in the transcript.** It
asks for an `OK` reply without tools; this is an instruction, not an enforced
sandbox. Existing agent goals or instructions can affect its behavior.
Keepalive can cost more than recreating a cache and guarantees neither a cache
hit nor savings. There is no native silent-prewarm integration.

Durations range from 15 minutes to 24 hours (default: 6 hours). Start replaces the previous lease and resets its counters.
At most 50 watches are stored; stop expired watches to free slots.

Active threads, queued work, background agents, offline runtimes, and archived
threads are skipped. New reported usage postpones the next ping. Failed threads
and ambiguous errors pause the watch. Dispatch checks reject stale plugin pings;
user messages always pass through this plugin's admission hook.

Pings are scheduled **5 minutes before estimated cache expiry**, using the same
estimate shown in the session panel. Provider deadlines take precedence over
reported TTL; Codex without either uses the marked 30-minute assumption after
reported cache activity. This assumption is not a known cache policy. Unknown
or elapsed expiry waits for fresh telemetry. Each estimated deadline allows at
most one attempt, so a missing usage update cannot cause repeated paid pings.
The scheduler sweeps once per minute; a ping can be up to a minute late, plus
provider delays. Existing fixed-interval leases migrate to this policy on reload;
the old `--minutes` option has been removed.

Stop removes future and deferred plugin pings; it does not interrupt an ongoing
turn. Reloads preserve leases. Disable/uninstall stops scheduling, but re-enabling
can resume an unexpired lease: stop watches first if they must not resume.

## Limits and troubleshooting

Expiry derives from provider telemetry (`compactionOfferAt` or the last usage
event plus `promptCacheTtlMs`) or the marked Codex assumption. Event delivery can
lag request start. No live cache-state query is made, and a provider's long
retention policy is not assumed to be a rolling TTL.

This BB plugin is separate from **Barncore/cache-watch**, a Claude Code mod.
That mod's default `guard refuse` mode intentionally drops the first prompt
after its cache estimate expires. If installed, `/cache-watch guard warn` in
Claude Code permits the first send through. BB may record that mod's warning as
an unhandled provider event rather than display it as an assistant message.

## Development and verification

```sh
npm ci --include=dev
npm run check
npm exec -- bb plugin types --check .
npm run build
npm pack --dry-run
```

The build CLI is pinned to BB 0.48.1 in development dependencies and does not
need a running server. GitHub Actions runs type checking, the backend and frontend tests, SDK checks, and a build. See [CONTRIBUTING.md](CONTRIBUTING.md),
[VERIFICATION.md](VERIFICATION.md), and [CHANGELOG.md](CHANGELOG.md).

A live, user-authorized Central Codex test completed exactly two scheduled
keepalive turns. Both replied `OK` without tools and reported approximately
99.6% cache reads. This short test does not establish retention beyond idle
expiry or net savings.

## License

[MIT](LICENSE). Vendored UI attribution is in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
