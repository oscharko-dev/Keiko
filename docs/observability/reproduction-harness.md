# Reproduction harness: from a support artifact to a red-then-green test

This page is the recipe an autonomous agent (or a human) follows to turn one exported support
artifact into a failing regression test that reproduces a customer's reported defect, and then a
passing one once the fix lands. It is the operational counterpart to
[ADR-0173](../adr/ADR-0173-server-activity-log-v2-machine-reconstruction-contract.md), which
records why the underlying fields exist and what each one does and does not promise.

## The recipe: artifact → seed → replay → red/green test

1. **Get the artifact.** Either a raw `<stateDir>/logs/server.log`, or a full bundle from
   `keiko support export --out bundle.jsonl` (the bundle additionally carries store fingerprints
   and a manifest; the analyzer auto-detects which kind it was handed).
2. **Find the correlation id.** `keiko support analyze bundle.jsonl` prints every timeline in the
   file; `keiko support analyze bundle.jsonl --correlation-id <id> --json` narrows to one and emits
   it as a machine-readable `LogTimeline`. See [`README.md`](README.md#worked-example-keiko-support-analyze)
   for a worked example of this step.
3. **Build a reproduction seed.** `buildReproductionSeed(text, correlationId, generatedAt)`
   (`packages/keiko-cli/src/support-analyze.ts`) assembles everything reconstructable for that
   correlation id into one `ReproductionSeed`: the ordered `timeline`, a `gatewayScript` when the
   timeline includes a model-gateway call, an `httpRequest` seed, a `storeFingerprint` (bundle
   only), an `indexingJob` seed, `stackFrames`/`causeChain`, and — always — a `warnings` array
   naming exactly what could _not_ be reconstructed and why (starting with the standing
   by-design warning that no prompt or response body is ever logged). Read `warnings` before
   trusting that a seed is complete; a warning names the actual gap rather than the seed silently
   omitting a field.
4. **Render the gateway replay fixture, when there is one to render.**
   `renderGatewayReplayScriptFixture(seed.gatewayScript)` turns the seed's `gatewayScript` (a
   sequence of attempts — success, rate-limit, timeout, transport-error, each carrying the real
   `httpStatus`/`retryAfterMs`/`finishReason`/`usage`/`durationMs` the provider actually returned)
   into a ready-to-paste TypeScript module exporting a `GatewayReplayScriptEntry[]` literal.
   Building the literal through `JSON.stringify` on plain data (rather than hand-assembled template
   strings) means its syntax is always valid — there is no manual escaping step that could produce
   broken source.
