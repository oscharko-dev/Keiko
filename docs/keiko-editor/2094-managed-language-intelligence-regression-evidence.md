# Epic 2094 managed language intelligence regression evidence

Evidence refreshed: 2026-07-18. The final Epic #2094 audit is based on
`dev@97541fcade42a82bca3466fac714db68e1cffb8d` with Node 24.18.0 and npm 11.16.0.
The focused closeout, real-browser, and controlled orchestration lanes are green. The measured
product diff still requires fresh Linux-authoritative editor evidence and a final no-cache local
aggregate. Exact-head protected-check receipts remain mandatory before closure.

## Current closeout status

| Evidence                         | Current disposition                                                                                                                                                    |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Failure-first guard              | **PASS** — the new guard failed 4/4 before implementation: incomplete suite collection, missing browser proof, missing matrix/p50 evidence, and stale setup/M5 claims. |
| Focused closeout                 | **PASS** — 53 files and 655 tests passed; 5 optional real-provider files/tests skipped. UI continuation: 2 files and 114 tests passed.                                 |
| Provider-operation-state matrix  | **PASS** — 5 tests, including all 675 cells and fail-closed disposition invariants.                                                                                    |
| Measurement harness unit tests   | **PASS** — 5 tests cover percentiles, recursive disk bytes and error paths, all budget dispositions, controlled enforcement, and five provider profiles.               |
| Controlled orchestration         | **PASS** — `linux-arm64`, enforced wall-clock/RSS budgets, five isolated provider profiles, and zero residual disk bytes.                                              |
| Real Settings/BFF/LSP Playwright | **PASS** — 1/1 in 26.5 s through the real UI/BFF/stdio path; zero serious/critical axe violations and a preserved populated-state PNG attachment.                      |
| Linux editor release evidence    | **PENDING** — the measured product diff requires a fresh Linux-authoritative production export before publication.                                                     |
| D12 paired editor evidence       | **PENDING** — the pinned Linux producer must bind the committed candidate and independently validate every budget.                                                     |
| Aggregate gate                   | **PENDING** — the final no-cache aggregate runs after the Linux-authoritative evidence is regenerated.                                                                 |

The local receipt does not replace the required protected checks on the pushed exact head.

## Failure-first receipt

Before implementation:

```text
$ npx vitest run tests/qa/managed-language-closeout-evidence.test.ts
Test Files  1 failed (1)
Tests       4 failed (4)
```

The failures independently proved the four closeout gaps. The retained test now requires complete
LSP directory collection, the Issue #2282 Playwright config/spec, 675-cell and dual-percentile
documentation, Node/npm lockfile setup, and a current M5 disposition.

## Provider-operation-state matrix

`providerOperationMatrix.test.ts` assigns an explicit result to all 675 provider-operation-state
cells:

```text
5 providers × 15 operations × 9 effective states = 675 cells
```

| Disposition                 |   Cells | Meaning                                                                                                                                                     |
| --------------------------- | ------: | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Executed/conformance-backed |     260 | A reviewed candidate operation in `available`, `starting`, `active`, or `degraded`; provider suites must negotiate and execute the operation over JSON-RPC. |
| Unsupported by candidate    |      40 | A spawnable state, but the provider profile deliberately excludes the operation.                                                                            |
| Blocked by effective state  |     375 | `disabled`, `disabledByPolicy`, `notProvisioned`, `unhealthy`, or `restartRequired`; operation dispatch fails closed.                                       |
| **Total**                   | **675** | Every cell has one closed disposition.                                                                                                                      |

Candidate operation counts are Python 14, Go 15, Shell 6, Java 15, and Rust 15. The executable
provider suites remain the capability evidence: they initialize a deterministic JSON-RPC session,
intersect the candidate set with the live server result, execute every retained operation, and
sanitize the bounded response. The 675-cell ledger does not advertise a static candidate by itself.

