# Publishing to GitHub

Releases are published to `SergeyZh/bb-plugin-cache-watch` as Git tags and
GitHub prereleases while the plugin is experimental. Version 0.3.0 adds
turn/session statistics, provider cost estimates, and Claude Code Telemetry support.

For subsequent releases, complete the checks below, commit the version, lockfile,
CHANGELOG and source changes, then push `main`. Wait for GitHub Actions to pass
before creating and pushing the matching immutable `vX.Y.Z` tag. Create a GitHub
prerelease from that tag using its CHANGELOG entry as the release notes.

## First publication

1. Create an empty GitHub repository `SergeyZh/bb-plugin-cache-watch`. Do not
   generate a README, license, or .gitignore there; these files already exist.
2. Run the checks below and confirm the intended remote with `git remote -v`.
   If publishing under another account, update the remote, package repository,
   homepage and bugs fields, and README installation URL before committing.
3. Push the prepared initial commit:

   ```sh
   git push -u origin main
   ```

4. Confirm GitHub Actions succeeds. Create and push the immutable version tag:

   ```sh
   git tag -a v0.1.0 -m 'Cache Watch 0.1.0'
   git push origin v0.1.0
   ```

5. Create a GitHub release from `v0.1.0`, mark it as a prerelease while the
   plugin is experimental, and use the matching CHANGELOG entry as its notes.
   Git installs build from source; no committed `dist/` or release binary is
   required. Users can now install the tagged source shown in the README.

## Checks before every release

```sh
npm ci --include=dev
npm run check
npm exec -- bb plugin types --check .
npm run build
npm pack --dry-run
git diff --check
```

Confirm the package includes source, skills, built app/server metadata,
LICENSE, and THIRD_PARTY_NOTICES.md. Check compatibility floors against the
oldest BB/SDK version actually verified. Inspect changes for local session data.

For later releases, update `package.json`, its lockfile, and CHANGELOG before
building and tagging. Never move a published tag: BB records its commit and
refuses changed tags. Publish a new version for fixes.

GitHub publication does not publish to npm or submit to the BB Community
marketplace. The included PLUGIN_OVERVIEW.md is ready for a future marketplace
submission. An npm release additionally needs the built `dist/` artifacts;
run the build before packing or publishing.
