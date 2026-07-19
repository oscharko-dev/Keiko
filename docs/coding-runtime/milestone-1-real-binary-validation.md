# Milestone-1 real-binary validation (#2483)

## Evidence posture

The `Code task real binary` workflow is the Wave-1 anti-false-green lane. It runs nightly and by
manual dispatch on `macos-14`, stages the review-approved OpenCode 1.17.17 payload with
`npm run dev:coding-runtime:stage`, and drives the existing Milestone-1 browser journey through
production discovery and production composition. The server entry supplies no runtime resolver,
runtime ports, supervisor, or `KEIKO_OPENCODE_REAL_*` environment seam. The lane carries the
evidence class `functional-not-platform-qualified`; ADR-0140's forgone platform-signature and
complete process-tree qualification guarantees still apply.

The journey covers the real UI sequence: bind and reconcile a local repository, start a Code task,
observe the live plan/conversation/tool projection, answer the inline runtime question, apply and
verify the governed edit through the Editor changeset review, and confirm the applied managed-
worktree content. A second boot temporarily removes the staged payload directory and requires
production readiness to fail closed with `payload-missing`.

## Content-free egress observation

`scripts/run-code-task-real-binary.mjs` samples established TCP sockets owned by the exact staged
OpenCode executable while the journey runs. It hashes connection identities in memory only and
persists these bounded fields:

- sample, process, and socket-observation counts;
- distinct loopback and external connection counts;
- truncation and content/endpoint-recording booleans.

No endpoint, request body, model text, workspace path, credential, process id, or connection hash is
written to evidence. This is preliminary Wave-5 audit input, not a complete egress attestation:
sampling can miss short-lived or unsuccessful connection attempts, and it does not prove kernel-
level denial. The `EXCLUDED-POLICY` rows therefore remain excluded until the Wave-5 egress audit.

The first recorded dataset is
[`evidence/2483-first-real-binary-observation.json`](evidence/2483-first-real-binary-observation.json).
Every workflow run uploads the same schema as `code-task-real-binary-evidence` with 30-day retention.

## Runtime limits validation

Every real-binary run records two independent, content-free observations while the child is live:

1. The OpenCode run's materialized `opencode.json` declared the child model limits as context
   `32,768` and output `4,096` tokens.
2. Every observed deterministic-provider boundary request carried the gateway's effective
   `maxOutputTokens` value `4,096`; the gateway request count was non-zero.

This validates that the pinned child consumed the hardcoded launch profile during a real session and
that the Keiko gateway applied its output bound at the provider boundary. The runner fails unless it
observes the exact `32,768`/`4,096` child pair, at least one gateway request, gateway output limit
`4,096`, a successful UI journey, and the `payload-missing` negative result. Existing deterministic
gateway tests remain the enforcement for prompt and streamed/buffered output overflow behavior.

## Server consolidation and pre-PR disposition

The prior 2385 and 2386 server entries were near-duplicates. They now select fixture/runtime options
and delegate to `tests/e2e/servers/coding-runtime-server-shared.mts`; the real-binary entry uses that
same composition. There is one workspace fixture, CSP/static-UI boot, BFF assembly, shutdown, and
scripted-provider implementation.

The real-binary lane does not join `agent:pre-pr`. ADR-0145 retired that aggregate, and this lane is
macOS-only, downloads an approved external payload, and produces scheduled/dispatch functional
evidence rather than a deterministic local merge gate. The scripted Code-task lane remains the fast,
hermetic regression path.

## Capsule salvage ledger

Source capsule: `ea116e55`. No capsule file was copied wholesale.

| Capsule file                                                          | Disposition                                 | Reshaping                                                                                                                    |
| --------------------------------------------------------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `scripts/functional-opencode-2258-support.mjs`                        | Concept retained; code not copied           | Replaced its independent downloader/stager with the existing approved `dev:coding-runtime:stage` production-discovery input. |
| `scripts/launch-functional-opencode-2258.mjs`                         | Concept retained; code not copied           | Recast the child-process wrapper as the #2483 Playwright/evidence runner; removed all `KEIKO_OPENCODE_REAL_*` runtime seams. |
| `scripts/run-functional-opencode-2258.mjs`                            | Not adopted                                 | The composition-level real-binary cases remain separate; #2483 exercises the product UI instead.                             |
| `tests/e2e/functional-opencode-2258-live-server.test.ts`              | Lifecycle pattern retained; code not copied | Reused the current server-entry pattern and consolidated the two live Code-task entries before adding production discovery.  |
| `tests/e2e/config/playwright.issue-2258-live-qualification.config.ts` | Config shape retained; code not copied      | Narrowed to the existing Milestone-1 authority spec, Chromium reference browser, and one production-discovery server.        |
| `tests/e2e/coding-workbench-2258-live.spec.ts`                        | Not adopted                                 | The current #2386/#2476–#2482 journey is the authoritative full-loop browser proof.                                          |
