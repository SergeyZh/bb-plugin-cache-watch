# Cache Watch for BB

Inspect prompt-cache usage in [BB](https://getbb.app) and optionally keep selected
idle threads active with time-limited, paid keepalive turns.

Experimental version **0.1.0**. Requires **BB ≥0.48** and **Plugin SDK ≥0.6.104**.
Verified with BB 0.48.1 / SDK 0.6.104 on macOS.

## Thread panel

The right-aligned **Cache** summary above the composer shows the latest reported
cache reads, writes, and estimated time left. Click it for exact counts, report
time, expiry, and manual refresh. BB's context-card layout shows the same data
in a **Prompt cache** section. A standalone **Cache Watch** sidebar page is also
available.

- Telemetry refreshes every 30 seconds. The countdown ticks locally every second.
- TTL text is green before estimated expiry, red after it, and neutral when unknown.
- Provider expiry takes precedence. When Codex or Central Codex reports cache
  activity without an expiry, the display assumes 30 minutes after the latest
  report and marks it **assumed 30m**. This does not change keepalive scheduling.
- `TTL not reported` means no expiry estimate is available.
  `Estimated TTL elapsed` does not confirm that the cache is cold.
- Usage counts can aggregate several requests in a turn. They are not the size
  of a currently stored cache.

Viewing the panel never enables keepalive or sends a model request.

## Installation

Once the repository and first release are published:

```sh
bb plugin install git:https://github.com/SergeyZh/bb-plugin-cache-watch.git@v0.1.0
```

For compatible 0.x updates, use `@^0.1.0` instead of the exact tag. BB builds Git
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

Nothing is enabled on installation. Inspect or manage a specific thread with:

```sh
bb cache-watch status thr_example --json
bb cache-watch list --json
bb cache-watch start thr_example --minutes 4 --hours 6
bb cache-watch stop thr_example
```

**Each ping is an ordinary paid agent turn, visible in the transcript.** It
asks for an `OK` reply without tools; this is an instruction, not an enforced
sandbox. Existing agent goals or instructions can affect its behavior.
Keepalive can cost more than recreating a cache and guarantees neither a cache
hit nor savings. There is no native silent-prewarm integration.

Intervals range from 2 to 55 minutes, and durations from 15 minutes to 24 hours
(default: 6 hours). Start replaces the previous lease and resets its counters.
At most 50 watches are stored; stop expired watches to free slots.

Active threads, queued work, background agents, offline runtimes, and archived
threads are skipped. New reported usage postpones the next ping. Failed threads
and ambiguous errors pause the watch. Dispatch checks reject stale plugin pings;
user messages always pass through this plugin's admission hook.

The scheduler sweeps once per minute. A due ping can be up to a minute late,
plus provider delays. Choose an interval below the provider's actual TTL with
room for that delay. The Codex display assumption is not a known cache policy.

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
need a running server. GitHub Actions runs type checking, the **22 backend and
frontend tests**, SDK checks, and a build. See [CONTRIBUTING.md](CONTRIBUTING.md),
[VERIFICATION.md](VERIFICATION.md), and [CHANGELOG.md](CHANGELOG.md).

A live, user-authorized Central Codex test completed exactly two scheduled
keepalive turns. Both replied `OK` without tools and reported approximately
99.6% cache reads. This short test does not establish retention beyond idle
expiry or net savings.

## License

[MIT](LICENSE). Vendored UI attribution is in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
