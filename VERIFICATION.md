# Verification

Checked on 2026-10-30 with BB 0.48.1, Plugin SDK 0.6.104, and Node.js 24 on macOS.
This public report omits local paths, prompts, and session identifiers.

## Automated checks

- TypeScript strict type checking.
- 22 backend and frontend tests using BB's official fake host and frontend harness.
- Public-SDK import scanning and SDK version checks.
- BB server/app bundle compilation and npm package-content inspection.
- An isolated source export built successfully after
  `npm ci --omit=dev --omit=optional --ignore-scripts`, matching Git installation
  dependency handling. The external pinned BB CLI built both server and app
  artifacts without any development dependencies in that export.

The runtime-only npm audit reported no vulnerabilities. The full development
toolchain audit reported nine findings (one moderate, seven high, one critical),
including transitive dependencies of the pinned BB CLI and its bundled npm.
These development dependencies are not installed with the plugin's Git runtime
dependencies. No breaking automatic dependency upgrades were applied.

Backend coverage includes opt-in, timing, lease expiry, ordinary activity,
busy threads, dispatch races, persistence across reloads, stop, ambiguous
failures, telemetry, deferred-ping cancellation, and input validation.
User, mixed-origin, and other-plugin messages pass through the dispatch hook
across lease states and both dispatch attempts.

Frontend coverage includes pane-specific data, automatic and manual refresh,
missing versus zero counts, retained data on errors, expandable details,
Codex's marked 30-minute fallback, and countdown/color transitions without
per-second RPC calls.

## Live UI checks

Installed by local path, built, and reloaded successfully. CLI and panel reads
were verified for native Codex, Central Codex, and Claude Code.

The composer summary displays the selected thread's data, expands exact counts,
and refreshes on demand. Browser geometry confirmed it sits five pixels inside
the right panel edge. A current Codex report showed a green countdown with
`assumed 30m`; an older report showed red `Estimated TTL elapsed · assumed 30m`.
Computed browser styles confirmed both colors. Claude Code's reported one-hour
TTL also produced a countdown. UI checks sent no prompts and enabled no watches.
The context-card surface was verified with the frontend harness; the live BB
layout used the composer banner.

## Two-ping Central Codex test

With explicit user authorization, an isolated test thread received an initial
prompt and exactly two keepalive turns from the real minute scheduler.

| Step | Input tokens | Cache reads | Cache writes | Read / input |
| --- | ---: | ---: | ---: | ---: |
| Initial | 14,542 | 0 | 14,539 | 0% |
| Ping 1 | 14,593 | 14,539 | 51 | 99.63% |
| Ping 2 | 14,644 | 14,590 | 51 | 99.63% |

Both replies were exactly `OK`, with no tool calls. The configured two-minute
interval produced approximately three minutes between pings because the
scheduler sweeps once per minute and reported activity postpones the next due
time. The lease was stopped immediately after the second dispatch. The watch
list and queued-message list were empty afterward.

## Claude Code double-send investigation

A reported first prompt completed without model work. Its raw provider event
contained `prompt_submit_outcome.kind: dropped_by_hook`, `prompt_kept: false`,
and `prevent_continuation: true`, with a reason naming `cache-watch` and asking
the user to send again. The resend proceeded normally.

The cause was the separate **Barncore/cache-watch 1.1.3 Claude Code mod**, enabled
with persisted `guard: refuse`. Its `prompt.submit` hook intentionally drops a
cold send once. Its documented `/cache-watch guard warn` command permits the
first send. BB recorded the warning as an unhandled provider event rather than
an ordinary assistant message. The BB plugin had no watches enabled and its
admission hook permits user messages; a regression test covers that behavior.
No Claude settings were changed during the investigation.

## What remains unproven

- Retention beyond provider idle expiry and net cost savings.
- Live keepalive behavior for providers other than Central Codex.
- Restart and dispatch-race behavior outside the fake-host tests.
- An exact live cache state: all TTLs are estimates.
