# Playwright Configs

This directory owns the Playwright harness configuration for Keiko's browser end-to-end evidence suites.

Keep issue-specific Playwright configs here instead of the repository root so the public root stays focused on product entry points, governance files, and top-level build configuration. npm scripts in `package.json` are the supported entry points for routine runs.

Each config should resolve repository paths from `process.cwd()`, use an absolute `testDir` rooted at `tests/e2e`, and set `webServer.cwd` to the repository root; this keeps the harness stable when the config file lives below this directory.

`playwright.config.ts`, the config of the `@smoke` lanes, builds the static export (`npm run build:ui`) and starts `scripts/dev-runner.mjs` with `KEIKO_DEV_UI_STATIC_ROOT`: the dev BFF serves the shipped bundle and no `next dev` starts (#4123). A Next development server compiles and serves multi-megabyte development chunks from one event loop, and on a loaded runner that loop stalled for five to ten seconds in the middle of a WebKit suite, which failed a window's first-render assertion on server load. The shipped bundle registers Keiko's shell service worker, and a page a worker controls after a reload no longer passes its requests through `page.route`, so this config blocks service worker registration (`serviceWorkers: "block"`): journey pages stay uncontrolled, as they were under `next dev`, whose development worker removed itself. Started by hand in static mode, the dev runner serves an inert worker that caches nothing, so the bundle's registration cannot reload the page in a loop. The other configs that start the dev runner keep `next dev`.
