# Contributing to Nullbin

Nullbin's priorities are, in order: **security, then simplicity**. When the
two conflict, choose security, then the simpler option.

The repository is public, so nothing may depend on the code being secret.
Never commit secrets, real paste data or real tokens. Test fixtures use
generated values only.

## Changes that need explicit maintainer review

These always need an explicit review and approval from the maintainer
(enforced by [CODEOWNERS](.github/CODEOWNERS)), even for one-line changes:

- **Any new dependency**, or a dependency version change: Go modules (there
  are none, and adding one needs a discussion first), npm packages (runtime
  dependencies are only `libsodium-wrappers-sumo` and `bootstrap`, pinned to
  exact versions), GitHub Actions, base images, and CI tools. This includes
  Dependabot pull requests.
- **Crypto**: `web/src/crypto.ts`, `web/src/format.ts`, `web/src/comments.ts`, `web/src/link.ts`,
  `web/src/sodium.ts`, the blob format, key derivation, or anything that
  touches keys, passwords or plaintext.
- **Storage**: `internal/storage/`, file layout, permissions, atomicity,
  burn and expiry behaviour.
- **HTTP headers and limits**: `internal/server/` (CSP, Permissions-Policy,
  other headers, body limits, timeouts, rate limiting, client IP handling,
  logging).
- **Workflows and repository settings**: `.github/`, the Dockerfile, the
  build script and anything that affects release reproducibility.

## Rules of thumb

- Go: standard library only. Plain code over abstractions.
- Frontend: no framework, no Bootstrap JS. Never use `innerHTML` or other
  HTML-injection APIs, inline scripts, inline styles or `style` attributes.
  Show decrypted text with `textContent`. Attachment previews stay opt-in,
  fully authenticated and bounded, and show only images and plain text: no
  document renderers, parsers, workers, links, forms or scripting.
- Pages must not load anything from another origin.
- Logs must never contain IPs, paste IDs, tokens, user agents, paths or
  request bodies.
- Pin GitHub Actions to full commit SHAs. Keep `permissions: contents: read`
  at the top of every workflow. Never use `pull_request_target`.
- Install npm packages with `npm ci --ignore-scripts`.

## Before opening a pull request

```bash
npm ci --ignore-scripts
npm run typecheck && npm test && npm run build
gofmt -l . && go vet ./... && go test -race ./...
npm run test:browser
```

Add tests for new behaviour, especially for anything security-relevant
(rejection paths, limits, concurrency). Update THREAT_MODEL.md and the
README when behaviour or guarantees change.

## Releasing

`main` is the development branch. Deployments build the latest GitHub
release from source, so a release is what reaches servers.

1. Wait until CI passes on the `main` commit you want to release.
2. Tag that commit and push the tag:

   ```bash
   git switch main && git pull
   git tag -a v1.2.3 -m "Nullbin v1.2.3"
   git push origin v1.2.3
   ```

3. The Release workflow refuses tags that are not on `main` or whose
   commit has not passed CI. It then builds the tag twice, checks both
   builds are identical, and creates the GitHub release with their
   `SHA256SUMS`. Nothing prebuilt is published; servers build the release
   from source. They see the new version only after that release exists.
4. Edit the release's notes on GitHub to say what changed, especially
   security fixes and anything an update needs beyond the usual steps.

Use [semantic versions](https://semver.org): bump the patch number for
fixes, the minor number for compatible features, and the major number for
anything that breaks existing pastes, links or configuration. A tag with a
suffix (`v1.2.3-rc.1`) makes a prerelease, which install commands ignore.
Never move or delete a published tag; release a new version instead.

Report security problems privately, as described in [SECURITY.md](SECURITY.md).
