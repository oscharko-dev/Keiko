# Epic 2094 managed language intelligence regression evidence

Evidence date: 2026-07-11. Baseline: `origin/dev` at
`9ca0eca4b5b8fc5ccd59d7759e8624335c6e023d`, plus the reviewed Epic #2094 working-tree changes. The
final immutable candidate commit must rerun the same commands before delivery.

## Focused closeout result

```text
$ npm run test:managed-lsp-closeout
Test Files  25 passed | 5 skipped (30)
Tests       325 passed | 5 skipped (330)
Duration    7.99s
```

The five skips are the offline real-provider smoke files for Python, Go, Shell, Java, and Rust. No
approved real-provider directory was provisioned in this environment; no download was attempted.
The mandatory fake-protocol conformance and product-path tests all executed.

## Provider and operation matrix

`providerOperationMatrix.test.ts` pins the candidate matrix, and each provider conformance suite
initializes a real JSON-RPC session against a deterministic fake process, intersects the advertised
surface with the negotiated capabilities, executes every retained operation, and verifies bounded
sanitized results. Unsupported cells remain explicit rather than being represented as successes.

| Operation           | Python                   | Go                      | Shell                    | Java                    | Rust                    |
| ------------------- | ------------------------ | ----------------------- | ------------------------ | ----------------------- | ----------------------- |
| diagnostics         | Executed                 | Executed                | Executed                 | Executed                | Executed                |
| completion          | Executed                 | Executed                | Executed                 | Executed                | Executed                |
| hover               | Executed                 | Executed                | Executed                 | Executed                | Executed                |
| symbols             | Executed                 | Executed                | Executed                 | Executed                | Executed                |
| formatting          | Unsupported by candidate | Executed                | Unsupported by candidate | Executed                | Executed                |
| definition          | Executed                 | Executed                | Executed                 | Executed                | Executed                |
| type definition     | Executed                 | Executed                | Unsupported by candidate | Executed                | Executed                |
| implementation      | Executed                 | Executed                | Unsupported by candidate | Executed                | Executed                |
| references          | Executed                 | Executed                | Executed                 | Executed                | Executed                |
| call hierarchy      | Executed                 | Executed                | Unsupported by candidate | Executed                | Executed                |
| inlay hints         | Executed                 | Executed                | Unsupported by candidate | Executed                | Executed                |
| rename preparation  | Executed, review-only    | Executed, review-only   | Unsupported by candidate | Executed, review-only   | Executed, review-only   |
| rename apply result | Executed, no file write  | Executed, no file write | Unsupported by candidate | Executed, no file write | Executed, no file write |
| code actions        | Executed, review-only    | Executed, review-only   | Unsupported by candidate | Executed, review-only   | Executed, review-only   |
| signature help      | Executed                 | Executed                | Unsupported by candidate | Executed                | Executed                |

Rust semantic tokens are an additional negotiated lane. The sanitizer maps 10,000 tokens inside the
250 ms committed response budget and rejects malformed deltas, overlaps, out-of-range positions,
unknown token types, unsupported modifiers, oversized documents, and over-cap token arrays.

## Effective-state matrix

The state matrix is executed across `managed-lsp-activation.test.ts`, `managedLspPolicy.test.ts`,
`managedLspControl.test.ts`, `managedLspRoutes.test.ts`, `lspProcessManager.test.ts`, provider
conformance, and the real-BFF agent integration.