| Operation           | Python                   | Go                       | Shell       | Java                     | Rust                     |
| ------------------- | ------------------------ | ------------------------ | ----------- | ------------------------ | ------------------------ |
| diagnostics         | candidate                | candidate                | candidate   | candidate                | candidate                |
| completion          | candidate                | candidate                | candidate   | candidate                | candidate                |
| hover               | candidate                | candidate                | candidate   | candidate                | candidate                |
| symbols             | candidate                | candidate                | candidate   | candidate                | candidate                |
| formatting          | unsupported              | candidate                | unsupported | candidate                | candidate                |
| definition          | candidate                | candidate                | candidate   | candidate                | candidate                |
| type definition     | candidate                | candidate                | unsupported | candidate                | candidate                |
| implementation      | candidate                | candidate                | unsupported | candidate                | candidate                |
| references          | candidate                | candidate                | candidate   | candidate                | candidate                |
| call hierarchy      | candidate                | candidate                | unsupported | candidate                | candidate                |
| inlay hints         | candidate                | candidate                | unsupported | candidate                | candidate                |
| rename preparation  | candidate, review-only   | candidate, review-only   | unsupported | candidate, review-only   | candidate, review-only   |
| rename apply result | candidate, no file write | candidate, no file write | unsupported | candidate, no file write | candidate, no file write |
| code actions        | candidate, review-only   | candidate, review-only   | unsupported | candidate, review-only   | candidate, review-only   |
| signature help      | candidate                | candidate                | unsupported | candidate                | candidate                |

Rust semantic tokens remain an additional negotiated lane with fixed vocabulary remapping and
bounded token/document/result sizes. Disabled, unhealthy, missing, malformed, or over-budget input
returns `supported: false` and preserves syntax highlighting.

## Hermetic product-path browser proof

The new `test:e2e:managed-language-closeout-2282` command owns a real Settings-to-BFF-to-process
proof. It uses no network and no route interception. Temporary external executables named
`pyright-langserver` and `gopls` run one real stdio fixture, while production code still owns
discovery, spawn, framing, initialization, negotiation, operation dispatch, health, restart,
deactivation, and disposal.

The spec covers:

- five-provider default-off presentation;
- keyboard activation for Python and Go;
- real capability negotiation and READY health;
- Python diagnostics and Go definition through `POST /api/editor/language`;
- Python Settings edit, visible restart impact, real-route rollback, restored-value presentation,
  revision/ETag-protected restart, and restored-generation negotiation;
- Go Settings edit, visible restart impact, real-route restart, and changed-generation negotiation;
- disabled Rust semantic-token fallback;
- populated-state real-browser axe and attached visual evidence;
- deactivation and typed no-fallback operation failure.

The exact Playwright command passed 1/1 in 26.5 seconds. axe reported no serious or critical
violations. The preserved `managed-language-closeout-active.png` attachment has SHA-256
`11d89fa08ce5c82eaf0bfcc7d29cdb100640cc8937bb074145a2076fd006f3f5` and shows Python and Go
active/ready with their rolled-back and changed configuration values.

The browser fixture does not seed initial configurations through an API shortcut. After activation,
the strict control response supplies complete safe typed defaults for all five languages. Settings
persists the selected default through the normal revision/ETag/idempotency guards, shows the precise
restart fields, and exposes the targeted restart while the intentionally disposed pool has no health
sample. The test performs restart and rollback through the same real guarded BFF route used by the UI.

## Per-provider orchestration measurements

`npm run check:managed-lsp-performance` now measures each provider/workspace profile independently.
It records 20 cold/disposal and 100 warm samples per provider, actual recursive disk delta, and the
process RSS delta. The 2026-07-18 `linux-arm64` run enforced the ADR-0139 budgets:

