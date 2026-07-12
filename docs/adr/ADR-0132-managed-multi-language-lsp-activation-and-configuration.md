# ADR-0132: Managed multi-language LSP activation, configuration, negotiation, and evidence

## Status

Accepted (2026-07-11). Contract foundation for Issue
[#2271](https://github.com/oscharko-dev/Keiko/issues/2271), the first child of Epic
[#2094](https://github.com/oscharko-dev/Keiko/issues/2094).

## Date

2026-07-11

## Version

1.4

## Context

ADR-0045 established staged, default-off external language-server support. ADR-0067 kept the
language capability registry authoritative. ADR-0068 separated browser-local editor features from
server language-service capabilities. ADR-0069 introduced the governed long-lived process manager,
and ADR-0119 expanded the shared operation vocabulary for navigation and refactoring. Those decisions
did not define a product activation control plane, persisted per-workspace runtime configuration,
negotiated capability snapshots, bounded semantic-token wire shapes, or activation evidence.

ADR-0045 covered four staged languages: Python, Go, Java, and Rust. Epic #2094 adds Shell as a fifth
existing managed provider, and the maintainer confirmed the complete rollout order
**Python → Go → Shell → Java → Rust**. SQL is not part of Epic #2094 even though an unavailable SQL
descriptor exists in the broader language registry.

The existing `LspProcessStatus.READY` mapping in ADR-0069 D5 is process-manager status, not enough to
prove product availability. A ready process can still be disabled by policy or workspace setting,
stale against a newer configuration revision, missing a required negotiated operation, dynamically
unregistered, or degraded by health. Treating `READY` as product-level availability would bypass the
new activation ceilings and over-advertise behavior.

M7/#2095 also plans editor settings. The managed-LSP configuration model therefore has to be the one
canonical server-owned settings/control-plane seam that M7 extends and renders. M7 must not create a
second editor settings store, per-language activation registry, precedence model, or ETag scheme.

## Decision

### D1 — Exactly five managed languages and one server-owned control plane

`ManagedLspLanguage` is the closed union `python | go | shell | java | rust` and
`MANAGED_LSP_LANGUAGES` is frozen in rollout order. Unknown languages, including SQL, fail closed.

The server owns effective activation, policy application, persisted workspace configuration,
revision/ETag checks, provisioning state, negotiated capability snapshots, runtime health, restart,
rollback, and evidence projection. The UI is a same-origin client and never becomes the source of
truth. Provider children #2276, #2275, #2277, #2278, and #2279 consume these contracts; they do not
invent per-language control planes.

TypeScript and JavaScript remain on the in-process provider and are not represented as managed
external runtimes. No server route, persistence implementation, process behavior, or UI is introduced
by #2271.

### D2 — Effective activation is a deterministic minimum and defaults off

The closed effective states are:

`disabled | disabledByPolicy | notProvisioned | available | starting | active | degraded |
unhealthy | restartRequired`.

Resolution applies this precedence, stopping at the first decisive downgrade:

| Order | Input | Effective result |
| ----- | ----- | ---------------- |
| 1 | Product does not support the language | `disabled / PRODUCT_UNSUPPORTED` |
| 1a | Canonical state is unavailable or rejected | `disabled / STATE_UNAVAILABLE` |
| 2 | Deployment policy denies it | `disabledByPolicy / POLICY_DENIED` |
| 3 | Legacy environment explicitly disables it | `disabledByPolicy / LEGACY_ENV_DISABLED` |
| 4 | No approved runtime is provisioned | `notProvisioned / NOT_PROVISIONED` |
| 5 | Workspace activation is disabled or unset | `disabled / WORKSPACE_DISABLED` or `WORKSPACE_ACTIVATION_UNSET` |
| 6 | Eligible but no process has started | `available / AVAILABLE` |
| 7 | Startup/initialization is in progress | `starting / STARTING` |
| 8 | A required capability was not negotiated or was unregistered | `degraded / NEGOTIATED_CAPABILITY_MISSING` |
| 9 | Runtime health is unhealthy, degraded, or unknown | `unhealthy` or `degraded` with the matching health reason |
| 10 | Healthy runtime serves an older restart-required configuration | `restartRequired / RESTART_REQUIRED` |
| 11 | Every ceiling is satisfied for the current revision | `active / ACTIVE` |

The legacy environment layer is deployment compatibility input, not persisted user configuration.
An explicit legacy disable is a ceiling. Legacy enablement can make a compatibility input available
to resolution but can never enable a disabled/unset workspace setting, bypass policy, supply an
unapproved runtime, fabricate negotiation, or override unhealthy state. Unknown enum members, unknown
fields, malformed inputs, and schema skew resolve to `disabled / INVALID_INPUT` with a denied result.

Status parsers validate state/reason/policy consistency as well as enum membership. For example,
`active + denied`, `disabled + ACTIVE`, and `unhealthy + ACTIVE` are invalid wire states.

### D3 — Settings source precedence is explicit; policy is always re-applied as a ceiling

Setting source order, from lowest to highest, is:

1. `builtInDefault`
2. `legacyEnvironment`
3. `operatorProvisioning`
4. `workspace`

The source resolver selects the highest present value deterministically. Effective activation then
re-applies product support and deployment/legacy-denial ceilings, so source precedence cannot widen
policy. `ManagedLspConfigurationProvenance` records source separately for activation, runtime, and
language settings. Its type permits `legacyEnvironment` only for activation. Runtime identity and
language settings structurally exclude legacy environment as a persisted source.

Every runtime reference is `{ kind: "operatorApproved", runtimeId }`: a bounded opaque identity, not
an executable name or path. Every configuration path is
`{ kind: "workspaceRelative", path }`, bounded to 4,096 bytes and lexically contained with no
absolute, drive, backslash, empty-segment, dot, dot-dot, or NUL form. There is no argv field, command
line, environment map, executable path, shell expression, endpoint, or credential field.

### D4 — Complete per-language runtime configuration is typed and bounded

All five language settings are discriminated by `language` and reject unknown fields recursively.
Lists are capped, unique where ordering does not carry meaning, and composed only of bounded tokens or
contained path wrappers.

**Python / Pyright**

- approved interpreter identity and optional approved venv identity;
- closed `basic | standard | strict` type-checking mode;
- up to 32 contained extra paths and one optional contained configuration file;
- fixed configuration precedence:
  `workspaceConfiguration → pyproject → builtInDefault`.

**Go / gopls**

- approved Go toolchain identity;
- up to 32 bounded build tags;
- typed build flags only: module mode `readonly | vendor` and `trimPath` boolean;
- closed supported GOOS/GOARCH target plus bounded minimum Go version;
- up to 32 contained include/exclude directory filters and an optional contained `go.work` path;
- `dependencyMode: offline` and `moduleDownloads: false` are mandatory.

**Shell / Bash Language Server and ShellCheck**

- closed `posix | bash` dialect and `sourcePolicy: workspaceOnly`;
- ShellCheck mode `disabled | workspace` and closed severity `error | warning | info | style`;
- up to 32 `SCdddd` exclusions and 32 contained include paths;
- `externalSources: false` is mandatory. No shell argv, sourcing of host paths, or environment map is
  representable.

**Java / Eclipse JDT LS**

- approved JDK identity;
- closed source/target levels (`8`, `11`, `17`, `21`, `25`) with source not newer than target;
- up to 128 contained classpath entries, 32 contained project roots, and an optional contained
  configuration file;
- only `projectImport: safeOffline`; build-tool execution, annotation processing, and dependency
  downloads are literal `false`.

**Rust / rust-analyzer**

- approved Rust toolchain identity;
- up to 64 bounded features, 64 bounded structured cfg values, one bounded target token,
  `noDefaultFeatures`, and up to 32 contained linked `Cargo.toml` projects;
- sysroot policy is `disabled | approvedToolchain`, never a raw path;
- explicit bounded resource budget: project-file count, Cargo-metadata bytes, memory MiB, and indexing
  deadline;
- Cargo metadata is `disabled | offline`, dependency downloads are false, and build scripts and
  procedural macros are literal false. Execution-requiring fidelity is therefore unavailable in
  this contract and cannot be activated by a string flag.

Python, Go, and Shell defaults permit no download and no project-code execution. Java and Rust remain
in their safe modes unless a future ADR-0043-compatible isolation amendment introduces a separate,
attested contract; silently broadening these fields is prohibited.

### D5 — Revision, ETag, restart, rollback, and reset semantics

Every configuration snapshot carries a non-negative revision and a strong, revision-bound ETag of the
form `"lspcfg-<revision>-<opaque>"`. Updates must match both revision and ETag. A mismatch is a stale
write and is rejected; last-write-wins is prohibited.

Activation-only changes apply to the control plane immediately: disabling disposes/withdraws the
provider, and enabling enters provisioning/startup resolution. Changes to the approved runtime or any
language setting are restart-required. `restartRequired` must equal whether the unique
`restartFields` list (`runtime`, `settings`) is non-empty.

Negotiated snapshots are tied to `configurationRevision`. Until a successful restart negotiates a
snapshot for the new revision, the old snapshot must not advertise the new configuration as active.
A failed restart leaves the desired revision restart-required/unhealthy and retains the last
known-good configuration for explicit rollback. Rollback is a new monotonic revision referencing the
last known-good bounded values; revisions never move backwards. Reset removes the workspace layer and
re-resolves operator/default inputs under the same policy ceiling. Neither rollback nor reset widens
policy or restores dynamically unregistered operations.

### D6 — ADR-0069 `READY` is raw process health, never product availability

This decision additively amends ADR-0069 D5. `LspProcessStatus.READY` means only that the supervised
stdio process initialized and is responsive at the process-manager layer. The legacy
`lspStatusToProviderDescriptor(READY)` mapping is a raw process descriptor used inside that layer; it
must not be surfaced as effective product availability by the managed activation control plane.

Product `active` requires the full D2 resolution and a negotiated snapshot matching the current
configuration revision. All other process states remain unavailable raw health signals. This
amendment preserves ADR-0069 spawn hardening and does not alter the existing process contract.

### D7 — Static candidates and negotiated snapshots are separate, closed contracts

`ManagedLspCandidateCapabilities` is static provider metadata: language, candidate operation list,
and whether semantic tokens are a candidate. It cannot prove live support.

`ManagedLspNegotiatedCapabilitySnapshot` is a separately versioned runtime fact tied to language and
configuration revision. Negotiated and dynamically unregistered operation lists must be unique
subsets of static candidates and disjoint from each other. An operation is advertised only when it is
known to the shared `LanguageServiceOperation` vocabulary, negotiated, and not dynamically
unregistered. Unknown operations, unrequested registrations, schema skew, and server capability bags
with unknown fields fail closed.

Shell provider metadata is first-class and uses its existing diagnostics/completion/hover/symbols
candidate family. SQL cannot be represented. Provider children may narrow candidate lists based on
conformance; they must never widen live advertisement without negotiation and proof.

### D8 — LSP 3.18 compatibility posture is fail closed

Keiko targets LSP 3.18 semantics while accepting bounded compatibility snapshots for 3.17 and 3.18.
Unknown/future protocol-version strings fail closed until reviewed. The server sends only the client
capabilities it implements, sanitizes the initialize result into the negotiated snapshot, and keeps
dynamic registration in the closed shared operation vocabulary.

`workspace/configuration` responses in later child #2273 must project only the bounded D4 settings.
Server-initiated apply-edit, show-document, execute-command, arbitrary workspace configuration,
telemetry bodies, and custom command authority are denied. Cancellation, shutdown/disposal, frame
caps, deadline, restart-throttle, ephemeral HOME, env allowlist, and executable-outside-workspace
controls from ADR-0069 remain mandatory.

### D9 — Semantic tokens are Monaco-safe, versioned, bounded, and explicitly truncating

The semantic-token legend maps server token types/modifiers into frozen, closed Monaco-safe
vocabularies. Legends carry an independent positive version, returned/total type and modifier counts,
and an honest truncation flag. Unknown/duplicate mappings and over-cap legends fail closed (maximum 64
types and 16 modifiers).

Token data uses the LSP five-integer delta encoding, is tied to legend/document/data versions, and is
limited to 10,000 tokens. Every tuple validates non-negative deltas, positive length, legend index,
and modifier bitset. Returned/total counts must match data length and truncation exactly. Malformed,
over-cap, stale-legend, or unknown-field payloads are rejected rather than partially interpreted.

Initial semantic-token candidate decisions are explicit but do not advertise support:

| Language | Static decision for #2280 | Live rule |
| -------- | ------------------------- | --------- |
| Python | Candidate for measured rollout | Negotiated + mapped + bounded only |
| Go | Candidate for measured rollout | Negotiated + mapped + bounded only |
| Shell | Out initially | `semanticTokensCandidate: false`, `supported: false`, no legend |
| Java | Candidate for measured rollout | Negotiated + mapped + bounded only |
| Rust | Candidate for measured rollout | Negotiated + mapped + bounded only |

Large-file policy may lower the returned-token cap or disable semantic tokens, but may never raise the
contract cap. At least one language requires measured quality/performance evidence before enablement.

### D10 — Activation and lifecycle evidence is content-free by construction

Activation-change and lifecycle evidence carry only: schema/kind, closed action and outcome, actor
class, managed language, prior/effective state, reason code, configuration revision, timestamp, and
policy result. Actions are `activate | deactivate | configure | reset | rollback | restart |
lifecycle` — `restart` covers the explicit restart transition defined in D12; outcomes are
`accepted | denied | noOp | failed | conflict`. Actor, language, state, reason, kind, action,
outcome, and policy result are closed unions; no field accepts an arbitrary string. The parser
validates effective state/reason/policy consistency and rejects every unknown field.

There is no representable path, environment value, source text, stderr, command line, endpoint,
request/response body, server method, or credential. Sentinel and type-level tests pin this invariant.
Raw `LspLifecycleEvent` remains process-internal evidence under ADR-0069; the managed control plane
projects it into this narrower product evidence instead of exposing raw process configuration.

### D11 — The #2272 control plane is canonical, atomic, and dispatch-enforced

Issue #2272 implements one schema-versioned record per canonical workspace. The record is stored in
Keiko's private runtime-state directory, which must remain outside the selected workspace, and is
named only by a SHA-256 workspace fingerprint. Reads reject symlinked, oversized, corrupt,
unreadable, unknown-version, or workspace-contained state. Missing and rejected state resolves every
language to default-off and cannot authorize a process spawn.

`KEIKO_EDITOR_LSP_POLICY_<LANGUAGE>` is the deployment ceiling. Closed allow-like values permit
workspace evaluation; closed deny-like values deny; malformed values deny. The legacy
`KEIKO_EDITOR_LSP_<LANGUAGE>` flags remain compatibility inputs exactly as D2 defines and cannot
authorize a missing workspace activation. The production language-operation and capability paths
consult this control plane before bypassing the legacy activation flag; command policy,
executable-outside-workspace, and provisioning checks remain mandatory.

The same-origin `GET/PUT /api/editor/lsp/settings` seam reuses the BFF Host/Origin, JSON, and CSRF
gates plus selected-root realpath containment. Writes require a strong revision-bound `If-Match`
value and a bounded `Idempotency-Key`, run under a workspace/language mutex, and reject stale writes
without changing state, evidence, or a process. A committed activation/configuration change writes
the new state and bounded content-free transition journal in one private atomic replace before
evicting only the affected pool entry.

The co-persisted journal is the canonical reviewable evidence, so a secondary evidence-store
projection failure cannot leave an enabled provider without durable transition evidence. Projection
is idempotent under the opaque workspace fingerprint and failure emits a redacted operator
diagnostic. Idempotency keys and request bodies are never persisted; only their SHA-256 digests and
closed replay outcome are retained in a bounded window.

### D12 — Product status projection and explicit restart are server acknowledged

The workspace Settings surface consumes the canonical control snapshot plus health and negotiated
operations filtered for the selected real workspace. The browser never derives support from a
language name or static candidate array and never stores managed language state in local storage.
Every mutation carries the current strong ETag, revision, idempotency key, CSRF header, and an abort
signal. Activation, configuration, deactivation, reset, rollback, and explicit restart update the UI
only after server acknowledgement and a fresh snapshot read.

An explicit restart is a first-class, evidence-bearing transition. It advances the canonical
revision, atomically clears acknowledged restart impact in a validated configuration, and disposes
only the selected workspace/language pool entry. Policy-disabled and unprovisioned providers cannot
be activated by the UI. Settings copy, capability lists, health summaries, and runtime fields are
bounded and content-free; executable paths, environment values, stderr, and secrets are not exposed.

### D13 — Pyright is an operator-provisioned, configuration-only provider

Python uses `pyright-langserver --stdio` from the operator-approved `python-lsp` runtime. The
executable must resolve outside the workspace and pass command policy. Python-specific ambient
variables, including `PYTHONPATH` and `VIRTUAL_ENV`, are never inherited. Interpreter and venv
selections remain opaque approved identities; they are not executable paths and are not sent across
the protocol boundary.

The protocol projection contains only bounded `python.analysis` settings. Automatic search paths
are disabled, diagnostics are limited to open files, and additional paths are validated
workspace-relative values. A contained regular `pyrightconfig.json` of at most 1 MiB takes
precedence over an equivalently bounded `pyproject.toml` with `[tool.pyright]`; governed workspace
settings are the fallback. Detection exposes only the source class, never file bodies or paths.

Pyright's candidate operations include the shared navigation and review-only refactoring families,
but the product executes and advertises only the live negotiated subset. Rename and code actions
produce bounded review artifacts and cannot write project files. Configuration changes and rollback
evict only the Python pool entry. Provider version changes require fake-protocol conformance and an
offline operator-run real-server smoke before deployment approval.

### D14 — gopls is offline by construction and build settings are closed

Go uses operator-provisioned gopls and Go binaries outside the workspace. Every gopls child receives
fixed `GOENV=off`, `GOPROXY=off`, `GOSUMDB=off`, `GOTOOLCHAIN=local`, and `GOVCS=off` values after the
copy-only environment is built. Ambient Go flags, workspace/cache roots, and toolchain selection are
not inherited. Workspace configuration cannot widen these values.

The gopls projection is limited to validated build tags, module mode, trim-path choice, target,
contained directory filters and workspace file, and static analysis. Vulnerability checking,
external hover links, provider-side subdirectory watching, and module-cache import indexing are off.
Keiko sends bounded document/configuration notifications; missing vendored or locally provisioned
dependencies degrade without network repair. Project tests, generators, binaries, and documentation
servers are never executed.

Candidate operations include formatting, navigation, inlay hints, and review-only refactoring, but
only the negotiated subset executes or appears in product status. Provider configuration paths must
resolve inside the canonical workspace before persistence or spawn. Version changes require the
shared fake conformance and an offline operator-provisioned real smoke.

### D15 — Shell analysis has a private descendant-tool boundary

Shell uses operator-provisioned Bash Language Server `5.6.0`, Node 22, and ShellCheck `0.11.0`
binaries outside the workspace. Resolving the top-level server is insufficient because it launches
ShellCheck itself. Keiko therefore constructs an ephemeral PATH containing links to only the
realpath-validated Node and ShellCheck binaries. The PATH is replaced, never extended. Workspace
shadowing, missing tools, policy denial, and link creation failure all fail closed; the private path
is removed on crash, restart, and disposal. Process-group termination continues to cover every
descendant.

The protocol projection maps only closed dialect, severity, SC-code exclusions, and contained source
paths. External sources, explainshell, background workspace analysis, shfmt, and editorconfig-driven
formatting are disabled. Startup profile variables and arbitrary environment values are not copied.
Opening a shell document sends text over LSP only: Keiko never invokes its shebang, substitutions,
traps, package manager, formatter, or commands.

Candidate operations are diagnostics, completion, hover, document symbols, definition, and
references. Rename and formatting remain absent even if a server version advertises them. Live
negotiation may narrow the set further. Provider changes require hostile no-execution fixtures,
private-PATH and process-tree tests, bounded diagnostics/cancellation/crash proof, and an optional
offline real-server smoke against pre-provisioned pinned binaries.

### D16 — JDT LS is standalone, offline, and isolated per workspace

Java targets operator-provisioned Eclipse JDT LS `1.60.0` and a separately approved JDK. The JDK
that runs JDT LS must be version 21 or newer; this runtime requirement is independent of the bounded
Java source and target levels selected for workspace analysis. Keiko validates the approved JDT LS
layout, platform launcher, and JDK identity outside the workspace. Neither workspace settings nor
environment variables may supply an executable path, launcher JAR, arbitrary JVM argument, Java
agent, system property, classpath string, or environment override.

Each workspace/language process receives private, permission-restricted, quota-bounded
`-configuration` and `-data` directories under Keiko runtime state. Both directories are unique to
the canonical workspace and process generation, never reuse the operator home or the immutable JDT
LS distribution configuration, and are removed on disposal or reset. Restart creates a fresh pair;
crash recovery cannot adopt another workspace's state. Failure to create, contain, restrict, account
for, or clean either directory fails activation closed and emits only content-free lifecycle
evidence.

The only current import posture is `safeOffline`. Keiko opens contained Java sources in JDT LS
standalone mode and projects only the closed D4 Java settings. Maven and Gradle project import,
wrappers, build plugins, init scripts, annotation processing, artifact and source downloads,
automatic build-configuration updates, build execution, and provider-initiated external commands
are disabled. Missing dependency or project-model information degrades analysis locally; Keiko does
not repair it by enabling import, running project code, or accessing the network. Contained,
operator-provisioned classpath entries may improve standalone analysis without widening execution
authority.

Server-initiated `workspace/executeCommand` and `workspace/applyEdit` requests are denied at the
protocol boundary. Refactoring and code actions remain bounded review artifacts and cannot modify
the workspace. Static Java candidates are only an upper bound: the product executes and advertises
the live negotiated subset that the Java conformance suite proves. Disposal, cancellation, restart,
cache quotas, and process-group termination continue to use the shared governed process lifecycle.

The Java provider implementation and its failure-first tests, not this decision text, substantiate
the launch, isolation, no-execution, no-network, negotiation, and cleanup claims. A real JDT LS smoke
is optional, offline, and limited to an operator-provisioned pinned runtime. It may add compatibility
and performance evidence but cannot replace the hermetic security and conformance suites. Any future
Maven or Gradle fidelity that requires execution needs a separate ADR-0043-compatible amendment with
an enforced network, filesystem, process, and environment boundary plus automated attestation; D16
does not authorize that widening.

### D17 — rust-analyzer is offline and non-executing by default

Rust targets operator-provisioned rust-analyzer `2026-07-06` with the approved Rust `1.97.0`
toolchain profile. The server binary, Cargo, rustc, sysroot, standard-library sources, target
components, linked-project manifests, and all required crate sources are provisioned outside the
workspace before activation and verified against the trusted operator inventory. Keiko never runs
rustup, downloads a component or crate, contacts a registry or VCS source, or adopts ambient
`CARGO_HOME`, `RUSTUP_HOME`, Cargo configuration, registry replacement, credential, wrapper, or
environment state.

The default Rust profile is deliberately non-executing. Keiko projects
`cargo.buildScripts.enable=false`, `procMacro.enable=false`, `checkOnSave=false`, no runnable command
surface, and closed offline/no-dependency metadata behavior. It does not expose check, test, run,
bench, debug, build-script, proc-macro, rustc-wrapper, Cargo override-command, or arbitrary command
execution. Hostile `build.rs`, procedural macros, `.cargo/config.toml`, source replacements,
wrappers, workspace environment values, and symlink escapes are inputs to analysis only and cannot
widen authority.

The typed configuration is limited to bounded feature names, target triple, cfg key/value pairs,
`noDefaultFeatures`, contained linked `Cargo.toml` paths, an approved-toolchain-or-disabled sysroot
policy, and server-owned project-file, Cargo-metadata, memory, disk, and indexing deadlines. It
cannot carry Cargo/rustc arguments, executable paths, arbitrary environment maps, registry URLs,
credentials, source-replacement configuration, host paths, downloads, build scripts, or procedural
macros. Approved sysroot and toolchain locations are immutable, workspace-external provisioning
facts; isolated runtime caches are private, quota-bounded, content-free in evidence, and removed on
reset, rollback, or disposal.

Rust activation additionally requires an enforced and current `network:none` boundary whose
filesystem, process, environment, toolchain, workspace, runtime-cache, and policy identities match
the requested provider generation. Missing, stale, mismatched, or incomplete attestation fails
closed before spawn. This boundary is mandatory even in the non-executing profile because Cargo
metadata, rust-analyzer, and toolchain components must not gain ambient egress or host-state access.
The profile does not authorize execution fidelity: enabling build scripts, procedural macros,
checks, or runnables requires a separate ADR-0043-compatible decision, explicit human-reviewed
opt-in, and stronger execution-specific isolation and attestation.

Reduced fidelity is expected. With build scripts and procedural macros disabled, generated code,
macro expansion, target discovery, and build-derived cfg values can be incomplete; `cargo.noDeps`
or unavailable pre-provisioned crate sources can also narrow cross-crate analysis. Keiko reports
that degradation and never repairs it by running code, changing Cargo configuration, enabling a
download, or widening the sysroot. Static Rust operation candidates remain only an upper bound:
navigation, formatting, review-only refactoring, implementation and call hierarchy, inlay hints,
and semantic features execute and appear in product status only when the pinned server negotiates
them and provider conformance proves the bounded result mapping.

The Rust provider implementation and failure-first tests, not this decision text, substantiate the
no-execution, no-network, containment, negotiation, cancellation, crash-loop, quota, cleanup, and
performance claims. An optional real-server smoke may run only against the pre-provisioned pinned
profile under the same enforced boundary. It records body-free version, hash, count, latency,
memory, disk, cancellation, and cleanup evidence and cannot replace hermetic hostile-workspace,
protocol-authority, or isolation tests.

### D18 — Cross-language operations are negotiation-gated and semantic tokens roll out by evidence

The shared managed-LSP vocabulary contains fifteen standard operations. Go, Java, and Rust currently
have all fifteen as provider candidates; Python has fourteen because formatting remains out; Shell
has only diagnostics, completion, hover, document symbols, definition, and references. Candidate
metadata is an upper bound, never a product
claim. A cell is available only when the live server negotiates the corresponding capability and
the provider conformance matrix proves its request mapping, bounded sanitizer, malformed-response
handling, cancellation, and consumer or explicit unsupported disposition. Standard LSP operations
must not be classified as TypeScript-only. Unproven, dynamically unregistered, stale, unhealthy, or
policy-disabled cells remain absent and the UI falls back without inventing support.

Rename and code-action results remain review artifacts. Their sanitizers enforce canonical
workspace containment, expected-content hashes, explicit truncation state, bounded edit counts and
sizes, and explicit human save. Resource operations, command-bearing results, cross-workspace edits,
missing preconditions, automatic application, and automatic persistence are rejected. Navigation,
hierarchy, inlay-hint, and semantic-token results are likewise bounded before they reach an editor
or agent consumer.

Semantic tokens use full-document responses only. Delta requests and persisted token caches are not
part of this rollout because measured value has not justified their additional state and recovery
surface. The bridge validates the negotiated legend against a reviewed token-type and modifier
allowlist, checked integer ranges, relative-position decoding, document bounds, overlap rules, token
and byte caps, request deadlines, cancellation, and the document version that produced the result.
Malformed legends or data, arithmetic overflow, invalid deltas, overlapping or out-of-range tokens,
excessive responses, stale versions, large files, unsupported providers, timeouts, and cancellation
all discard the complete semantic response and preserve deterministic syntax highlighting. Partial
or stale semantic overlays are never rendered.

Rust is the first and only language enabled for semantic tokens in this decision, contingent on
current provider-conformance quality plus measured sanitizer latency, payload, large-file,
cancellation, stale-version, and fallback evidence meeting the committed budgets. Live use remains
additionally gated by the real server's negotiated capability. Python, Go, and Java stay deferred
until provider-specific measurements justify enablement. Shell remains out because
its proven candidate surface does not include semantic tokens. This is a rollout decision, not a
static capability promise: failure of the negotiated capability, conformance suite, or budget
evidence removes Rust semantic support rather than weakening a limit.

Semantic token bodies, legends, source-derived classifications, document text, URIs, request and
response bodies, and edit bodies are transient and are never persisted, logged, or emitted as
evidence. Evidence is limited to closed provider and operation identifiers, versions and hashes,
bounded counts, latency and resource measurements, fallback reason codes, cancellation and stale-
response counts, and pass/fail outcomes. The implementation and failure-first tests specified by
the #2280 evidence contract, not this ADR text or static matrix, substantiate every operation and
semantic-token claim.

## Consequences

Positive:

- Later provider children receive one complete, bounded configuration surface for all five languages.
- Policy, legacy compatibility, workspace choice, provisioning, negotiation, health, and restart can
  no longer be conflated into a single `READY`/environment-flag boolean.
- Static capability arrays cannot over-advertise live operations.
- Java/Rust execution and download hazards, Shell external sourcing, arbitrary argv/environment, and
  host-path injection are structurally absent.
- M7 can reuse one server-owned settings seam instead of creating a parallel editor settings model.

Negative / neutral:

- The contracts are intentionally conservative. A provider-specific option outside the allowlist
  needs an additive reviewed contract change rather than passthrough JSON.
- Safe Java/Rust modes can have lower fidelity until enforced isolation exists.
- Semantic-token support remains a negotiated, measured rollout decision, not an automatic feature of
  process readiness.
- The private state record and evidence projection add bounded local state that operators must retain
  with the existing Keiko runtime-state directory.

## Alternatives Considered

### Treat `LspProcessStatus.READY` as available

Rejected: it ignores policy, explicit workspace activation, configuration revision, negotiated
capabilities, dynamic unregistration, and product health. D6 makes the ownership distinction binding.

### Persist provider argv, executable paths, or environment maps

Rejected: these are command/exfiltration surfaces, leak evidence, bypass operator provisioning, and
duplicate ADR-0069 launch ownership. Opaque approved identities plus typed fields cover the needed
configuration without executable data.

### Store arbitrary LSP `settings` JSON

Rejected: unknown fields silently widen provider behavior, make restart semantics unknowable, and can
enable downloads or project-code execution. Per-language strict unions are larger but auditable.

### Add Shell later or include SQL now

Rejected: Epic #2094 explicitly includes Shell and orders it before Java/Rust. SQL is outside the
epic's exact five-language scope and requires its own capability/security decision.

### Reuse static provider candidate arrays as negotiated capabilities

Rejected: initialize responses and dynamic registration can narrow live support. Static arrays are an
upper bound only.

## Additive amendments and reuse

- **ADR-0045:** the managed rollout is corrected from four to exactly five languages and ordered
  Python → Go → Shell → Java → Rust; safe-default and per-language review requirements remain.
- **ADR-0067:** the existing registry and shared operation vocabulary remain authoritative; no second
  mode map or capability registry is added.
- **ADR-0068:** browser-local capability and formatting-reachability decisions are unchanged.
- **ADR-0069 D5:** `READY` is clarified as raw process health only (D6); all process hardening remains.
- **ADR-0119:** the shared operation vocabulary and review-before-apply mutation model are reused;
  negotiation determines which external provider operations are live.
- **M7/#2095:** must extend this server-owned settings/control-plane seam and must not duplicate it.

## Out of Scope

- Server routes, persistence, provisioning detection, process-manager changes, UI, real provider
  activation, binaries, downloads, or toolchain installation.
- Replacing the in-process TypeScript/JavaScript provider.
- Enabling Java build-tool/plugin/annotation-processor execution or Rust build scripts/procedural
  macros without an enforced, attested ADR-0043-compatible boundary.
- Adding SQL or any sixth managed language.

## Verification

- Failure-first co-located tests cover valid values, every precedence permutation, all downgrade
  paths, internally inconsistent status, unknown fields, malformed values, hostile objects, caps,
  unsafe paths, schema skew, stale revision/ETag, semantic-token truncation/version/index/mask bounds,
  and content-free sentinel/type-level invariants.
- Contract tables are frozen and changes are additive exports from `keiko-contracts`.
- Required repository gates are those listed by Issue #2271 and root `AGENTS.md`.

## Related

- [ADR-0045](ADR-0045-staged-multi-language-lsp-expansion.md)
- [ADR-0067](ADR-0067-language-capability-registry-and-editor-mode-map.md)
- [ADR-0068](ADR-0068-builtin-editor-language-features-and-formatting-baseline.md)
- [ADR-0069](ADR-0069-governed-lsp-process-manager.md)
- [ADR-0119](ADR-0119-language-navigation-refactoring-contract.md)
- Epic [#2094](https://github.com/oscharko-dev/Keiko/issues/2094)
- Issue [#2271](https://github.com/oscharko-dev/Keiko/issues/2271)
