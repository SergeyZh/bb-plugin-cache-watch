# Changelog

## 0.4.1 — 2026-11-11

- Fix the status template editor reverting to the saved template when a preset
  was chosen or the text edited immediately after Save template.

## 0.4.0 — 2026-11-11

- Show how much of the first request's prompt was read from the cache
  (`first: hit 40%`, "Partly — 13,220 of 32,418 prompt tokens read from cache").
  A new session's first request reads a prefix cached by other sessions, which
  previously looked like a full hit.
- Show the number of requests in each turn in turn history and turn details.
- Price Claude Fable 5.2 ($8 / $0.20 cache read / $40 per MTok). Its turns
  previously showed no cost. Also price GPT-6 Sol ($2 / $0.20 / $10), GPT-5.6
  Terra ($2 / $0.20 / $12) and GPT-5.6 Luna ($0.20 / $0.02 / $1.20).
- Keepalive panel: the Hours field no longer resets to 6 while a lease exists;
  it shows the lease's duration, and the status line says what it was set for.
- Upgrade saved statistics once (revision 7) to add the first-request prompt
  size and the new rates.

## 0.3.3 — 2026-11-07

- Price Claude Fable 5.1 ($10 / $0.25 cache read / $50 per MTok) and Fable 5
  ($10 / $1 / $50). Fable turns previously showed no cost.
- Price Claude Haiku 5.5 with its two rate cards: $0.10 / $0.01 / $0.50 for
  prompts up to 100K tokens and $0.50 / $0.05 / $2.50 above. Claude Code
  Telemetry requests use the matching card; Claude Code turn totals above 100K
  show a range across both cards.
- Upgrade saved statistics once (revision 5), so finished Fable and Haiku 5.5
  turns get a cost from their retained reports.

## 0.3.2 — 2026-11-05

- Link the Claude Code Telemetry provider in the plugin description, and
  recommend it in expanded Cache details for built-in Claude Code sessions.
- Drop the Experimental status: the plugin is listed as "Cache Watch" and
  releases are published as regular GitHub releases.
- Fix zero read/write counts for finished turns in the panel, header, templates
  and `status`: BB keeps only a turn's last usage report, so the latest turn now
  comes from saved statistics that collected every report while the turn ran.
- Read Claude Code Telemetry's per-request cache-write lifetimes (5 minutes /
  1 hour / unknown). Show the turn split in the panel and per-request details,
  and save it with turn statistics.
- Estimate Claude Code Telemetry usage without a model (aggregate remainder) at
  the turn's only model, marked as an estimate; turns with several models stay
  unavailable. Previously almost every finished turn had no cost.
- Price 5-minute writes at 1.25× and 1-hour writes at 2× input; only writes with
  an unknown lifetime keep the 5m–1h range.
- Add session totals for 5-minute, 1-hour, and unreported-lifetime writes, and
  template variables `write5mTokens`, `write1hTokens`, and `cacheLifetime`.
- Upgrade saved statistics once (revision 4) by re-reading retained events, so
  lifetimes are recovered where BB still has the history. Reports BB has already
  dropped stay in the saved statistics.
- Show which share of turns the session lifetime split covers; format
  non-minute `cacheLifetime` values in seconds.

## 0.3.1 — 2026-11-01

- Choose between the thread context and header for cache information, with
  optional hiding until the estimated TTL reaches a configurable threshold.
- Customize separate header and context templates with time components, cache
  state, first-request hit/miss, token counts, and estimated costs. Include
  conditions, numeric formatting, presets, previews, and a compact variable reference.
- Stabilize countdown digits with monospace text. Context templates support
  selective `{{#mono}}…{{/mono}}` blocks; header colors follow the TTL estimate.
- Show response-marker costs as the midpoint of the estimated range rounded to
  two decimal places, preserving full precision and ranges in expanded details.
- Change keepalive duration controls to one-hour steps.
- Cover the new display, template, persistence, and formatting behavior with
  98 backend/frontend tests.

## 0.3.0 — 2026-11-01

- Sum cache read/write counters over the entire turn, skip duplicate usage
  notifications, and show compact rounded formulas in expanded details. Cache
  reuse refers to the first request; unknown or aggregate-only reports stay unknown.
- Add Standard API cost estimates for Codex, Central Codex, Claude Code, and
  Claude Code Telemetry, including input/output, cache reads, write-cost bounds,
  rate provenance, and explicit gaps in attribution. Estimates are not subscription charges.
- Integrate Claude Code Telemetry per-request metadata across THREAD/TURN scopes,
  first-request cache hits, actual-model Anthropic pricing, and incomplete usage.
  Mark aggregate remainders with * and omit exact-zero remainder terms;
  retain † only for incomplete observed requests. Preserve native Claude Code aggregates.
- Save usage and turn statistics in SQLite, backfill retained event history,
  and migrate historical snapshots. Show session token/cache/cost totals,
  missing telemetry coverage, separate keepalive totals, and paginated turn history.
  Conversation prompts and replies are not stored in the statistics database.
- Add Cache markers beside assistant replies with saved turn details, plus
  session statistics accessible directly from the session's Cache panel/card.
- Bound detail dialogs and composer expansion with scrolling, fix standalone
  page scrolling, and clarify session selection. Add a disclosure arrow and
  Git-style hover/focus highlighting; remove the redundant composer Close button.
- Expand regression coverage to 78 tests across accounting, persistence,
  provider integration, session controls, and disclosure behavior.

## 0.2.0

- Direct Keepalive palette commands for status, enable, renew, and stop, with
  session-bound RPC and result/error notifications; no LLM invocation.
- Enable, renew, and stop keepalive for a session from its expanded Cache panel
  or Prompt cache context card, with duration and next-ping details.
- `/keepalive start`, `/keepalive stop`, and `/keepalive status` skills for the
  current session.
- Schedule pings five minutes before estimated expiry, using provider telemetry
  or the marked Codex 30-minute assumption. Wait when expiry is unknown/elapsed
  and attempt each deadline only once until telemetry advances.
- Migrate persisted interval watches on reload; remove the `--minutes` option.
- 32 backend/frontend tests cover scheduling, migration, and session controls.

## 0.1.0

Initial experimental release.

- Thread cache summary above the composer, aligned to the right, with expandable
  read/write counts, report time, and estimated expiry.
- A context-card section, standalone Cache Watch page, RPC, and CLI.
- A locally ticking TTL countdown: green before estimated expiry, red after it.
  Codex and Central Codex use a marked 30-minute assumption when the provider
  reports cache activity without an expiry.
- Explicitly enabled paid keepalive turns with bounded leases, idle checks,
  dispatch checks, persistence, and stop controls.
- 22 backend and frontend tests, including pass-through of user messages.
