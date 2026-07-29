# Coding-runtime development lane (macOS)

The development lane activates the managed OpenCode runtime on a **macOS repository checkout**
through production discovery and production composition — the same `buildUiHandlerDeps` path a
packaged install uses, with no injected runtime seams. It exists to end the false-green era in
which every green journey injected the runtime through test-only seams while every real
installation reported `runtimeAvailable: false` (#2475, Epic #2473 Wave 1).

Decision record: [ADR-0140](../adr/ADR-0140-macos-dev-lane-activation-of-the-managed-coding-runtime.md).

## Posture — read this before enabling the lane

The lane carries the evidence class **`functional-not-platform-qualified`**. It is a functional
activation, not a platform qualification:

- **Forgone: runtime-supervisor containment and orphan-reaping guarantees.** The release-qualified
  supervisor (ADR-0137 D5) proves complete process-tree termination before a run slot is reused.
  The dev-lane backend spawns the runtime as the leader of a fresh POSIX process group and
  terminates the group best-effort; a descendant that leaves the group survives unobserved, and
  tree exit is proven only for the direct child. This is a deliberate, documented trade-off — not
  merely a missing qualification receipt.
- **Forgone: platform signature chains.** The OpenCode payload is verified byte-for-byte against
  the review-approved redistribution catalog (`portable-runtime-approvals.json`), and the
  secure-read helper is digest-pinned at build time and re-verified on every read — but no
  Developer ID/notarization chain is evaluated. The locally built helper carries only the
  linker's ad-hoc signature.
- **Structurally confined to dev checkouts.** Discovery refuses whenever the package root carries
  a packaged-install manifest (`.portable/…`) or is not a repository checkout (no `.git` /
  `tsconfig.packages.json`). **No packaged install — Windows or macOS — can adopt this lane**;
  packaged behavior is unchanged and stays fail-closed until the Wave-5 packaged qualification.
- **Trusted-launcher opt-in only.** `npm run dev:start` is the operator's explicit selection of
  development mode and supplies `KEIKO_CODING_RUNTIME_DEV_LANE=1` to the BFF on supported macOS
  checkouts. Direct BFF startup does nothing unless the environment value is explicitly enabled
  (`1`, `true`, `on`, `yes`, `enabled`).

## Prerequisites

- macOS arm64 or x64, Node per `.nvmrc`/engines, a full repository checkout.
- Xcode Command Line Tools (`xcrun clang`) — the secure-read helper is compiled locally.
- Network access to `github.com` release assets for the one-time payload download.

## Start

```bash
npm run dev:start
```

The trusted launcher builds the packages and evaluates the same production discovery used by the
BFF. A current verified runtime is reused. When discovery reports a missing, stale, or tampered
staged artifact, the launcher runs the equivalent of `npm run dev:coding-runtime:stage`, evaluates
production discovery again, and fails the start if activation still does not succeed. The
standalone staging command remains available for deliberate pre-provisioning.

Staging writes `.portable-sidecar-payloads/<target>/`:

| Path                                       | Content                                                                                     |
| ------------------------------------------ | ------------------------------------------------------------------------------------------- |
| `opencode-compatible/payload/bin/opencode` | The pinned OpenCode 1.17.17 executable, tree-digest-verified against the approvals catalog. |
| `opencode-compatible/payload/evidence/`    | License (digest-pinned by the catalog) and generated SBOM.                                  |
| `native/keiko-secure-workspace-read`       | The locally built KSR1/KSS1 secure-read helper.                                             |
| `dev-lane-manifest.json`                   | Digest, size, source commit, and source-tree digest of the helper.                          |

At server start, discovery re-verifies everything fail-closed: catalog approval, executable tree
digest, license digest, helper digest/size, and helper source-tree freshness (a rebuilt or edited
`native/secure-workspace-read/` refuses the stale helper until you re-stage). The dev runner
exports `KEIKO_UI_PORT` to the BFF (mirroring the packaged CLI), so activation can compose its
loopback gateway URL.

`GET /api/coding-workbench/runtime/readiness?requestedMode=…` then reports
`runtimeAvailable: true`. When it reports `false`, the `runtimeUnavailableReason` names the first
failed prerequisite:

| Reason                    | Meaning                                                                                                                    | Typical fix                                                 |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `runtime-disabled`        | `KEIKO_CODING_SIDECAR_DISABLED` kill switch is set.                                                                        | Unset the kill switch.                                      |
| `platform-unqualified`    | No packaged qualification and the trusted dev launcher was not used.                                                       | Use `npm run dev:start` or a qualified install.             |
| `dev-lane-refused`        | Lane enabled, but the host is not a permitted dev checkout (packaged manifest present, no checkout markers, or non-macOS). | Run from a real macOS repository checkout.                  |
| `payload-missing`         | Staged payload or evidence files absent.                                                                                   | `npm run dev:coding-runtime:stage`                          |
| `payload-unapproved`      | Approvals catalog missing, unparseable, or redistribution not approved.                                                    | Restore `portable-runtime-approvals.json`.                  |
| `payload-tampered`        | Executable or license digest no longer matches the catalog.                                                                | Re-stage; investigate the modification.                     |
| `secure-read-unavailable` | Helper or its manifest missing, digest/size drifted, or helper source changed since the build.                             | `npm run dev:coding-runtime:stage`                          |
| `loopback-unavailable`    | `KEIKO_UI_PORT` unset or invalid in the server process.                                                                    | Use `npm run dev:start` (exports it) or export it manually. |
| `runtime-unqualified`     | Generic composition fallback (for example, no task-workspace stack).                                                       | Check server composition.                                   |

## Deployment ceiling

The coding-runtime deployment ceiling is explicit configuration, never an implicit effect of the
lane flag:

```bash
KEIKO_CODING_DEPLOYMENT_CEILING=supervised-coding \
npm run dev:start
```

- The shipped default stays `governed-assist`; unrecognized values are ignored fail-closed.
- The readiness projection reports exactly the ceiling the mint clamp enforces (before #2475 it
  reported the separate autonomous-delivery ceiling, which could diverge from enforcement).
- Mode-copy reconciliation (Epic #2473 gap-ledger row "Governed-assist copy-vs-enforcement"):
  under ADR-0138's monotonic matrix, governed-assist gates workspace-contained reads behind
  approval, while older product copy promised "reads and planning proceed". The enforcement is
  authoritative. This lane makes `supervised-coding` honestly reachable through the explicit
  ceiling above; W1.3 owns rendering the honest readiness states (including
  `runtimeUnavailableReason`) in the product UI.

## Stop

```bash
npm run dev:stop
```

The stop command gives the BFF its complete bounded disposal window so it can revoke coding
authority and terminate the managed OpenCode process group before the runner exits. It waits for
all tracked development children and reports a failure rather than claiming success while one
remains. `npm run dev:stop -- --force` is the explicit hard-stop fallback.

## Minimal gateway provider profile for Code tasks

The managed runtime routes every model call through the coding-sidecar Model Gateway. The gateway
elects the **cheapest** configured capability that satisfies all of: `kind: "chat"`,
`toolCalling: true`, `workflowEligible: true`, and `preferredUseCases` containing `"Coding"` —
and whose provider entry carries a non-empty `baseUrl` and `apiKey`. Without such a profile the
gateway (and therefore every run) fails closed with `CODING_SIDECAR_UNAVAILABLE`.

Minimal example for the gateway configuration (Settings → Models, or the gateway config file):

```jsonc
{
  "providers": [
    {
      "modelId": "coding-model",
      "baseUrl": "https://your-openai-compatible-endpoint/v1",
      "apiKey": "<stored-by-keiko-config>",
      "endpointStyle": "openai-compatible",
      "outputTokenParameter": "max_completion_tokens",
      "timeoutMs": 60000,
      "maxRetries": 2,
      "retryBaseDelayMs": 250,
    },
  ],
  "capabilities": [
    {
      "id": "coding-model",
      "kind": "chat",
      "contextWindow": 128000,
      "maxOutputTokens": 8192,
      "toolCalling": true,
      "structuredOutput": true,
      "streaming": true,
      "supportsImageInput": false,
      "supportsDocumentInput": false,
      "workflowEligible": true,
      "costClass": "low",
      "latencyClass": "standard",
      "throughputHint": "standard",
      "preferredUseCases": ["Coding"],
      "knownLimitations": [],
    },
  ],
}
```

Provider credentials never reach the OpenCode child; the child talks only to the loopback
gateway with a run-bound capability token.

`outputTokenParameter` selects the provider wire name for Keiko's bounded output budget. GPT-5 and
o1/o3/o4 model IDs infer `max_completion_tokens`; set the field explicitly when a gateway exposes
one of those models through an opaque alias, or requires the legacy `max_tokens` parameter.

## Kill switch

`KEIKO_CODING_SIDECAR_DISABLED=1` fails everything closed: activation refuses before discovery
(readiness reason `runtime-disabled`) and the gateway returns `503 CODING_SIDECAR_UNAVAILABLE`
for any in-flight composition.

## Functional acceptance journey

The env-gated production-discovery variant of the real-binary functional case proves the lane
end-to-end (activation through discovery, no injected runtime seam, real binary, real secure-read
helper, scripted model):

```bash
npm run dev:coding-runtime:stage
KEIKO_OPENCODE_DEV_LANE_FUNCTIONAL=1 npx vitest run \
  packages/keiko-server/src/coding-runtime/productionOpenCodeBackend.functional.test.ts
```

The scripted-seam case in the same file remains as the control; the staged-seam real-binary case
(`KEIKO_OPENCODE_REAL_BINARY`/`KEIKO_OPENCODE_REAL_RESOURCE_ROOT`) is unchanged.
