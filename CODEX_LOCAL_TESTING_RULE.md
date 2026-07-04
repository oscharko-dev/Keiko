# Codex Local Testing Rule

This file is for Codex in this repository.

Never use GitHub Actions as the first test environment for a change.

Before pushing, force-pushing, updating a pull request, or merging:

1. Identify every GitHub quality gate that the change can affect.
2. Run the corresponding local command before the push.
3. If a GitHub gate is already red, reproduce that exact failure locally, or reduce it to the nearest
   deterministic local gate, before pushing another fix.
4. Push only after the relevant local gate is green.
5. Report the exact local commands and outcomes.

If a required gate cannot be run locally, stop and state that before any push. Do not let the remote
pull request be the first place where format, lint, typecheck, package-surface, release-evidence,
coverage, architecture, smoke, or UI tests see the change.

For UI smoke failures, run the targeted Playwright repro first, then the full affected smoke gate.

For package export or runtime surface changes, run the package build and package-surface smoke locally
before pushing.

For platform-specific evidence, do not replace CI/Linux evidence with macOS-generated values unless
the repository explicitly documents macOS as authoritative for that evidence.
