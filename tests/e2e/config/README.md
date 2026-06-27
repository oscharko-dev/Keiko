# Playwright Configs

This directory owns the Playwright harness configuration for Keiko's browser end-to-end evidence suites.

Keep issue-specific Playwright configs here instead of the repository root so the public root stays focused on product entry points, governance files, and top-level build configuration. npm scripts in `package.json` are the supported entry points for routine runs.

Each config should resolve repository paths from `process.cwd()`, use an absolute `testDir` rooted at `tests/e2e`, and set `webServer.cwd` to the repository root; this keeps the harness stable when the config file lives below this directory.
