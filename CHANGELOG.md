# Changelog

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