5. **Scaffold the test.** Paste the emitted fixture into a new `*.test.ts` alongside the module
   under test, then drive the real `Gateway` through it:

   ```ts
   import { describe, expect, it } from "vitest";
   import {
     createScriptedGatewayClock,
     createScriptedGatewayFetch,
     Gateway,
     type GatewayConfig,
   } from "@oscharko-dev/keiko-model-gateway";
   import { gatewayReplayScript } from "./reconstructed-gateway-script.js"; // pasted from step 4

   function config(): GatewayConfig {
     return {
       providers: [
         {
           modelId: "example-chat-model",
           baseUrl: "https://provider.example/v1",
           apiKey: "unused-in-replay",
           timeoutMs: 30_000,
           maxRetries: 2,
           retryBaseDelayMs: 100,
         },
       ],
       circuitBreaker: { failureThreshold: 3, cooldownMs: 1000, halfOpenProbes: 1 },
     };
   }

   describe("reconstructed customer failure", () => {
     it("reproduces the rate-limit-then-success sequence the customer's bundle recorded", async () => {
       const events: unknown[] = [];
       const clock = createScriptedGatewayClock();
       const gateway = new Gateway(config(), {
         clock,
         fetchImpl: createScriptedGatewayFetch(gatewayReplayScript),
         log: { write: (event) => events.push(event) },
       });

       // Call gateway.chat(...) with the same modelId the seed's gatewayScript names, and assert
       // on the SAME outcome the timeline recorded — this is the RED step, run before the fix.
       await expect(
         gateway.chat({
           modelId: "example-chat-model",
           messages: [{ role: "user", content: "hi" }],
         }),
       ).rejects.toMatchObject({ code: "GATEWAY_RATE_LIMIT" });
     });
   });
   ```

   Passing the **same `clock` instance** to both `Gateway` and (via `GatewayClockScript`, when the
   seed's `durationMs` values matter to the assertion) the scripted fetch keeps the simulated
   retry-backoff arithmetic and the transcript's own scripted latency advancing in lockstep — the
   replay exercises the real HTTP-status-to-error-class mapping and the real retry/circuit-breaker
   code, so a regression in either is caught by the replay itself, never masked by a hand-authored
   `GatewayError`.

6. **Red, then green.** Run the test against the code as the customer ran it (see the versioning
   note below) — it must fail, reproducing the reported defect. Apply the fix; the same test must
   now pass. A test that passes before the fix proves nothing; both runs are the deliverable, not
   only the second one.

For a failure with no gateway call — an indexing job, an HTTP route, a store operation — the same
`ReproductionSeed` still carries `httpRequest`/`indexingJob`/`storeFingerprint`, each read back
from the timeline the same way; scaffold the test against the real handler or store function
instead of `Gateway`, seeded with those fields.

**Current scope, stated plainly.** `buildReproductionSeed` and `renderGatewayReplayScriptFixture`
are implemented, tested, and exported from `packages/keiko-cli/src/support-analyze.ts`, and are
also wired directly onto `support analyze` itself: `keiko support analyze FILE --correlation-id ID
--seed` prints the `ReproductionSeed` for that id (as text, or as JSON alongside `--json`), and
`keiko support analyze FILE --correlation-id ID --emit-fixture PATH` writes the pasteable
gateway-replay-script fixture straight to `PATH` instead of requiring a manual copy-paste — it
refuses to overwrite a file already at `PATH`, creates missing parent directories, and reports the
written path. `--clusters` (no `--correlation-id` required) renders the whole-file
`(category, op, errorKind)` grouping the same way. Importing the builder functions directly (from
within the `keiko-cli` package, or from its built `dist/` output) remains available for callers
that want the `ReproductionSeed` object itself rather than its rendered text/JSON/fixture form; see
[ADR-0173](../adr/ADR-0173-server-activity-log-v2-machine-reconstruction-contract.md) D9.

## Reading a Keiko-code stack frame: the dist-vs-src playbook

`extra.frames` and `extra.causeChain` entries are dist-anchored, not source-anchored:
`packages/keiko-<pkg>/(dist|src)/relative/path.(js|ts):LINE:COL`, or, for the root `keiko` bin's
own entrypoint, `(dist|src)/cli/relative/path.(js|ts):LINE:COL`. No workspace package ships
runtime source maps (`sourceMap: false` everywhere; only `declarationMap: true`) — a deliberate
decision, not a gap, made to protect the CLI's startup budget and package size.

**A frame is only meaningful against the exact tagged product version that wrote it.** The
support bundle's manifest names that version. To read a frame:

1. Check out that exact tag (`git checkout v<version>` against the Keiko repository).
2. Build it (`npm run build`) so `tsc` reproduces the same `dist/<file>.js` deterministically —
   this works because Keiko's builds are reproducible from a tag, not because the frame carries a
   source location.
3. Open `dist/<file>.js` at the named `LINE:COL`. Because the dist output was built from that
   tag's own `src/`, the surrounding code is exactly what ran; if the file's own header comment or
   adjacent context makes the corresponding `src/` location obvious, cross-reference it there for
   readability, but the dist line is the ground truth.

A future dist→src mapping — usable only for the rare case where a local `dist/*.js.map` happens to
exist — is a named, later nicety and is explicitly **not** built as part of this contract. Treat
"check out the tag, rebuild, read the dist line" as the durable playbook, not a stopgap.

## See also

- [`README.md`](README.md) — file location, rotation/retention, log level, the op catalog, and the
  correlationId/parentCorrelationId join-key workflow this recipe's step 2 depends on.
- [ADR-0173](../adr/ADR-0173-server-activity-log-v2-machine-reconstruction-contract.md) — D3 (the
  stack-frame design) and D9 (the analyzer's full output shape, including the `--clusters`/`--seed`/
  `--emit-fixture` flags described above).
