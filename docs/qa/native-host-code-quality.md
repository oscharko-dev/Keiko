# Pinned native-host Effect qualification

`npm run check:native-host-code-quality` qualifies the five `anti-slop-effect` rules
for the private `native/opencode-service-host` owner. The required Core quality job
runs this command without a conditional or failure override. Root lint continues
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
