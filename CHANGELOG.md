# Changelog

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
