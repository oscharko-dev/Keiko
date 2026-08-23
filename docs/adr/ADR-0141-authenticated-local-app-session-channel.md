# ADR-0141: Authenticated local app-session channel for content-bearing Code surfaces

## Status

Accepted (Issue #2477, Epic #2473 Wave 1, 2026-07-18). This decision governs a trust boundary; the
mandatory human security review required before implementation — the repository rule for trust
boundaries and the epic board exception `Human Review Required: Yes` — was performed and is recorded
on the implementing pull request. The W1.5 finalization section below records the decisions this
ADR explicitly deferred to route enforcement (Issue #2478).

> **Amended 2026-08-23 by ADR-0174 (Coding Workbench north star).** ADR-0174 D4 names this
> authenticated channel the single content-bearing live surface for every future Workbench content
> class — tool arguments/outputs/diffs, governed command output, and sub-agent and tool-protocol
> results — not only the transcript/plan/question content this ADR and its finalizations already
> route through it. Every new content route or field joins the same unauthenticated-sweep
> regression (`contentRouteEnforcement.test.ts`) this ADR established; persisted evidence stays
> body-free per D6/S4. No decision below is reopened; D3 remains the channel's content-posture
> definition.

## Context

ADR-0137 D4 declared that content-bearing live prompt, response, diff, and diagnostic events are
"transient, bounded, and access-controlled," and Epic #2473's architecture invariants require that
user-visible content (transcript, plan, diffs) travel only over a separately authenticated session
channel. Neither defined the access-control mechanism. This ADR defines it.

Today the coding-runtime routes are gated by four checks composed in the BFF: loopback-authority
host validation (`isAllowedHost`), same-origin loopback `Origin` validation, a CSRF header envelope
on state-changing requests, and per-run `runId` existence. These are necessary and remain in force,
but they are **routing facts, not read authority**. On a shared local machine every same-user
process satisfies loopback, can send the constant CSRF header, can present a same-origin `Origin`,
and — once it observes or guesses a `runId` — can read whatever a content-bearing route serves. An
arbitrary local process must not be able to read prompts, model output, plan, or tool activity. The
#2374/#2377 security audit recorded this as the highest-severity open prerequisite for any
transcript surface; no corrective code exists on `dev`. This ADR carries that threat model verbatim
rather than re-deriving it.

**Threat model (carried verbatim from #2377, Epic #2473 Annex B ledger row B.1):**

> Content-bearing routes need a real local session-auth boundary. Threat model carried verbatim:
> loopback/Origin/CSRF/runIds are routing facts, not read authority; no bearer in
> URLs/storage/logs/evidence; pairing via launcher/OS authority; rotation/revocation/restart expiry;
> deterministic fake approval port for CI; ADR + human security review before implementation;
> unauthenticated routes permanently content-free.

The adversary is a **same-user local process** on the loopback interface — not a remote attacker and
not a different OS user. It can open sockets to the BFF, replay the static routing facts, and
enumerate `runId` values. It cannot, by assumption, read another process's private OS-owned launcher
state or an HttpOnly cookie held by the authorized browser. The boundary must distinguish the
authorized Keiko browser session, paired through the trusted launcher that started the server, from
any other local process that merely reaches the loopback port.

**Scope of the guarantee (deliberate).** The boundary protects **memory-only content** — prompts,
model output, plan, tool activity. On-disk worktree content is readable by local processes by
nature; routing managed-worktree diffs over this channel later (W1.9) is a uniform content-posture
decision (defense-in-depth), not read-authority enforcement. Durable audit evidence stays
content-free and is unaffected.

## Scope

**In scope (this ADR and its implementing issue #2477).**

- The threat model and the invariant that loopback/Origin/CSRF/`runId` are routing facts only.
- A server-private **session pairing port**: the authority seam that decides whether a pairing
  request proves the trusted local app session, bound to a trusted launcher/OS authority.
- A **server-side session registry** with issuance, verification, rotation, revocation, restart
  expiry, inactivity expiry, and absolute expiry.
- The **authenticated channel primitive**: an authenticated fetch/snapshot read plus an
  authenticated fetch-streamed read, distinct from the existing unauthenticated EventSource union,
  serving a bounded content payload only to a valid session.
- A **deterministic fake pairing port for CI**, structurally unreachable from production
  composition.
- A **canary test suite** proving no session bearer material reaches any sink, and an executable
  journey proving the boundary end to end.

**Out of scope (owned elsewhere; this ADR must not implement them).**

- Enforcing session authentication on the existing content-bearing routes and migrating the
  runtime-question reads onto the channel — Wave 1 W1.5 (#2478).
- The transcript/plan/tool-activity/diff projections and their UI plumbing — W1.6–W1.9.
- A durable, encrypted Code resume store — Wave 3.
- The generic `/api/git/*` posture for managed worktrees — W1.9.

## Decision

### D1 — Loopback, Origin, CSRF, and `runId` are routing facts, never read authority

The four existing checks remain mandatory transport hygiene and continue to gate every route. This
ADR adds an authority layer above them; it does not replace, relax, or re-weight them. No count of
routing facts, and no knowledge of a `runId`, ever authorizes a content read. A request that
satisfies all four but carries no valid session is treated exactly as an unpaired stranger.

### D2 — Content-bearing reads require a launcher-attested app session

Read authority for content is a server-issued **app session**, established only when a pairing
request is approved by a server-private `SessionPairingPort`. The port's production implementation
is bound to a trusted launcher/OS authority: it approves only a fresh, single-use, process-bound
attestation that an arbitrary local process cannot forge because it does not hold the launcher's
process-scoped pairing secret. The port is injected into production composition through the same
"injected production ports, never a fallback consumer" seam that ADR-0137/#2377 established for the
runtime start-confirmation plane. **Absence of the port is an intentional fail-closed production
posture:** if no launcher authority is present, no session can be issued and every content read
returns the content-free projection. The exact launcher-to-browser delivery of the attestation is
finalized with the UI plumbing in W1.5; the server-side authority, the session, and the channel are
complete and independently testable through the port here.

### D3 — The authenticated channel is a distinct transport, not a widening of the unauthenticated union

Content is served over a new authenticated channel: an authenticated snapshot read and an
authenticated fetch-streamed read that require a valid session cookie. The existing status and
`EventSource` routes (`/status`, `/readiness`, `/runs/:runId`, `/runs/:runId/events`) and their
`CodingWorkbenchRuntimeSseEvent` union stay **permanently content-free** and are not widened by one
field. `EventSource` cannot attach an authorization header and is therefore never a content
transport; authenticated reads use `fetch` with the credentialed cookie. The channel payload reuses
the runtime-question bounding discipline — bounded, non-empty text with a strict aggregate UTF-8
budget — validated by the server-owned channel contract before it crosses the wire.

**Amendment (ADR-0174, 2026-08-23).** Target: this channel becomes the single content-bearing
transport for every Coding Workbench content class the north-star roadmap adds, not only the
transcript/plan/question payloads this ADR ships with — full tool cards (arguments, command line,
output excerpt, diff), governed command-execution output, and sub-agent/tool-protocol results all
join the authenticated `fetch`/fetch-streamed reads defined here, never the content-free
`EventSource` union this decision keeps content-free. Each new content route or field is added to
`ENFORCED_CONTENT_ROUTE_PATTERNS` in `contentRouteEnforcement.test.ts`
(`packages/keiko-server/src/coding-app-session/contentRouteEnforcement.test.ts:25`), so the same
route-table sweep that proves no question text reaches a cookie-less, forged, or revoked caller
(F1) is the regression a new content route must also pass before it ships. This widens what rides
the channel, not who may read it: D1, D2, D5, D6, and D7 govern the new content exactly as they
govern today's, and persisted evidence for the new content stays body-free (S4 of ADR-0174,
`CodingWorkbenchEvidenceRecord`). Current implementation is unchanged until the roadmap waves that
add each content class land (Wave 1 full tool cards, Wave 2 command output, Wave 6 sub-agent
results; docs/coding-runtime/coding-workbench-north-star-roadmap.md); until then the recorded
behaviour above remains the fail-closed implementation.

### D4 — Session material lives only in an HttpOnly, host- and path-scoped cookie

The session is presented to the browser as a single cookie: `HttpOnly`, `SameSite=Strict`,
path-scoped to the channel, `Secure` whenever the scheme is HTTPS (loopback HTTP is a
browser-designated secure context). The cookie value is the only bearer, and it never appears in a
URL, query string, cursor, command line, `localStorage`, `sessionStorage`, the Cache API, a log, an
evidence record, an analytics event, or a crash report. `HttpOnly` keeps it unreadable by page
script, so it is not extractable browser storage. The server stores only a salted hash of the
session secret, never the secret; verification is constant-time (`crypto.timingSafeEqual`). Every
diagnostic routes through the existing redactor and correlation-id sink; a session secret only ever
appears hashed.

### D5 — Sessions are process-scoped and fail closed on restart, rotation, revocation, and expiry

The session registry is in process memory and holds no durable bearer material, so a server restart
invalidates every prior session by construction (restart expiry). A session additionally expires on
explicit revocation (launcher revocation or sign-out), on inactivity past an idle bound, and on an
absolute lifetime bound; rotation issues a fresh secret and invalidates the prior one. In every one
of these cases the prior cookie immediately yields the content-free projection. There is exactly one
authority per BFF process; this composes with, and does not duplicate, the single-active-run model
of ADR-0137.

### D6 — Fail closed to the content-free projection, never to an error that reveals content

The absence of a valid session yields the **same content-free projection the routes serve today** —
never a `401`/`403` or any error that would let a probe distinguish "not paired" from "no content
exists." An unpaired reader and a paired reader for whom no content is currently available receive
byte-identical shapes. The channel therefore leaks neither the existence of a session nor the
existence of protected content. This mirrors the existing `idle()` snapshot and the content-free SSE
reset frame.

### D7 — The CI pairing fake mints read authority and is therefore production-unreachable by construction

A deterministic fake pairing port exists for CI so the channel is testable without a real launcher.
Because it mints read authority, it is exactly the seam class the epic's anti-false-green rule
targets. It is injected only at the test resolver seam; production composition never constructs it
and never falls back to it, identical to the runtime start-confirmation and production-ports
pattern. A negative test asserts on production composition that, without an injected port and
without launcher authority, no session is issuable and the channel stays content-free — the fake is
unreachable, not merely unused.

### D8 — Conversation images use session-bound opaque custody, not browser paths

A local human may stage an image for the selected chat model through the paired app session. The
browser uploads bytes only to the loopback BFF and retains an opaque reference plus body-free
metadata; it never sends a filesystem path. The BFF seals bytes in the dedicated bounded local
secret vault and binds the reference to the app-session id and rotation count, project, chat, MIME,
size, digest, and expiry. Immediately before the Model Gateway call, the BFF revalidates that full
binding, the current app session, the explicit delivery intent, and the selected model's image-input
capability. Only the existing Model Gateway content-part contract receives the resulting data URL.
SQLite chat text, evidence, diagnostics, and delivery projections remain body-free. Hard chat purge
deletes bound sealed blobs before deleting the chat row and fails closed if custody cleanup fails.

## W1.5 finalization (Issue #2478)

W1.5 enforced this authority on the content-bearing routes and finalized the two decisions D2 and
D4 deliberately left open. These are refinements inside this ADR's design space, not reversals.

### F1 — Route enforcement and the session-annotated content-free projection

All three runtime-question routes (`…/runs/:runId/questions`, `…/questions/answer`,
`…/questions/reject`) resolve the app-session read authority BEFORE any runId or runtime
resolution. An unauthenticated list read receives the one constant projection
`{ session: "unpaired", questions: [] }` (HTTP 200) regardless of run existence, runtime
configuration, or pending-question state; unauthenticated question mutations receive the same
not-found result an unknown run yields. This preserves D6's intent — no `401`/`403`, no response
that distinguishes "not paired" from "does not exist" — while refining its byte-identity wording
for the question surface: the `session` facet reflects exclusively the validity of the caller's
own presented cookie, never the existence of protected content or of anyone else's session. The
refinement exists because the product requirement "revocation surfaces as an honest re-pair state,
never a silent empty list" is unsatisfiable with a projection that is byte-identical between a
paired-empty and an unpaired read; the W1.4 generic channel snapshot keeps its strict
byte-identity. A route-table sweep test (`contentRouteEnforcement.test.ts`) holds the invariant
that no route in the runtime or app-session groups releases question text to a cookie-less,
forged, or revoked caller.

### F2 — Cookie path widened exactly to the enforced surface (D4 refinement)

The session cookie's `Path` widened from `/api/coding-workbench/app-session` to
`/api/coding-workbench`, because the browser must present the cookie to the enforced
content-bearing runtime routes. The `Path` attribute is browser hygiene, not a security boundary
(RFC 6265 §8.6); `HttpOnly`, `SameSite=Strict`, and the loopback host scope continue to carry the
bearer-protection properties, and the BFF is the only receiver on every covered path.

### F3 — Launcher-to-browser attestation delivery (D2 finalization)

The trusted launcher (`keiko start --open`, and `npm run dev:start -- --open` for the dev lane)
generates the process-scoped secret, provisions it to the BFF exclusively through the child's
inherited environment, and hands the browser exactly one single-use, freshness-bounded attestation
in the boot URL **fragment** (`#keiko-app-session=…`). The fragment never travels over HTTP; the
desktop shell redeems it against the pair endpoint on boot and immediately strips it from the
address bar and history entry, whether or not it was well-formed. Accepted residual risk, named
precisely: during the browser hand-off the fragment URL is transiently visible in local process
arguments (`open`/`xdg-open`), so a same-user process racing the browser could redeem the
attestation first. The exposure is bounded by single-use redemption, the ±30 s freshness window,
and — decisively — the honest re-pair state: a stolen redemption leaves the legitimate window
visibly unpaired instead of silently compromised. Relatedly, and made explicit here: the
launcher secret itself lives in the BFF process environment for the process lifetime, and
process environments are same-user-readable on common platforms (`/proc/<pid>/environ`,
`ps -E`). This is inside the threat model's standing assumption — "cannot read another process's
private OS-owned launcher state" — which this ADR treats as trusted OS same-user isolation, on
par with the browser's cookie store; the asymmetry (a read secret mints unlimited silent
sessions, whereas a stolen attestation is one visible, time-bounded redemption) is why the
assumption is load-bearing and why the native shell's direct injection remains the target
posture. The Keiko Native shell replaces this hop with direct cookie injection and retires the
residual risk; an already-running BFF cannot re-attest (its secret is private to its own
launch), so `--open` against it opens an honestly unpaired window and says how to re-pair.

### F4 — Contract promotion (the scheduled D12 batching)

The channel wire shapes, the pairing-attestation wire shape, the launcher-secret environment
contract, and the fragment codec moved to `keiko-contracts` alongside the browser client and the
channel-carried question payload (`{ session, questions }`, unchanged question bounds), exactly as
the consequence below scheduled for W1.5.

## W1.9 finalization (Issue #2482)

W1.9 binds the Code-task changes view to the existing generic Git readers and finalizes the
managed-worktree posture this ADR deliberately deferred.

### F5 — Generic Git reads are session-gated for resolved managed roots

Every generic `/api/git/*` reader keeps its existing behavior for ordinary registered or arbitrary
repository roots. When the route's **resolved real root** is contained inside Keiko's managed
task-worktree root, however, it requires the same launcher-attested app session as other
content-bearing Code surfaces. The check lives once in the shared repository-resolution choke point,
before Git membership or content is read, so status, raw and structured diffs, history, blame,
branches, summary, and remotes cannot drift into different postures. Classifying the resolved root
rather than the query spelling closes trailing-separator, dot-segment, and symlink aliases.

An absent, forged, revoked, expired, or otherwise invalid session receives each route's existing
schema-valid, content-free unavailable projection: empty changes, empty diff, empty entries, and no
distinct authentication error. The response does not reveal managed-worktree content or root
existence. A valid session enables the bounded existing readers; no new Git route, parser, or durable
content store is introduced.

### F6 — The cookie reaches only the two authenticated API route families

The same session bearer is issued as two host-scoped cookies, one at `/api/coding-workbench` and one
at `/api/git`. This reaches both authenticated route families without presenting the bearer to their
broader `/api` ancestor or unrelated BFF routes. `Path` remains browser hygiene, not a security
boundary. `HttpOnly`, `SameSite=Strict`, loopback host scope, hashed server storage, rotation,
revocation, and expiry remain unchanged; sign-out clears both browser projections after revoking the
single server-side session.

### F7 — Run-to-worktree binding stays single-sourced and read-only

The changes view derives its root only from `WorkspaceBinding.activeRoot`, which by contract equals
`gitDeliveryRoot`, `editorProjectRoot`, and the managed worktree path. It selects only paths returned
by the bounded status reader and fetches one whole-file diff at a time. Runtime change events trigger
a debounced refresh; there is no polling loop. Losing the binding immediately clears the view, and an
unavailable session clears content rather than retaining a stale diff. Durable evidence continues to
carry counts and digests only.

This is a uniform product content posture, not an operating-system read-authority guarantee: another
same-user local process can read on-disk worktree files directly. The app session prevents Keiko's
generic HTTP routes from becoming an unauthenticated content projection; it does not claim to revoke
local filesystem authority.

## Research-grant finalization (Issue #2644)

Approved research domains are model-selected content, just like the pending host and request line.
`CodingWorkbenchRuntimeSnapshot` therefore excludes research grants structurally for every caller;
the status and run-snapshot routes cannot expose a grant even if a future server call site forgets
to branch on session authority. Both pending review state and the live grant travel only through
the combined, authenticated `/runs/:runId/research` channel payload. An unpaired read returns the
single `{ session: "unpaired" }` projection before run resolution, independent of run or grant
existence.

The general status handler still consumes its request context to enforce an exact, input-free
transport contract: any query parameter is rejected. It does not session-branch the snapshot,
because doing so would create two general status projections and weaken D3/D6; the stronger
owner-layer invariant is that neither projection can represent model-selected research content.

## Consequences

- W1.5 can enforce this authority on the content-bearing routes and migrate the runtime-question
  reads onto the channel without inventing a second session mechanism; W1.6–W1.9 project transcript,
  plan, tool activity, and run-scoped diffs through the channel's content source.
- The channel is runtime-neutral: the deferred Codex follow-up epic reuses it unchanged.
- Restart expiry is free and durable-store risk is avoided, at the cost that a server restart
  requires re-pairing — acceptable and correct for a local-first, launcher-started product; the
  durable encrypted store is a deliberate Wave-3 decision.
- The existing unauthenticated status/SSE surface is unchanged and stays content-free; no existing
  route is migrated or claimed safe by this ADR (route enforcement is W1.5).
- The channel wire types are held in `keiko-server` for this wave and promoted to `keiko-contracts`
  alongside the browser client in W1.5, so the single contracts measured-surface change and its
  perf-evidence regeneration are batched there (the issue's D12 guidance) rather than incurred
  standalone here. Nothing consumes the wire types across the package boundary until W1.5, so this
  wave touches no measured surface.
- The launcher-to-browser attestation delivery is intentionally abstracted behind the port until
  W1.5; the server authority is nonetheless real and adversarially tested here, so the security
  prerequisite is genuinely discharged rather than deferred wholesale.

## Alternatives considered

### Treat loopback + Origin + CSRF + `runId` as sufficient

Rejected. This is precisely the gap the #2377 audit found. Every one of these is replayable by a
same-user local process; none binds the reader to the authorized, launcher-paired browser session.

### Carry the session as a URL token, a readable cookie, or browser storage

Rejected. Any bearer placed in a URL, a non-`HttpOnly` cookie, `localStorage`, `sessionStorage`, or
the Cache API is extractable by page script or observable in logs, history, and crash reports — the
exact leak sinks the threat model forbids. An `HttpOnly`, `SameSite=Strict`, host/path-scoped cookie
is the only presentation that keeps the bearer out of every named sink.

### Widen the `EventSource` union to carry authenticated content

Rejected. `EventSource` cannot attach an authorization header, so authenticating it would smuggle
content onto a union that must stay content-free and would entangle the unauthenticated status
stream with read authority. Authenticated content uses `fetch` streaming on a distinct channel; the
EventSource union stays exactly as wide as it is today.

### Return `401`/`403` to unpaired content reads

Rejected. A distinct auth error is an oracle: it tells a probe that protected content exists behind
the route. Failing closed to the byte-identical content-free projection removes the oracle.

### A durable or encrypted session store now

Rejected for this wave. A durable bearer store adds an exfiltration surface and defeats free restart
expiry; the encrypted Code resume store is a deliberate Wave-3 deliverable, and the Wave-1 transient
authority becomes its feed rather than being reworked.

### Enforce the boundary on the existing content routes in this ADR

Rejected as scope. W1.5 owns route enforcement and the question-read migration; conflating them here
would edit the same route files two agents must not co-own and would couple the primitive's review to
the migration's. This ADR delivers the primitive, the authority, the CI fake, and the proof.

## References

- [ADR-0137](ADR-0137-server-owned-coding-runtime-contracts.md) D4 — content-bearing events are
  "transient, bounded, and access-controlled"; this ADR defines that access control.
- [ADR-0124](ADR-0124-coding-autonomy-modes-and-sidecar-runtime-authority.md),
  [ADR-0129](ADR-0129-product-wide-authority-and-autonomy-model.md) — the authority and autonomy
  model this boundary sits within.
- [ADR-0135](ADR-0135-deterministic-dev-delivery-and-keiko-for-quality.md) — the deterministic
  `dev` delivery path the implementing PR follows.
- Issue #2377 (closed) — the original audit finding and threat model carried verbatim here.
- Epic #2473 Wave 1 — W1.4 (#2477) authors this ADR; W1.5 (#2478) enforces it on content routes.
