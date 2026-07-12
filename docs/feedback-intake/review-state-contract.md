# Hosted feedback review state contract

Issue #2075 adds one review item for each immutable hosted feedback payload. The V1 states are
`pending`, reserved-but-unreachable `approved`, `duplicate`, `rejected`, `archived`,
`private-security`, and `expired`.

The only generic review disposition actions are `mark-duplicate`, `reject`, `archive`,
`route-private-security`, and system `expire`. Legal-hold placement, release, and expiry are
same-state governance actions. V1 has no approval, reopen, follow-up, annotation, or content-editing
action. The closed rejection reasons are `insufficient-information`, `not-actionable`,
`out-of-scope`, and `policy-violation`.

Issue #2076 activates `approved` through sibling publication commands, not by adding approval to the
generic review action table. `prepare-publication` derives and stores an exact reviewer-visible
GitHub title/body while the item is still `pending`; `approve-publication` is the sole
`pending -> approved` path. `cancel-publication-route-private` routes to `private-security` only
while provider delivery is definitely impossible. These commands require `feedback.publish` at the
maintainer boundary and repeat the current permission-policy version check in persistence.

## Publication preparation and target binding

A preparation is immutable and expires no later than 30 days after creation or the source payload,
whichever is earlier. It contains the only durable provider-content copy: the exact UTF-8 title and
body reviewed by the maintainer. The body has fixed field order, renders user strings inert, and
ends with exactly one cryptographically random reconciliation marker generated before approval.
Oversize title or body projections fail closed; neither is truncated.

The public preparation command accepts only the server-issued `targetKey`; raw repository,
installation, owner, or label fields are invalid. The service resolves the complete target policy
internally. Its prepared response shows only the exact owner/repository, ordered fixed labels, and
policy versions alongside the exact title/body/marker preview; installation and repository ids stay
internal. A content-bearing preparation replay re-locks and revalidates the current review item,
payload bytes, preparation, expiry, command CAS, and complete resolved target before returning bytes.

The projection digest is domain-separated and covers the versioned title, body (including marker),
and target-policy digest. The target-policy digest separately covers the fixed GitHub API origin,
numeric repository id, canonical owner/name, installation id, ordered fixed labels, server-issued
target key, label-policy version, and target-policy version. Reusing a target alias or changing any
configured target member cannot redirect an existing preparation. Approval accepts identifiers and
expected digests only; it never accepts caller-supplied title, body, repository, installation, or
labels.

## Approval transaction and rollback boundary

Approval locks the payload, review item, and preparation in one serializable transaction. It checks
the item is still `pending`, non-private, unexpired, at the expected version and payload digest, and
that the actor's permission-policy version is current. It independently verifies the canonical
payload, reconstructs the projection from that payload, stored target snapshot, and stored marker,
and byte-compares the result with the preparation. The transaction then advances the review version,
stores the complete approval binding and post-version, marks the preparation approved, creates one
unique content-free outbox intent, closes receipts, shortens payload retention to at most 30 days,
and appends content-free audit/idempotency records. Any failure rolls all effects back.

The outbox never stores title/body, secrets, tokens, keys, JWTs, OIDC claims, receipts, or review
notes. It references the preparation, expires within seven days, and models `unclaimed`, `claimed`, `may-have-committed`, bounded
`retryable-failure`, `manual-reconciliation`, `succeeded`, and `cancelled-private`. Exact approved
provider bytes are available only through an internal lease-claim operation. It atomically advances
one current `unclaimed` outbox to `claimed` for a validated worker identity and a bounded lease,
commits that claim, and only then returns bytes. Concurrent claim losers receive a typed conflict;
there is no generic unclaimed-content read. The approved review binding, preparation, payload
projection, complete freshly resolved target policy, and exact committed lease must all still match.
GitHub linkage is content-free and does not alter the anonymous receipt contract.

Lease time comes from PostgreSQL `clock_timestamp()` sampled after the candidate row lock on every
serialization attempt. The complete requested lease must fit before the durable outbox expiry. A
content-free post-commit database-clock check must still observe the exact lease as live before any
bytes reach the worker; an already expired exact claim is released back to `unclaimed` instead.

Private routing can cancel an absent or `unclaimed` outbox atomically and permanently closes the
preparation/create path. If work is claimed or request bytes may have left the service, the outbox
moves to manual reconciliation and no second create is enabled. A succeeded issue returns manual
remediation so the maintainer can handle the already-public provider object; Keiko never claims that
local cancellation reversed publication.

