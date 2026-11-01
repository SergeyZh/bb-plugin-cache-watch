# Changelog

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
