# ADR-0141: Authenticated local app-session channel for content-bearing Code surfaces

## Status

Accepted (Issue #2477, Epic #2473 Wave 1, 2026-07-18). This decision governs a trust boundary; the
mandatory human security review required before implementation — the repository rule for trust
boundaries and the epic board exception `Human Review Required: Yes` — was performed and is recorded
on the implementing pull request. The W1.5 finalization section below records the decisions this
ADR explicitly deferred to route enforcement (Issue #2478).

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

CLI startup health is instance/readiness evidence and never read authority. The health route may
project the exact validated, non-credential launch identity from its server dependency environment.
The shared leaf grammar is also used by CLI state and argument parsing. A fresh CLI start requires
the selected launch identity, installed version, live owned child and a final monotonic deadline
check. The existing startup grant bounds the whole HTTP request, including a trickling body;
individual socket activity does not renew it. CLI duration parsing refuses non-finite or unsafe
millisecond budgets instead of admitting an unbounded or rounded grant; representable positive
durations keep their existing semantics. A tracked modern launch is rechecked after the probe
against the current canonical PID tuple, liveness and process identity before it is retained as
healthy, including headless starts. Mismatch or uncertainty preserves tracking and refuses.
Version-only legacy inspection remains a compatibility path and does not establish native
generation ownership or app-session authority.

An explicitly validated `ui --launch-id` selection is retained in the effective server environment,
including health, browser handoff and shutdown polling; a stale ambient identity cannot substitute
for that selection. The existing Activity Log records the CLI decision with closed phase/outcome
and launch-bound Boolean fields under the process-startup failure class, without the identity,
PID, request URL, pairing secret or health body.

### D2 — Content-bearing reads require an explicitly approved app session

Read authority for content is a server-issued **app session**, initially established when a pairing
request is approved by a server-private `SessionPairingPort`. The port's production implementation
is bound to a trusted launcher/OS authority: it approves only a fresh, single-use, process-bound
attestation that an arbitrary local process cannot forge because it does not hold the launcher's
process-scoped pairing secret. The port is injected into production composition through the same
"injected production ports, never a fallback consumer" seam that ADR-0137/#2377 established for the
runtime start-confirmation plane. **Absence of the port is an intentional fail-closed production
posture:** without launcher attestation or an existing explicitly remembered browser approval,
an unauthenticated caller cannot establish authority. Protected reads return their existing
content-free projection. The exact launcher-to-browser delivery of the attestation is
finalized with the UI plumbing in W1.5; the server-side authority, the session, and the channel are
complete and independently testable through the port here.

Expired single-use request IDs may be pruned only without restoring their authority after a
clock correction. The existing pairing port retains its highest finite observed wall time and
refuses new attestations while time is invalid or behind that observation. Equal or increasing
time preserves the inclusive freshness boundaries and bounded replay cache. After a forward jump
is corrected, new pairing remains unavailable until time catches up; existing sessions retain
their own lifetime policy. Refusals use the same content-free acknowledgement and existing
count-only denial aggregate, without exposing the clock or claim. This does not extend grants,
renew cookies, or make a replay valid.

The local-session restore route only confirms an existing valid bearer and refreshes its exact
scoped cookie projections. Their browser Max-Age is bounded by the verified registry lifetime
remaining on its own clock and the existing cookie lifetime ceiling. The registered confirmation
records the actual Max-Age and projection count, without bearer material. Less than one full second
of remaining lifetime cannot repair a cookie: the route returns its content-free acknowledgement
without cookie headers or a confirmed event. The projection count comes from the serializer's active
path inventory, excluding retired-cookie deletions. It neither mints a session
nor extends the server-owned absolute lifetime. This repairs
missing projections after an upgrade, including the authenticated support-report route. Composing a launcher
pairing port is never itself client attestation: an absent, forged, revoked or expired cookie cannot
mint a new session. The launcher fragment is redeemed only by the existing single-use `/pair`
endpoint. Valid-cookie reloads remain automatic and do not widen authority.

#### Explicit browser approval (#4043)

The same channel and session registry support approval of another browser by an already approved
local session. The requester supplies only a public P-256 point and an explicit optional remember
choice. A bounded five-minute request carries a random identifier and an eight-digit comparison
code. The human compares that code in the requesting browser and in the authenticated approval
surface. Merely knowing the request identifier or comparison code cannot issue a session: completion
also proves possession of the exact approved private key. There is no unauthenticated launcher
invocation, fallback bearer, browser-supplied principal, or grant of task/autonomy authority.

Completion and remembered renewal use distinct, single-use challenges valid for at most sixty
seconds. Domain-separated signed bytes bind the installation, current server instance, exact
scheme/host/port origin, purpose, subject, random challenge identity and nonce, and issuance/expiry.
The server accepts only canonical public coordinates and IEEE-P1363 ECDSA-SHA256 signatures.
Consuming a challenge removes it before verification; replay, malformed input, a different origin,
an expired request, and restart-invalidated challenges cannot mint a session. Pending requests are
bounded to 32 together with retained completed-session metadata, and challenges to 64; a new challenge replaces the previous challenge for that subject
and purpose. JSON uses the existing bounded pairing reader and all existing Host/Origin/CSRF and
content guards remain mandatory. These new POST routes additionally require the exact transport
origin, rather than the routing URL's placeholder authority.

Remembering requires an explicit choice from both requester and approver. The existing private UI
SQLite store owns schema V45: a stable random installation identity and monotone observed-time
floor, plus at most 32 approved public keys with their exact origin, immutable approval/expiry times
and last successful use. No private key, cookie, signature, challenge or reusable bearer is stored
there. Expiry is at most thirty days after human approval and never slides on use. A full inventory
refuses another remembered grant instead of evicting a valid one. A persisted observation floor
prevents an already observed expiry from becoming usable after restart and clock rollback; invalid
or backwards time refuses approval operations until the existing floor is reached.

Remembered renewal requires a fresh challenge and a current unrevoked public approval. It issues
ordinary process-memory sessions through the existing registry, with validity capped by both the
usual session lifetime and the original approval deadline. Rotation, cookie repair and active
operation protection cannot extend that deadline. Operation release irreversibly removes an
approval-expired session even when release is its first expiry observer. Revocation synchronously
removes the durable approval, pending completion state and every associated live session through
the same registry. Within the single BFF owner, verification, store mutation and mint/revocation
contain no asynchronous gap. A lost completion response can rotate its existing session with a
fresh proof during the original request window; it cannot mint again after revocation or eviction.

Management distinguishes remembered and session-only approvals explicitly. Approved session-only
decisions are manageable during their original request window. After successful completion, their
existing bounded request metadata remains only while the original grant and exact registry session
are valid; no transient approval is persisted. The registry's owner-only lookup is non-touching:
management polling cannot renew another browser's inactivity. Rotation keeps the same manageable
session identity. Idle/absolute expiry, revocation or eviction retires its metadata and releases
capacity, including before the request window ends. Both completion challenge issuance and proof
still enforce the original five-minute request deadline even while live metadata remains visible.
Revocation acknowledges an actual durable row, approved decision or associated session removal,
and retires only matching completion/renewal challenges. The existing approval Activity Log records
pending-request, session-only and remembered counts without identities, public points or bearers.

The browser keeps a session-only private key in its mounted request controller and remembers an
explicitly approved, nonextractable private CryptoKey only in origin-scoped IndexedDB. The desktop
notice starts an explicit request; Settings → Security owns comparison, session-only or remembered
approval, expiry, last-use display and revocation. Remembering defaults off, requires both human
choices, and is reported successful only after the IndexedDB transaction commits. Request success
alone is insufficient; abort, blocked storage and quota failure retain an honest unconfirmed result
without raw-key fallback. Cancelling a controller aborts its wait and prevents late UI publication;
it does not undo a decision already accepted by the server.

A remembered request commits an opaque persistence intent in that same object store before it is
dispatched. Saving a key checks that exact intent and writes the active key in one readwrite
transaction. Local forgetting deletes the key and intent atomically, so a delayed completion or a
superseded request cannot recreate forgotten persistence. Failed preparation leaves ordinary
approved access usable but cannot claim remembered storage. Existing saved-key records remain
load-compatible; no additional database, private-key export or server authority is introduced.

Fresh protected management inspection verifies access after proof. A lost proof response may leave
an already usable cookie; a later retry first inspects that session without extending the original
completion deadline or minting another grant. Lost approval metadata cannot establish remembered
persistence. Browser wall-clock precision does not decide whether a challenge is current: canonical
relative lifetime and authority bindings are checked locally, while the server owns expiry and
single use.

The complete Chrome/Safari/Firefox restart, profile and SSD journeys remain qualification
requirements; server or browser storage controls alone do not establish their acceptance. New
remembered state is additive, private and tied to the existing installation,
not to its directory path; moving protected state does not grant trust to unrelated installations
or OS users. No release version is assigned by this implementation checkpoint.

Origin identity is not OS application identity. Existing cookies are not isolated by TCP port;
neither nonextractability nor IndexedDB protects against hostile script in the same origin,
including a local server that takes over that origin while Keiko is stopped. Current CSP and
transport guards remain in force. This design does not promise protection from same-origin code,
privileged OS clock/state tampering, or restoration of a revoked database from an old backup.

### D3 — The authenticated channel is a distinct transport, not a widening of the unauthenticated union

Content is served over a new authenticated channel: an authenticated snapshot read and an
authenticated fetch-streamed read that require a valid session cookie. The existing status and
`EventSource` routes (`/status`, `/readiness`, `/runs/:runId`, `/runs/:runId/events`) and their
`CodingWorkbenchRuntimeSseEvent` union stay **permanently content-free** and are not widened by one
field. `EventSource` cannot attach an authorization header and is therefore never a content
transport; authenticated reads use `fetch` with the credentialed cookie. The channel payload reuses
the runtime-question bounding discipline — bounded, non-empty text with a strict aggregate UTF-8
budget — validated by the server-owned channel contract before it crosses the wire.

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
explicit revocation (launcher revocation or sign-out), or when its inactivity or absolute lifetime
limit is reached; rotation issues a fresh secret and invalidates the prior one. In every one
of these cases the prior cookie immediately yields the content-free projection. There is exactly one
authority per BFF process; this composes with, and does not duplicate, the single-active-run model
of ADR-0137.

Idle and absolute lifetimes use half-open intervals: equality at the deadline is expired. Every
expiry observation removes the invalid record before denial; a later clock correction cannot
revive it. Active operations protect only inactivity, including their final release, and never
postpone an absolute or approval deadline.

Approval expiry is coordinated through these same owners in both directions. A valid time
observation by browser approval asks the existing registry to retire all approval-bound sessions
whose original grant deadline has been reached. Registry inspection, direct rotation, operation
release, cookie repair's final clock read and capacity sweeping use that same bounded retirement
when they observe an expired approval. Healthy grants and launcher sessions remain independent;
idle or session-absolute expiry does not revoke a still-valid remembered grant. The registry
synchronously reports a positively observed approval expiry through its injected private-store
port, composed from the existing `BrowserApprovalStore.observeTime`. Thus a private read cannot
observe grant expiry and then leave the remembered key eligible for renewal after clock rollback.
The existing Activity Log records only expired-session count, remaining registry count and a closed
reason class on `coding-app-session.expired`, without a session/approval identity or bearer. This
shared BFF maintenance observation uses the existing unknown-correlation sentinel. Store or sink
failures propagate through the existing diagnostics; no failed durable write is represented as a
successful persisted observation.

Secret rotation preserves the original issuance time and absolute deadline, including repeated
rotations. The registry rejects direct rotation of idle-expired or absolutely expired authority;
knowing an old session id cannot revive it. A valid replacement starts a new inactivity window,
but does not inherit an old operation lease, and releasing an old lease cannot touch the replacement.
Snapshots, repaired cookies and replacement live streams all remain bounded by the original
absolute lifetime. Rotated HTTP cookie projections use only that lifetime's remaining full seconds,
clamped by the existing cookie ceiling; the registered rotation event records the actual
`cookieMaxAgeSeconds` without bearer material. Fresh secret issuance is not fresh human approval.
Rotation requires at least one full second of remaining original authority, matching cookie repair.
The channel checks this before replacing the original secret and again after minting; if time crosses
that boundary, it revokes the unusable replacement and cannot report a successful zero-age cookie.

Explicit normal Chat sends verify an optionally presented existing session so active conversation
refreshes the inactivity window. Ordinary Chat does not require a launcher session, and verification
cannot mint, revive or extend an expired or revoked session. Passive SSE, polling and unrelated
reads do not count as conversation activity. The absolute lifetime remains unchanged; an in-flight
turn has scoped activity protection only for inactivity, not absolute expiry. The existing session
registry counts Chat operations only after parsing, validation and turn admission succeed. Unparsed
bodies, rejected plaintext requests and replay responses do not acquire protection or renew idle
expiry through this activity path. Existing protected image or workspace authority checks remain
independent. Pre-admission queue waits do not acquire protection. Completion and request abort release the count
idempotently. While a valid operation is pending the session is active, even during a long provider
wait. The last release starts the normal inactivity window from completion. Revocation, rotation,
process restart, capacity eviction and the absolute lifetime still invalidate authority immediately;
release cannot revive a removed or replaced session. At capacity, admission first removes expired
sessions, then prefers the oldest inactive session over a valid active operation. If every session
is active, the existing bounded capacity remains authoritative and evicts the oldest session. The
registered pairing result records expired-session count and a closed eviction class, without IDs.
No timer, polling or passive SSE renews it.

A Coding Workbench run is one such explicit operation that outlives the request that admitted it
(#3897): a model turn can stay quiet for longer than the idle window, and in the Keiko 1.3.0 test
the window that started a run was unpaired mid-run (`coding-app-session.expired`, inactivity). When
an admitted run mutation of the existing `mutation()` funnel answers with the run in `starting`,
`ready`, `running`, `awaiting-approval` or `stopping`, the requesting session holds the existing
operation lease on the `coding-run` surface, correlated by the run id, once per session and run.
A run-state observation every five seconds only releases that lease once the run has left those
states (paused, settled, taken over, recovery-required or gone); it never renews, extends or
re-acquires anything, and holding the session again after a pause takes a new admitted mutation.
A rotation replaces the session record without its operations, so the rotated credential holds the
lease again on its next admitted mutation, which first ends the predecessor's lease. An unreadable
run state counts as settled, each lease releases independently, and either failure records a
body-free server diagnostic. The lease protects only inactivity, like every other: revocation, rotation, restart, capacity
eviction and the absolute lifetime still end the session at once. Leases are bounded per composed
channel (eight runs, four sessions per run) and graph disposal releases every one as `aborted`. The
existing `coding-app-session.operation.state` acquisition and release lines record it.

The same admitted-operation protection covers normal Chat regeneration and Git-description work.
The registered `coding-app-session.operation.state` event records acquisition and idempotent release
through the existing session activity port: a closed surface and release reason, observed concurrent
operation count, authority state and elapsed duration. A release records settlement or cancellation,
not model success. Its authority observation does not refresh idle time; unavailable or custom-port
counts are omitted rather than invented. No bearer, session ID, folder path or conversation body is
included. If an injected activity port throws, the existing safe process logger receives the same
body-free state; telemetry cannot turn completion or cancellation into a new request failure.

### D6 — Fail closed to the content-free projection, never to an error that reveals content

The absence of a valid session yields the **same content-free projection the routes serve today** —
never a `401`/`403` or any error that would let a probe distinguish "not paired" from "no content
exists." An unpaired reader and a paired reader for whom no content is currently available receive
byte-identical shapes. The channel therefore leaks neither the existence of a session nor the
existence of protected content. This mirrors the existing `idle()` snapshot and the content-free SSE
reset frame.

A successful content-free terminal SSE snapshot is an accepted write followed by stream closure.
It is not backpressure. The writer separately handles a false write result and an actual write
exception, including the initial reset, live snapshot and heartbeat. Closure must not turn a
successful terminal write into an error or allow a previously queued snapshot to reopen the
stream. Existing stream counters and correlated activity-log events record genuine write errors.

A false write result is Node's own buffer accounting above the high-water mark; it does not by
itself mean the reader stalled. In the Keiko 1.3.0 test one near-capacity activity snapshot to an
idle local browser closed the live stream as `sse-backpressure` (#3897). The writer therefore waits
for `drain`, keeps only the newest pending snapshot while it waits (a later snapshot supersedes the
pending one; a terminal frame still ends the stream once written) and skips heartbeats meanwhile.
Only a stream that does not drain within `CODING_APP_SESSION_STREAM_DRAIN_TIMEOUT_MS` (one second)
is a stalled reader: it records `sse-backpressure`, stops its live source and closes, exactly as
before. The KEIKO-0225 regression pin for that diagnostic was relocated to this bound, not relaxed.
The live stream's closed line counts `drainWaitCount` and `coalescedSnapshotCount`. The browser
reconnects a dropped live channel by itself, at most five times with growing pauses, and gets a
fresh budget only after a reconnected channel stayed live for 30 seconds; the Reconnect action
remains after the last attempt.
The routes log the session's lifecycle body-free (PR #3452, F65): a pairing that issued a session
(`coding-app-session.paired`), a rotation, a sign-out that revoked a session, each fetch stream's
opening, live or content-free, and a live stream's close with how long it stayed open. A denied
pairing or rotation writes no line of its own and stays in the rate-limited aggregate diagnostic
(KEIKO-0838); a sign-out that revoked nothing (no session behind the cookie, or a repeated sign-out)
writes none either, so the log never shows a sign-out that did not happen. A
pairing fragment that arrives by same-document navigation (after a lane restart, say) is redeemed
like a boot fragment, and every session read in the window runs again after it.
This includes the private Chat skill selection and an already-open skill library: both subscribe
to the shared session-redemption notification. Their reads are refreshed after any earlier pending
read settles, so stale unavailable results cannot suppress recovery. The dialog and unsent message
remain mounted; selection, upload and dispatch still require the server's verified session.
Existing session-pairing and `skills.library.operation` lifecycle records show the recovery without
recording skill bodies or introducing a separate diagnostic stream.

The browser bounds pairing and existing-session confirmation with the same 15-second local
session transport deadline. A stalled pairing request therefore releases the shared boot wait;
the attestation is never replayed. Its failure records the request or echoed response correlation,
closed error class and body-free original error evidence through the existing client diagnostic
owner. This deadline applies to local session establishment, not model generation. A later
content-free confirmation acknowledgement still does not establish that the session was approved.

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

The trusted launcher (`keiko start`, `keiko restart`, and `npm run dev:start` by default;
`--no-open` is the explicit headless opt-out, and `--open` remains compatible)
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
residual risk. Another start against a running BFF writes an owner-private, single-use
`ui.browser-open` request bound to its PID and launch identity. The running trusted launcher
consumes that request and opens a fresh fragment attestation using its process-private secret.
It also receives the requesting CLI correlation and validated loopback hostname. It mints a fresh
child correlation whose parent is that request; the hostname preserves the customer's cookie
origin while the listener remains bound to loopback. Unsafe, malformed or mismatched requests
produce one closed refusal per uninterrupted refusal reason. A healthy older launch without a
verified launch identity reports `restart-required`, not a fabricated process fault.
The requesting process receives no secret or attestation, and no HTTP caller gains a
session-minting path. Unsafe or mismatched requests fail closed. Older launches without this
channel require a restart.

The default also covers existing `keiko init` project scripts, whose plain `start` invocation must
perform the authenticated browser hand-off without a script migration. The launcher preserves the
project working directory, state directory, and gateway configuration environment during this hand-off.
Platform browser openers receive only the allowlisted OS session environment. The launcher secret,
launch identity, and provider credentials never enter the browser process tree.

`cli.lifecycle.browser-handoff` records the headless/requested/delegated/failed/refused/restart-required
outcome and whether the hand-off
carried an attestation, without recording the URL, fragment, cookies, or secret.

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

### F6 — The cookie reaches only authenticated API route families

The same session bearer is issued as host-scoped cookies for the protected route families:
`/api/coding-workbench`, `/api/git`, `/api/files`, `/api/editor`, `/api/runtime`, `/api/runs`,
`/api/workspaces`, `/api/desktop/chat`, `/api/task-workspaces`, `/api/diagnostics/report`, and the
exact `/api/repositories/clone` entry point. Clone validates paired authority before reading its
body, checking destination paths or invoking the credential-capable Git runner. The broader
`/api/repositories` family receives no bearer. The final path carries the
paired session to issue-bound workspace provisioning (#3384/#3385); preview and provisioning
independently validate that session before resolving issue content. Cookie issuance and revocation
share one explicit path list so sign-out clears every browser projection.
The exact diagnostics report path uses the same paired authority to export a local, body-free
support artifact. Other diagnostics routes receive no bearer through this path.
The exact `/api/chats/messages/grounded` entry point also receives a projection to verify optional
existing-session activity on admitted normal grounded sends. Plaintext `/api/desktop/chat` sends use
their existing projection. Neither path grants new authority or requires pairing for ordinary Chat;
image attachment authority remains separately enforced. Private Markdown skills (#4022) add
`/api/skills` for the private library and `/api/chats` for revision-pinned selections at
`/api/chats/:id/skill`. The private document-to-skill variant of the existing Prompt Enhancer
adds `/api/prompt-enhancement` for its authenticated model request (#4027). The ordinary enhancer
retains its existing access contract; only `outputKind: markdown-skill` requires pairing, revalidated
before dispatch and after completion. All three projections consume the existing paired session; they cannot mint or widen its
authority. Issuance, confirmation, and revocation use the same projection inventory. Other Chat
routes retain their existing authorization requirements even though the browser carries the bearer.

Using a private skill in Chat requires the same live paired authority independently of client
selection preconditions. Productive selected-skill admission verifies it before persisting a user
turn. Each buffered, streaming, regeneration and grounded physical model attempt revalidates the
captured session identity and rotation, including retries. Missing or revoked authority refuses
without dispatching the skill. Ordinary no-skill Chat remains available without pairing; rejected
ordinary requests do not extend a session's idle lifetime merely through request parsing.

The governed unit-test-generation and bug-investigation workflows take an explicitly selected
skill on `POST /api/runs` (#4025 AC1): the request names only its identity, revision and digest,
never its text, and is not inferred from any Chat selection. Launch reads it only from the paired
session and refuses one that is already gone (409 `SKILL_SELECTION_CHANGED`). The run binds that
exact revision. Every model call, including a repair after a rejected patch and the gated apply,
carries its instructions once ahead of the first user message, outside the run's budget port so
they are counted with the prompt. Every physical attempt, a gateway retry included, resolves the
revision again and asks the run's own Authority Envelope again; a deleted or corrupted revision or
a revoked run sends nothing further and fails the run without an appliable patch. The body never
enters the workflow input, the report or evidence; `skills.workflow.attached` records the identity,
byte size and closed refusal reason only.

No live bearer is issued at the broader `/api` ancestor or to unrelated BFF routes. Issuance and
sign-out also expire the retired `/api` and `/api/editor/local-history` projections. `Path` remains
browser hygiene, not a security boundary. `HttpOnly`, `SameSite=Strict`, loopback host scope, hashed
server storage, rotation, revocation, and expiry remain unchanged.

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

## Approved-skill channel (Issue #3417)

The approved skills of a run are catalog state, not model-selected content, but they name what the
run may do next, so they ride the same authenticated channel rather than the general projection:
`GET /runs/:runId/skills` answers the paired operator with the closed, body-free record discovery
reports the model — the pinned `id@version`, the source digest, one closed category, the catalogued
capability ids, the compatibility range and the readiness the catalog itself can tell. The live
authority and the remaining budget are facts of one invocation, not of the catalog, so they stay out
of this view and can never be spent by looking. An unpaired read returns the single
`{ session: "unpaired" }` projection before run resolution, independent of run, catalog or skill
existence, and `CodingWorkbenchRuntimeSnapshot` carries none of it.

## Slash-command channel (ADR-0137 D10, C02)

The slash commands a run's runtime lists are the runtime's own untrusted display text, so they ride
the authenticated channel as well: `GET /runs/:runId/commands` answers the paired operator with the
names and one-line descriptions the runtime reports right now, bounded and duplicate-free by the
contract (templates never leave the runtime), and nothing for a run that is not live or whose profile
offers no commands. The read consumes no revision and no request id. An unpaired read returns the
single `{ session: "unpaired" }` projection before run resolution, independent of the run and of the
listing, and the general snapshot carries none of it.

## Pending-message channel (ADR-0137 D10, S07)

The messages the operator sent into a running turn that the runtime has not handed to the model yet
ride the authenticated channel as well: `GET /runs/:runId/inbox` answers the paired operator with each
message's id, delivery (`steer` or `queue`) and the operator's own one-line preview, bounded and
duplicate-free by the contract, in the order the model will receive them, and nothing for a run that
is not running or whose profile takes no delivery. The read consumes no revision and no request id;
the withdrawal or promotion of a message is the revision-bound `POST /runs/:runId/inbox` behind the
mutation funnel. An unpaired read returns the single `{ session: "unpaired" }` projection before run
resolution, independent of the run and of the inbox, and the general snapshot carries none of it.

## Consequences

- W1.5 can enforce this authority on the content-bearing routes and migrate the runtime-question
  reads onto the channel without inventing a second session mechanism; W1.6–W1.9 project transcript,
  plan, tool activity, and run-scoped diffs through the channel's content source.
- The channel is runtime-neutral: the deferred Codex follow-up epic reuses it unchanged.
- Every live session still expires on restart. An explicitly remembered browser can establish a
  fresh session within its original bounded approval through proof of possession; session-only
  browsers require fresh human approval or launcher pairing. Durable public approval metadata lives
  in the existing protected UI store, and never makes a prior cookie survive restart.
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
authority becomes its feed rather than being reworked. The separate owner-requested Coding
History workflow (#3560, ADR-0137 D4) reuses the existing local conversation store; it does not
persist the app-session cookie, runtime authority, or sidecar credentials. History reads and
updates require a currently paired app session, including after a process restart.

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