Publication retention deletes each publication class in fixed ordered batches with skipped-lock
support. A class cutoff watermark advances only after a post-delete check proves that cutoff fully
drained. Approved content is removed through the payload/review/preparation cascade after its
30-day terminal deadline; an active legal hold preserves that chain, while content-free audit,
idempotency, and linkage records keep their independent 365-day ceilings.

Legal-hold policy keys are operator-defined identifiers, not Keiko-defined legal conclusions. The
operator allowlist must contain 1–32 unique lowercase identifiers matching
`^[a-z][a-z0-9-]{0,63}$`. The review repository defaults to an empty allowlist and therefore fails
closed until Phase B supplies validated startup configuration. Only the exactly matched key is
persisted in the hold and its content-free audit event.

Every mutation supplies the expected record version, expected immutable payload digest, and a
closed idempotency key. An identical replay returns the stored result; reuse of the key for any
different command is rejected. Terminal dispositions shorten payload expiry to the earlier of its
current deadline and trusted repository time plus 30 days, close linked receipts without extending
their existing 30-day cap, and append one content-free actor audit event in the same transaction.
Mutation commands contain no caller-provided event time. The repository captures its injected
trusted clock once per logical command and reuses that value across bounded database retries,
retention, audit, idempotency, legal-hold validation, and the returned result. Actor issuer, subject,
and permission-policy identifiers are non-empty, control-free, and bounded to 2,048, 255, and 64
characters respectively.

## Maintainer publication HTTP boundary

The separately hosted maintainer listener exposes publication only when the GitHub publication
runtime is configured. Disabled publication removes `feedback.publish` from the browser session
projection and returns the ordinary hidden-route response. Every publication route requires both
`feedback.review` and `feedback.publish`; neither permission implies `feedback.security`, which is
still required before any private item is visible.

The closed routes under `/v1/maintainer/reviews/:itemId/publication` are:

- `POST /prepare`, accepting only `action`, expected record version, `targetKey`, and idempotency
  key;
- `GET /preview?preparationId=:id`, returning the exact stored title/body bytes, safe target
  display, digests, and expiry without recomputing the projection;
- `POST /approve` and `POST /cancel-route-private`, accepting only their exact action,
  preparation id, approved projection and target-policy digests, and idempotency key; and
- `GET /status`, optionally with one exact `preparationId`, returning only the normalized
  publication state, safe failure/retry fields, digests, and succeeded issue number/URL. Without
  an id, status selects the latest preparation by `created_at DESC, id` or returns `none`.

For a cancelled preparation, durable outbox/provider evidence takes precedence over the local
preparation flag. An absent or `cancelled-private` outbox is `cancelled-private`; claimed,
possibly-committed, retryable, or manual work is `manual-reconciliation`; and a succeeded linked
issue is `manual-remediation` with its safe issue number/URL preserved. Exact preparation expiry is
rechecked inside the cancellation transaction and fails as `payload-expired`.

The server injects the canonical path item id, current immutable payload binding, and authenticated
actor plus permission-policy version. All POST routes use the existing same-origin JSON, CSRF,
session, size, deadline, duplicate-key, and strict UTF-8 gates. Status never selects title, body,
marker, or canonical report bytes. Browser responses never contain installation ids, numeric
repository ids, credentials, tokens, maintainer notes, or anonymous receipt linkage.

When publication is enabled, a session holding both review and publish permissions receives a
frozen `publicationTargets` catalog ordered by `targetKey`. Each entry contains only target key,
owner/repository display names, fixed labels, target-policy version, and projection-policy version.
Disabled or partially authorized sessions receive no catalog. API origin, numeric repository and
installation ids, key material, and policy digests remain server-only.

Every non-replay review read and mutation joins the immutable payload and recomputes its SHA-256 over
the exact canonical bytes. Digest drift fails closed. A matching idempotency record is instead the
durable content-free result: it remains replayable for its 365-day ceiling after the terminal payload
and review item have reached their shorter deletion deadline. Reusing that key for a different
command remains a mismatch. A legal hold cannot be placed once the payload expiry is at or before
trusted time; the database repeats this check against its transaction timestamp for direct-write
defense in depth.

Manual duplicate links never modify semantic dedupe groups, HMACs, payloads, receipts, or dedupe
expiry. Private-security routing marks the semantic group restricted so all future payload review
rows in that group inherit private handling and ordinary repository reads exclude the group.
