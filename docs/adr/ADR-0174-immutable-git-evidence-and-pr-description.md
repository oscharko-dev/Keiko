# ADR-0174: Immutable Git evidence and governed PR descriptions

## Status

Accepted for Epic #3384, Issues #3397 and #3398 (2026-09-04). The snapshot producer and narrative
core are implementation foundations. Product adapters, delivery, readiness and live qualification
are separate acceptance steps; this decision does not claim their completion.

## Context

The existing Git window exposes a bounded working-tree diff, while a publishable PR description
must describe committed changes between a target branch's merge base and an exact head. Reusing
the working-tree diff as published evidence would include unstaged content, lose immutable
revision identity and silently omit changes beyond display limits. Chat and Coding Workbench must
share one producer and one narrative core without introducing another Git engine, model client,
approval registry or evidence store.

## Decision

### D1 — One immutable producer, two data projections

`GitChangeSnapshot` in `keiko-contracts` owns revision identity, entry kinds, limits, completeness,
digests and closed failure outcomes. The server's snapshot service uses `keiko-git`'s hardened
runner and the existing unified-diff parser. It resolves the registered workspace and exact base,
head and merge base; compares those facts and the remote again before returning; and refuses
missing, ambiguous, changing or malformed inputs. Local staged, unstaged and untracked changes are
reported as divergence counts, never included in committed change evidence.

`repositoryId` locates a local checkout. `remoteDigest` identifies a GitHub repository using the
shared intake producer's SHA-256 of the lower-case identity `github.com/<owner>/<repository>`.
Same-repository comparisons use the remote digest. Two equivalent clones may share a snapshot
digest while retaining different local access bindings; local-only snapshots retain their
checkout identity in the digest. Timestamps and transient access handles are not semantic change
identity. Digest inputs come from the contract's canonical field projection.

Durable/public evidence contains only ids, hashes, counts, kinds, limits and closed outcomes.
Paths, filenames and hunk text remain in a separate transient server projection. An opaque random
handle is bound to a server-held capability object by identity. Knowing the handle does not grant
access. The process-local bounded registry retains at most 32 snapshots and 64 MiB, expires them
after 15 minutes by default (one hour maximum), invalidates stale rechecks and clears on shutdown.
Restart loses access; no persistent raw-diff store is added.

### D2 — Local reads cannot change revision meaning or initiate a fetch

All snapshot reads disable Git replacement objects and lazy fetching. A partial clone with a
missing object fails closed; a local replacement ref cannot change the content represented by a
SHA. The hardened runner recognizes these global flags so process observations still identify
the actual Git subcommand. This corrects the initial assessment that no runner change was needed.

Raw and numstat metadata use NUL delimiters and a bounded 8 MiB read. Rename/copy detection is
explicit (`-M50%`, `-C50%`, harder copy detection and a 2,000 candidate limit). Patch production
uses Myers, no indent heuristic and three context lines. Text conversion and external diffs stay
disabled. The committed head's attribute tree is selected explicitly; binary classification uses
bounded immutable blob bytes rather than dirty attributes. Every file, hunk, line and byte bound
contributes to disclosed completeness. A 30-second default deadline (120-second maximum) covers
the whole capture; cancellation and ignored-abort readers settle without retaining partial data.

### D3 — Narrative generation consumes admitted evidence

`keiko-model-gateway` owns the shared description core. An adapter supplies an already-admitted
authority context, explicit English/German language and an access-controlled snapshot resolver.
The core does not mint authority, publish text or infer admission from a mode. It uses the existing
Model Gateway, configured model selection, budget accounting, cancellation and activity-log port.
It offers no tools. Structured output requires both existing capability flags; chat-only models
remain supported through local parsing against the identical closed schema.

Repository content and refinement instructions are untrusted input, separated from trusted
instructions by the existing prompt-segmentation mechanism. Every accepted claim references a
supplied evidence id. Unknown fields, invalid evidence references, malformed output and unsafe
content fail validation. Calls, tokens, input/output/chunk bytes and elapsed time are bounded.
The renderer never converts changed test files into a claim that tests ran.

Artifact outcomes are `complete`, `partial`, `fallback` and `failed`. Metadata-derived fallback
and omission statements are deterministic. A partial snapshot cannot become a complete claim;
unavailable or expired evidence cannot be silently replaced by another revision. Artifacts are
immutable and bind their canonical digest to the source snapshot and rendered result.

### D4 — Trusted rendering and separately governed application

One contract owns the versioned managed-region markers. Model output cannot author those markers,
closing keywords, template structure or branding. The trusted renderer appends the exact text
`by Keiko`; a logo is optional and requires a validated immutable HTTPS asset plus server-established
public availability. Missing, private or unrenderable assets produce the text fallback without a
network fetch. Repository templates and human-authored text outside the managed region belong to
the application adapter and must remain byte-identical.

Description application, PR creation, mark-ready, CI readiness, human review and observed merge
remain distinct governed operations under ADR-0086, ADR-0087, ADR-0137 and ADR-0138. A generated
artifact alone grants none of them. Their adapters must recheck live revision, remote, authority
and protected body content before any approved effect.

### D5 — Reconstruction and verification

Snapshot capture/read/recheck/expiry/invalidation and narrative generation use existing activity
ports with correlation ids, closed outcomes, counts and hashes. Faults use sanitized stack/cause
evidence through the server's existing reducer. No source text, reference text or paths enter
these events. The generated operation catalog and `keiko support analyze` timeline are part of
the implementation proof.

Real temporary repositories prove all entry kinds, dirty divergence, clone equivalence, replacement
refs, partial-clone refusal, limits and cancellation. Narrative tests use the real gateway transport
with hermetic provider responses and enforce model-capability selection, injection rejection,
budget settlement, deterministic fallback and rendering. These deterministic proofs do not replace
the production OpenCode/model/GitHub and signed-platform receipts required by #3390.