| State or transition | Executed evidence and closed result                                                                                            |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| default-off / unset | Five providers resolve disabled; no legacy environment variable bypasses canonical activation.                                 |
| active              | Explicit local-human activation plus provisioning, safe configuration, healthy runtime, and negotiation produces availability. |
| disabled            | Deactivation at the current revision prevents spawn and returns `PROVIDER_UNAVAILABLE` to a stale agent host.                  |
| policy blocked      | Deployment denial wins over workspace activation and produces `disabledByPolicy`.                                              |
| not provisioned     | Explicit activation remains `notProvisioned`; no process starts and no installer is offered.                                   |
| unhealthy           | Health input produces `unhealthy`; old process state is not reused.                                                            |
| capability missing  | The effective state is `capabilityMissing`, and the unnegotiated operation is not advertised or dispatched.                    |
| restart required    | Configuration identifies restart fields; only explicit restart/disposal advances the serving generation.                       |
| starting / degraded | Health projection remains typed and bounded; operation availability follows current negotiated state.                          |
| stale revision      | The write returns `STALE_REVISION` without changing state, evidence, or process count.                                         |
| stale generation    | Late exit and response events from a superseded child are discarded.                                                           |
| timeout             | Initialization and request deadlines return typed timeout codes and dispose pending work.                                      |
| cancellation        | Pre-dispatch and in-flight cancellation are typed; the real BFF propagates the agent connection close to the managed request.  |
| crash loop          | Bounded restart attempts end in `RESTART_THROTTLED`; no retry storm occurs.                                                    |
| oversized/malformed | Frames, capabilities, settings, tokens, and HTTP bodies fail closed without content reflection.                                |
| workspace switch    | Activation is re-read for the new selected root; the old workspace provider is not used as fallback.                           |
| rollback            | The immediately previous typed configuration is restored atomically and the affected pool entry is disposed.                   |

## Product-path evidence

`tests/editor-agent-managed-lsp.integration.test.ts` is the required composition test:

```text
EditorAgentToolHost
  -> EditorAgentHttpClient.action()
  -> real loopback POST /api/editor/agent/actions
  -> server-resolved /api/editor/language control plane
  -> managed activation and negotiation
  -> fake LSP stdio process
```

It proves Python diagnostics and Go definition, a root-relative Go location, no absolute workspace
root or diagnostic body in audit, review-only Python rename/code actions with byte-identical files,
stale deactivation, workspace switch, and in-flight cancellation. The test never substitutes a
direct action or language-handler call for this positive evidence.

## UI, accessibility, i18n, and visual state

`ManagedLanguageSettings.test.tsx` covers default, loading, active, blocked, not-provisioned,
unhealthy, restart-required, stale-revision, rollback, and unavailable-state rendering. It verifies
semantic controls, keyboard-operable buttons, status text that does not rely on color, and axe
results. English and German strings are owned by `managed-language-i18n.ts`; the full
`check:ui-i18n` gate detects raw or missing UI text. Styling is component-scoped in
`ManagedLanguageSettings.module.css`; the SHA-pinned global stylesheet is unchanged.

The final release claim additionally requires the full UI coverage, editor smoke/performance, and
Linux editor-release-evidence commands listed in the security/performance review. macOS-generated
editor fingerprints are not authoritative.

## Coverage and release gates

The focused suite is not a substitute for the repository green bar. Before delivery, rerun:

```bash
npm run typecheck
NODE_OPTIONS=--max-old-space-size=8192 npm run lint
npm run format:check
npm test
npm run arch:check
npm run arch:check:negative
npm run conversation:release-check
npm run test:coverage:quality
npm run check:package-surface
npm run check:adr-index
npm run check:error-observability
npm run check:security-regression-matrix
npm run check:ui-i18n
npm run check:editor-release-evidence
```

No coverage baseline, branch floor, assertion, architecture boundary, security gate, or evidence
fingerprint may be lowered to obtain a pass.

## Known limitations and follow-ups

- Mandatory CI is hermetic. Real-provider compatibility is optional per developer environment and
  must be run offline before changing an approved provider profile.
- Rust is the first semantic-token provider. Python, Go, Java, and Shell retain syntax highlighting
  until a separately reviewed semantic-token mapping is implemented and proven.
- Provider resource controls are enforcing for process launch, egress, private state, request/frame
  bounds, crash loops, and configured runtime-state quotas. They are not a general-purpose operating
  system container or a promise of perfect RSS attribution across every supported host.
- PR #2260's non-blocking M5 audit identified two source-control conflict-UX follow-ups. The
  maintainer merged that PR after the review with all 13 required checks green. They are outside
  Epic #2094's managed-language source and are not silently patched by this verification shard.
