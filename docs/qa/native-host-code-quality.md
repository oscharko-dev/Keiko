# Pinned native-host Effect qualification

## Current status

Dev #4064 retired the Node service host under `native/opencode-service-host`. The
`check:native-host-code-quality` command, its script and the host sources no longer exist,
so this command is not a current gate. The five `anti-slop-effect` rules keep the host as a
retired scope (`retiredScopes: ["native-host"]` in `scripts/code-quality-policy.json`) with
no active scope.

The five safe and rejected Effect examples and the process, parser and output-refusal
controls remain in `scripts/__tests__/support/native-effect-quality-fixtures.mjs`, and
`scripts/__tests__/native-host-code-quality.test.mjs` runs them. Their simulated execution
results check the control logic only. They do not attest an Effect runtime or SDK execution
and do not qualify a replacement runtime.

The required Core quality job runs `npm run check:native:linux` at the position the retired
command held. That command builds the packages, then runs the existing Linux compiler,
analyzer and protocol-only scope. The default protocol-only scope does not claim kernel or
staged-release qualification. The macOS and Windows native quality jobs remain separate
requirements.

The rest of this page records the qualification as #3988 shipped it in PR #4011.

## Qualification as shipped in #4011

`npm run check:native-host-code-quality` qualified the five `anti-slop-effect` rules
for the private `native/opencode-service-host` owner. The required Core quality job
ran this command without a conditional or failure override. Root lint continues
to run the single production inventory/analyzer; fixture qualification scans distinct
accepted/rejected fixture inputs rather than repeating the production analyzer.

The host retains its exact locked OpenCode 2.0.10 and Effect 4.0.0-rc.112 inputs.
The command checks the existing approved Node archive version against the fixed host
contract, installs the private lockfile with scripts disabled, and uses the existing
service-host staging producer. That producer retains dependency integrity, generated
owner assets, Node archive digests, SBOM, licenses, provenance and tree attestation.
The portable host-only staging entrypoint reuses this producer so Linux CI does not
need to assemble the separate macOS npm runtime package. A nonempty staging target
is rejected. Local macOS full npm candidate qualification remains a distinct build proof.

The host stays **private-functional-unapproved**. Qualification adds no catalog
approval, production selector, version change, license exception or native parity
claim. Epic #3897 and issue #3908 continue to own activation/platform compatibility.
Windows and Linux ARM qualification are explicitly unsupported by this command;
this does not grant platform approval or skip a required Linux x64 CI run.

Each fixture pair is analyzed by the actual pinned parser/plugin and then executed
using the staged pinned Node and installed Effect modules. Accepted inputs must have
no Effect finding; each rejected input must produce its own rule finding. The pairs
cover selective `Effect.catchTag` recovery (an unrelated tagged error remains a failure),
`Data.TaggedError` and `Data.taggedEnum` construction, exhaustive tagged matching,
`Predicate.isTagged` in the actual host readiness operation, ordinary exhaustive matching,
and an actual `Context.Service` provided through `Layer.succeed` versus a named local
service-constructor import. Malformed syntax must fail rather than qualify.

The constructor-import rule is syntactic, not a universal service detector. Its activated
scope is this exact native owner. Ordinary factories and domain unions elsewhere retain
only raw census diagnostics; those diagnostics grant no Effect classification and cannot
block those owners through an Effect activation scope.

The real host suites exercise original authentication, routes, SSE, database/workspace
binding, sealed profiles, packet/config refusal, startup/EOF and socket cleanup. Readiness
uses the supported pinned predicate and preserves the constant `host-address-invalid`
defect for unsupported addresses. Native route-acquisition failures produce only the
existing constant `host-entry-refused` stderr verdict and publish no readiness or cause.
These prepared-host proofs do not qualify inactive productive provider/task parity.

The owning Vitest control tests qualify parser rejection, process failure handling,
runner bindings and required-lane wiring. Their explicitly simulated process-result
controls prove orchestration checks; they are not the installed-Effect execution proof.
That proof is the actual required command above. Source-bound command, artifact, audit
and hosted-check results are published on issue #3988 and its child PR. No permanent
violation baseline or exemption store is added.
