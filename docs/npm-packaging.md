# npm packaging

Audience: release engineers who inspect and verify the Keiko package before a publish. This document explains how to see what the tarball ships, what the surface check enforces, and the supply-chain expectations. Publishing the package is out of scope for Wave 1.

---

## What ships

`package.json` declares a `files` allowlist:

```json
"files": ["dist", "README.md", "LICENSE"]
```

So the published tarball contains only:

- `dist/` — the compiled CLI, SDK, type declarations, and the built UI assets.
- `README.md` — the package's single shipped document.
- `LICENSE` — the Apache-2.0 license text.

Repository documentation under `docs/` does **not** ship. This is why the README is self-contained and links to `docs/` for depth: a package consumer has the README, not the repository tree.

---

## Inspect the surface

`npm pack --dry-run` lists the files the tarball would contain without producing one:

```bash
npm pack --dry-run
npm pack --dry-run --json   # machine-readable file list
```

Read the output before any release. Confirm that `dist/` is present, that `README.md` and `LICENSE` are present, and that no source, `.env`, or `docs/` path appears.

---

## The surface check

`npm run check:package-surface` runs `scripts/check-package-surface.mjs` against the `npm pack --dry-run --json` file list and fails the build if the surface is wrong. It asserts the UI assets ship and that several categories never do.

It **requires**:

- `dist/ui/static/` — the built UI export.
- `dist/ui/csp-hashes.json` — the precomputed Content-Security-Policy hashes.

It **forbids**:

- A UI source map (`dist/ui/static/**/*.map`).
- An environment file (`.env` or `.env.*`).
- `ui/` source (the UI source tree must not ship; only its build output does).
- Any absolute local path in the file list.

A missing UI build is the most common failure: the check tells you to run `npm run build:ui`.

---

## The prepack chain

Both `prepack` and `prepublishOnly` run the same sequence:

```
npm run build          # tsc -> dist/
npm run build:ui       # build the UI export into dist/ui/
npm run check:package-surface
```

`prepack` runs on `npm pack` and on `npm publish`; `prepublishOnly` runs only on `npm publish`. The surface check is the last step, so the assets it asserts have already been built. The check itself runs `npm pack --dry-run` with `--ignore-scripts` to avoid re-triggering `prepack` recursively.

The UI build step expects the nested UI dependencies to already be installed. Prepare them explicitly with `npm --prefix ui ci --ignore-scripts` in a release workspace; `prepack` does not perform a hidden nested install.

To reproduce the full pre-publish state locally:

```bash
npm --prefix ui ci --ignore-scripts
npm run build && npm run build:ui && npm run check:package-surface
```

---

## License

The package is licensed under Apache-2.0. The `LICENSE` file ships in the tarball, and `package.json` declares `"license": "Apache-2.0"`.

---

## Dependency and supply-chain review

Keiko has **zero runtime dependencies**. Everything in `package.json` `devDependencies` is build- and test-time only and is excluded from the published surface by the `files` allowlist.

Supply-chain assurance is covered in CI, not by a manual step in this document:

- The dependency-review job inspects the dependency diff on every change.
- CodeQL scans the source.
- An SBOM build records the component inventory.

A zero-runtime-dependency package keeps the dependency-review surface empty for runtime code; the value of the review is in catching a dependency that should not be added.

---

## Publishing is out of scope

Wave 1 does not publish the package. The packaging surface, the surface check, and the prepack chain exist so that a future publish is verifiable, but no registry publish is part of Wave 1. When publishing is in scope, the prepack chain above is the gate that must pass first.

---

## Related documents

- [README — Packaging](../README.md#packaging) — the short summary
- [ADR-0011: Wave 1 user interface and packaging](adr/ADR-0011-wave-1-user-interface-and-packaging.md) — the packaging decisions, including the surface check
