# Hosted feedback review state contract

Issue #2075 adds one review item for each immutable hosted feedback payload. The V1 states are
`pending`, reserved-but-unreachable `approved`, `duplicate`, `rejected`, `archived`,
`private-security`, and `expired`.

The only exposed disposition actions are `mark-duplicate`, `reject`, `archive`,
`route-private-security`, and system `expire`. Legal-hold placement, release, and expiry are
same-state governance actions. V1 has no approval, reopen, follow-up, annotation, or content-editing
action. The closed rejection reasons are `insufficient-information`, `not-actionable`,
`out-of-scope`, and `policy-violation`.

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