| Provider             | Cold Observed p50 | Cold Observed p95 | Warm Observed p50 | Warm Observed p95 | Disposal Observed p50 | Disposal Observed p95 |   RSS delta | Disk delta |
| -------------------- | ----------------: | ----------------: | ----------------: | ----------------: | --------------------: | --------------------: | ----------: | ---------: |
| Pyright              |          0.239 ms |          0.597 ms |          0.028 ms |          0.054 ms |              0.080 ms |              0.217 ms | 5,111,808 B |        0 B |
| gopls                |          0.110 ms |          0.178 ms |          0.020 ms |          0.035 ms |              0.043 ms |              0.064 ms | 5,767,168 B |        0 B |
| Bash Language Server |          0.087 ms |          0.276 ms |          0.015 ms |          0.033 ms |              0.031 ms |              0.052 ms | 3,932,160 B |        0 B |
| Eclipse JDT LS       |          0.075 ms |          0.131 ms |          0.013 ms |          0.028 ms |              0.027 ms |              0.039 ms |   131,072 B |        0 B |
| rust-analyzer        |          0.076 ms |          0.189 ms |          0.016 ms |          0.028 ms |              0.028 ms |              0.038 ms | 2,883,584 B |        0 B |

Committed budgets remain cold p95 250 ms, warm p95 25 ms, disposal p95 100 ms, RSS delta 64 MiB,
and disk delta 1 MiB. Disk is enforced in every mode. Wall-clock and RSS fail the command only when
`KEIKO_ENFORCE_WALL_CLOCK_BUDGETS=1` identifies a controlled measurement context. The fake provider
measures Keiko process-manager overhead, not provider-native indexing or child-process RSS.

Queueing, large document/result bounds, cancellation, initialization deadlines, crash-loop
throttling, stale-generation rejection, and disposal escalation remain executable unit/integration
evidence in the complete LSP directory. The optional real-provider files are additive and must skip
explicitly when approved offline profiles are absent.

## Security and rollback coverage

The focused collection includes planted/symlinked executable rejection, environment closure,
configuration injection, malformed/oversized frames and capabilities, server mutation requests,
descendant restrictions, crash loops, cancellation, network denial, Java import/build execution
denial, Rust build-script/proc-macro denial, Shell execution denial, evidence redaction, and private
state cleanup. The separate security/performance review records the trust-boundary disposition.

Rollback evidence covers deactivation, policy downgrade, missing binary, corrupt/schema-skewed
state, failed atomic write, unhealthy/crash-loop runtime, previous typed configuration, stale
revision/generation, cancellation, and semantic-token fallback. No rollback downloads or substitutes
a runtime.

## Accessibility, i18n, and visual state

Component tests cover semantic controls, keyboard behavior, focus restoration, every effective
state, English/German message ownership, and axe. The new browser spec adds the missing composed
Settings/BFF state, real computed accessibility tree, and image attachment. The real-browser axe
and visual lane is green with the receipt recorded above.

Styling remains component-scoped. The SHA-pinned global stylesheet is unchanged.

## Coverage and release gates

The clean aggregate receipt in `.agent/pre-pr-report.json` was produced with:

```bash
npm run agent:pre-pr -- --no-cache
npm run test:e2e:managed-language-closeout-2282
npm run check:managed-lsp-performance
KEIKO_ENFORCE_WALL_CLOCK_BUDGETS=1 npm run check:managed-lsp-performance
```

The controlled performance command belongs on the documented measurement runner, not an arbitrary
PR runner. No coverage baseline, branch floor, assertion, budget, architecture boundary, security
gate, or evidence fingerprint may be lowered to obtain a pass.

## Known limitations and follow-ups

- Exact-head protected-check receipts remain required.
- Optional real-provider compatibility requires exact operator-provisioned offline profiles; no
  download was attempted.
- Provider-native indexing latency/RSS varies by real workspace and is not claimed by the fake
  orchestration harness.
- Rust remains the first semantic-token provider; Python, Go, Java, and Shell retain syntax
  highlighting until separately reviewed mappings exist.
- The two M5 conflict-UX findings were resolved in `94fa38d42c9b9ec62e72b0464e30b5a526865bde`:
  conflict acceptance now requires conflict state, and large-file conflict scanning is disabled.
