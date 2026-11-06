# ADR-0146: Mode-aware memory capture

## Status

Accepted (Issue #2546, Epic #2537, Memory M1.1, 2026-07-19). Amended by Issue #2549
(Memory M1.4, 2026-07-19) to add the user-selected requested-mode surface described in D1.
Amended by Issue #2864 (2026-07-31) to record that standing and opportunistic maintenance apply
the same D2 autonomy gate before unattended promotion. Amended by Issue #2885 (2026-08-02) to make
the mapping apply uniformly to salience, explicit chat intent, voice recap, and
capture-from-conversation. Amended by Issue #4211 (2026-11-05) to add D4b: a person's clear statement
in a chat acts at once in every mode. Amended by Issue #4212 (2026-11-05) to add D4c: deterministic
checks decide what is learned from conversation and when it replaces an older fact.

## Amends

This decision extends [ADR-0129](ADR-0129-product-wide-authority-and-autonomy-model.md) D1/D6 to
the MemoriaViva memory-capture surface. It does not change any mode value, matrix cell, Authority
Envelope field, or hard denial that ADR-0124, ADR-0129, or ADR-0138 define; it maps one more
surface onto the existing vocabulary, as D6 requires.

## Context

MemoriaViva turn capture (`captureSalientFromTurn` in
`packages/keiko-server/src/memory-salience.ts`) is live and default-on: every desktop and
voice chat turn is scanned for salient candidates and, subject to a single boolean gate
(`request.memory.enabled` and a provisioned vault), persisted through
`persistSalienceActions` → `persistCandidate`. The persisted `status` a candidate receives today
is a fixed function of content alone — secret bodies are dropped, `restricted` sensitivity is
rejected, `confidential` sensitivity is capped at `proposed`, and every other public/routine
candidate is inserted as `proposed` — with no notion of the user's currently selected autonomy
posture.

ADR-0129 D1 declares that every autonomy-capable surface in Keiko, current and future, is governed
by the three product-wide modes (`governed-assist`, `supervised-coding`, `autonomous-delivery`)
and D6 requires new autonomy-surface decision records to cite it and document their mapping onto
the shared vocabulary. Memory capture predates that rule and never made this mapping: today a user
in **Ask for approval** and a user in **Full access** get byte-identical capture behavior, even
though the product's stated meaning of Full access is that validated, in-envelope work proceeds
without per-action review. Epic #2537 (MemoriaViva program) and its Wave 1 (#2546–#2551) close this
gap. The companion Memory Journal (#2547's capture-decision projection, rendered by #2548's
Journal UI, M1.2/M1.3) will render the `proposed` vs. `accepted` distinction this ADR establishes,
so the distinction must be meaningful before the Journal ships.

This ADR establishes memory capture as a governed autonomy-capable surface and fixes the one
open design question: what does mode *do* to a capture outcome, and where does that decision sit
relative to the content-based hard denials that already exist.

## Decision

### D1 — Memory capture reuses the canonical vocabulary and bounds a requested mode

Memory capture consumes `CodingWorkbenchMode` from `@oscharko-dev/keiko-contracts`
(`coding-workbench.ts`), exactly as ADR-0129 D5 requires of a non-coding surface borrowing the
coding-flavored contract home. No memory-local mode union, approval vocabulary, ordering, or
parallel authority evaluator is introduced.

The MemoriaViva settings surface stores one user-selected **requested mode** in the existing local
UI SQLite store and projects it with a server-owned monotonic `revision` through
`GET`/`PUT /api/memory/autonomy-policy`. Every `PUT` supplies the revision it observed. An exact
revision may apply any valid mode; a stale revision may apply only a strictly lower-authority mode.
A stale equal or authority-widening request fails with a content-free conflict. This conditional
write is atomic in the store, so a higher-authority request whose client deadline expires can never
land after and overwrite a later downgrade. Desktop chat adds that canonical value to the existing
`ConversationMemoryRequestWire.mode?` field. The field is optional: an absent field preserves the
pre-amendment request shape and behavior.

The effective mode remains server-owned. For a request that carries a mode, the server resolves
`min(requested mode, deps.codingRuntimeDeploymentCeiling)` through the canonical
`resolveEffectiveCodingWorkbenchMode` helper. A client therefore cannot widen authority beyond the
configured deployment ceiling. An unknown or malformed value is rejected at the BFF boundary; a
missing or malformed ceiling fails closed to `governed-assist`. For legacy callers that omit
`mode`, capture keeps the original #2546 behavior and uses the validated deployment ceiling. This
preserves existing integrations byte-for-byte while letting the local human choose a narrower
memory posture or request a higher posture that remains capped by server policy.

### D2 — Per-mode target-status mapping for persistable candidates

For a candidate that already survives the existing content gates (D3, unchanged), the resolved
mode decides the persisted `status`:

| Mode | Routine, public-sensitivity candidate |
| --- | --- |
| `governed-assist` (Ask for approval) | `proposed` — held for human review, suppressed from retrieval |
| `supervised-coding` (Supervised workspace) | `accepted` — routine capture proceeds unattended |
| `autonomous-delivery` (Full access) | `accepted` — routine capture proceeds unattended |

`proposed` records are held in the review queue and are excluded from retrieval, which reads only
`accepted` memories; `accepted` records are immediately retrievable. This gives capture the same
shape the coding matrix already has for effectful, non-hard-denied work: the lowest posture asks
first, the two higher postures proceed. Per ADR-0138's normative monotonicity invariant, raising
the mode may only relax or preserve this outcome, never tighten it — there is no mode in which a
routine-public candidate is accepted at a lower posture but held at a higher one.

`accepted` is not a bare status flip; D4 routes it through the existing governance promotion lever,
so a mode of `supervised-coding` or `autonomous-delivery` is necessary but not sufficient for
`accepted` — see D4.

### D3 — Mode-independent hard denials are evaluated first and stay invariant across modes

Consistent with ADR-0129 D3 ("hard denials stay mode-independent" — extended here from authority
denials to content-triggered ones), the following gates run **before** any mode decision and are
identical in every mode:

- **Secret-bearing candidate bodies** (`scanForSecrets`) are dropped during extraction; they never
  become a persistable candidate, in any mode, and produce zero persisted records.
- **`confidential`-classified candidates** (`classifySensitivity`) are marked `requiresApproval`
  and are therefore never mode-eligible for `accepted`; they are capped at `proposed` in every
  mode, including `autonomous-delivery`.
- **`restricted`-classified candidates** are rejected at persist time (`isPersistableMemoryCandidate`)
  in every mode; no record is written.

Mode changes what happens to a candidate that has already cleared these gates. It never widens
what clears them.

### D4 — `accepted` is routed through the existing governance promotion lever

When D1–D3 make a candidate mode-eligible for `accepted`, the record is **not** inserted as
`accepted` by a new, capture-local decision. It is passed to the existing promotion planner,
`planMemoryMaintenance` (`@oscharko-dev/keiko-memory-governance`, the same function the standing
maintenance sweep calls via `memory-maintenance-handlers.ts`), which applies its own unchanged
`shouldPromote` gate — `status: "proposed"`, `sensitivity: "public"`, and
`strength >= promoteStrength`, where a fresh record's strength is approximated by its provenance
confidence. Only if the plan promotes the record is it inserted with `status: "accepted"`; otherwise
it is inserted `proposed`, exactly as it would be in `governed-assist`. Mode-eligibility is
therefore a gate on top of governance, not a bypass of it: a mode-eligible but low-confidence
candidate in `supervised-coding` still lands as `proposed`.

This is a deliberate reuse decision, not an optimization. Every live capture entry point — salience,
the explicit chat-intent extractor, voice recap, and capture-from-conversation — resolves the same
mode and delegates eligible records to `promoteEligibleMemoryRecord` in
`memory-capture-policy.ts`. That helper owns the single
`planMemoryMaintenance`/`shouldPromote` lever. No entry point may persist an eligible record through
a private acceptance rule or remain permanently `proposed` merely because it entered through a
different transport, per §5 of `AGENTS.md`.

**Latent capture-time vs. maintenance divergence (KEIKO-0555).** D4's "one promotion lever" framing
is behaviourally true today because `shouldPromote` is access-history-blind. The two invocations of
`planMemoryMaintenance`, however, ask the same question against different-shaped state:

- Capture-time promotion (`memory-capture-policy.ts::promoteEligibleMemoryRecord`, called by
  `memory-salience.ts::persistCandidate`) invokes `planMemoryMaintenance([record],
  EMPTY_CAPTURE_ACCESS_STATS, { nowMs: record.createdAt })` — a synthetic single-record context with
  an always-empty access-stats map and `nowMs` pinned to the record's own `createdAt` (age always
  zero).
- The standing maintenance sweep (`memory-maintenance-handlers.ts::runPromotionPhase`, Phase 1 of
  `runMemoryMaintenance`) invokes `planMemoryMaintenance(beforePromote, promoteStats,
  { nowMs, policy: planPolicy })` over the full vault snapshot with real access-stats and the
  actual current `nowMs`.

The two calls therefore evaluate the same predicate against different inputs. A future change that
adds an access-history- or age-sensitive term to `shouldPromote` must be checked against BOTH call
sites for behavioural parity — sharing the planner function alone does not currently guarantee that
capture-time and maintenance-time promotion make the same decision. Do not describe the two call
sites as "unified"; the divergence is latent, not resolved.

### D4a — Maintenance promotion uses the same unattended-acceptance gate

Both the explicit maintenance route and the bounded opportunistic maintenance pass resolve the
effective memory autonomy posture from the same persisted requested mode and server deployment
ceiling used by capture. Promotion from `proposed` to `accepted` is unattended acceptance, so the
promotion phase runs only when `memoryUnattendedAcceptanceAllowed` admits that effective posture.
In `governed-assist`, or when the posture is absent or cannot be resolved, promotion is skipped and
proposals remain available for human review. Consolidation, archive, expiry, and forgetting remain
mode-independent because none accepts a proposal on the human's behalf.

This is the maintenance application of D2 and D4, not a maintenance-local authority model. The
standing and opportunistic entry points both delegate to `runMemoryMaintenance`; neither may call
the promotion planner through an alternate path or infer authority from the auto-maintenance
enabled flag.

### D4b — A person's clear statement in a chat acts at once, in every mode

A person's own "Merke dir …" or "Vergiss das" (Issue #4211) is their decision, not unattended
learning, so D2's mapping does not hold it. It needs no model, no approval and no dialog.
`memoryExplicitStatementEligible` routes a public, approval-free `explicit-user-instruction`
candidate through the same promotion lever as D4 in every mode; D3's hard denials stay first, so a
credential is refused and a sensitive body keeps its approval. An instruction to drop the assistant's
rules is refused as `instruction-override` on every capture path, because it would reach each later
answer as a fact; an ordinary wish about how to answer stays a memory. Everything learned from natural
conversation stays under D2. Capture-from-conversation remains a review surface and also stays under D2.
Such a statement lands in the private user scope unless it names a project or workspace, and the
learner does not read its turn, so it cannot store the statement itself.

Only a clear statement acts this way, because it changes memory with no question. "Merke dir" and
"Remember" count, "Speichere" and "Notiere" only with "dass" or a colon, and "Lösche" only with
"die Erinnerung an". "Speichere die Datei" and "Lösche den Cache" are tasks and never reach a memory.
A negation ("Merke dir nicht", "Vergiss den Bericht nicht"), a question, and the idioms "Vergiss es"
and "Forget it" state nothing to store or forget. A named forget reaches a memory only through the
same word or an inflection of it, so "Java" does not reach "JavaScript".

Saying a statement again confirms the existing memory through `recordAccess`, naming the chat,
instead of storing a second record: in the same words without an embedder, and as a paraphrase through the existing
novelty gate with one. A paraphrase of a forgotten fact is suppressed the same way.

"Vergiss das" reaches what the last turn left behind, in any scope of the conversation and
including a parked proposal, and goes through the one forget implementation with its audit preflight
and tombstone. A learned fact names the turn it came from (`sourceMessageIds`), so a slow capture of
an earlier turn that finishes later is not "das"; only a record without that provenance falls back to
its creation time. It also reaches an older memory this chat's last turn touched: one the person
confirmed by saying it again, in any wording, or one the answer drew on (`recordUse`) when that turn
asked a question or said a fact. Both touches name their chat, so another chat or maintenance
touching the memory in the same window never makes it "das", and a touch without a chat never counts.
After any other sentence the memory an answer happened to use is not "das". Every chat path reads the last turn from the conversation, grounded
turns included; with no earlier turn nothing was left behind and no older memory is "das".
If that turn left nothing, "das" is the statement before it, not an older memory; a question or a
pasted document is no such statement, so the person is asked:
`recordForgottenStatements` writes a tombstone in each scope of the conversation, so a later
learning pass stores nothing from it. The statement's text is never written, and a statement that
carries a credential keeps only its hash and never reaches the embedding endpoint. When "das" could
mean several memories, or there is nothing it could mean, the person is asked in one short sentence
and nothing is deleted. A named forget that matches no memory is asked about the same way, because a
clear request is never ignored. Each decision is recorded body-free as `memory.explicit.forget` or
`memory.explicit.remember`.

Only such a statement gets an answer in the chat, because the person asked. `explicitStatement` on the
candidate or rejected action carries that; what is only learned, or a refusal of an ordinary message,
stays out of the chat even with the same status.

### D4c — What is learned from conversation, and when it replaces a fact

The model proposes and deterministic checks decide, on the person's own words only (Issue #4212). In
doubt Keiko learns too little rather than too much, because nobody approves what it learns once
D2 lets a fact through.

- **Form.** A learned memory is the person's own words for one fact: the admitted span, never the
  model's statement, which only shows which fact the span carries. A paraphrase loses the words a
  later question uses, and a measured lab run fell below the answer-accuracy baseline when Keiko
  stored it. A span from inside a sentence starts with a capital letter, a trailing comma or dash is
  dropped, and a resolved leading pronoun is replaced by what it stood for. Provenance keeps the exact
  span of the person's message it rests on (`evidenceSpan`, sealed at rest like the body) and the
  person's turns it came from (`sourceMessageIds`). A decision keeps its reason in the key-value
  payload, and a stated end in the future closes validity; both are parsed from the words, never
  taken from the model. A stated end that has passed means the fact is over, so nothing is stored.
- **Admission.** The span appears verbatim in the person's message and ends at a clause boundary.
  A span that leaves out the first words of its clause ("decided as a team to release …" out of "We
  decided as a team to release …") opens at the start of that clause, at most as far back as a span
  may be long, and every check reads that whole clause, never the fragment; the end is not moved, so
  "Ich mag Tabellen" out of "Ich mag Tabellen nicht" stays dropped. A mark with no space after it
  sits inside a word ("Home-Office") and opens no clause; a bracket opens an aside, so "Anna mag
  Kaffee" in "Ich mag Tee (aber Anna mag Kaffee)" is never the person's clause. The words up to the
  person's own subject are read like the words before the clause, so "Anna says I like tables" and
  "Stell dir vor ich nutze Excel" are dropped with or without a comma, and so is an attribution that
  opens a later clause ("Dass ich Tabellen mag, sagt Anna"); a relative clause or a reason is no
  attribution ("I use vim, which says nothing" stands, "weil Anna es mir sagte" is a third party's). A speech verb counts beside another person (a name, a pronoun, or a noun after an article or possessive such as "the doctor") and never when the person is the one speaking, so "I use Vim, I said", "I told Anna" and "claims processing" stand; the words before the claim run up to its subject ("ich", "I", "wir", "we"), so "My colleague says I …" is read whole, while a condition is read only up to the first word about the person ("Es hilft mir, wenn ich …" stands); being told ("I am told …", "Mir wurde gesagt, …", "Man hat mir gesagt, …") is never the person's own statement; markers such as "laut Anna",
  "angeblich" or "according to" count wherever they frame the claim. The clause is not a question, request,
  quotation, hypothesis, irony, hedge ("Ich glaube, …"), denial or past statement. Tense and
  pronouns are judged on the claim itself, not on its reason or condition, so "Ich nutze Tabellen,
  weil sie übersichtlich sind" stands; a decision, switch or migration made in the past holds now.
  The fact is about the person: labelled `self`, with a first-person word, and naming no one else:
  a titled person, a relation behind a possessive or genitive, a family word, a role a determiner
  points at ("dem Kunden", but not "mit Kunden" or "die Kunden-Tickets"), a partner, another
  person's pronoun in the claim, or a reason in which someone else wants, says or recommends
  something ("weil Anna es so will"). A fact labelled `team` ("We decided as a team to release on
  Tuesdays") is the team's own: it needs "wir" or "we" and the person naming the group as their
  team or project ("als Team", "in unserem Projekt", "our team"), because a bare "wir" may be a
  couple or a household and another group's name ("The marketing team decided …") is no marker. The
  rest of the claim passes every person check above, and the fact is stored only in the project
  scope, never outside a project, and compared only with that scope's facts, so it never confirms or
  replaces a private one; "X und ich" and "Wir und X" name a person and are dropped. A person named
  by their relation (Vermieterin, landlord, Eltern, Oma, "meine Leute") is a third party. A leading pronoun ("Sie beginnen immer mit einer Zusammenfassung") counts as the person's
  own thing only when the model's statement names that thing and the person's previous message in
  the same chat named it as theirs ("meine Berichte"); possessive and noun come from the person's
  words. A kept pronoun or another thing leaves the pronoun unresolved, and the pronoun check drops
  it; "Diese" and "These" open a noun phrase and are no pronoun. People behind a possessive include
  plural roles ("meine Patienten", "my students"); that message reaches the learner as
  context, never as a source, and a person's pronoun stays a third party. Two limits are
  accepted: a bare first name outside these forms cannot be told from a German noun, and an English
  role behind a determiner ("the customer database") is treated as a person, because privacy
  outranks recall. Credentials, IBANs, phone numbers and customer identifiers are refused. The model's statement may paraphrase or translate the span, because the span is what is stored, but it
  keeps the span's polarity, where a verb that rejects its object ("hasse", "avoid") and "ohne"
  count as negation; an inverted statement shows the model misread the fact. Each drop is one closed reason.
- **Confidence** is derived from what the checks saw, never from the model:
  0.4, plus 0.3 for a first-person subject, plus 0.15 when the model's statement covers at least half of the
  span. A thin fact without a subject stays below the D4 promotion gate.
- **Relation.** The model labels `new`, `same`, `update` or `contradiction`; checks confirm it. A
  reversal, a changed number or a changed polarity replaces the older fact on its own. A new value
  in the same slot, or a stated change ("ab jetzt", "from now on"), replaces it only with the
  model's label. A shared preference verb alone is no slot, so "Tabellen" and "Tee" both stand.
  The model's label alone replaces only a one-at-a-time value: an employer ("arbeitet bei"), a home
  ("wohnt in"), a name, or a chosen preference for the same purpose. Another tool or liking needs a
  stated change, and a statement that only adds ("auch", "also") never replaces. A claim of sameness that neither the lexical
  nor the semantic duplicate gate confirms stores nothing. A changed value is never a duplicate.
- **Supersession** reuses the `supersedes` edge, the `superseded` status and the closed validity of
  the human correction path, in one transaction with a precondition on the older fact. Where D2
  asks for approval, the new fact waits as a `correction` with its `corrects` edge, written in the
  same single transaction. A learned fact replaces only what Keiko learned in the person's own scope:
  a clear statement (D4b) and anything outside that scope are fixed, so a learned fact never
  overwrites them. A newer clear statement replaces an older learned fact.
- **Reinforcement.** Only the person strengthens a memory: saying it again records a confirmation.
  An answer that repeats a memory records a use for "Vergiss das" and never a reinforcement, so a
  false memory cannot entrench itself by being repeated back.
- **Forgotten while learning.** A capture still running when the person forgot that turn's
  statement stores nothing from it, because each candidate is also checked against the statement's
  own tombstone.
- **Evidence.** `memory.learn.extraction`, `memory.learn.dropped` and `memory.learn.relation`
  record counts, the source message count and closed reason, label, decision and basis values; no
  words of the person or of a fact enter the Activity Log.

### D5 — Capture stays failure-contained and diagnostics stay content-free

Mode resolution cannot throw (it delegates to the total canonical clamp helper) and
`planMemoryMaintenance` is a pure function; if either path ever throws, it is caught by
`captureSalientFromTurn`'s existing try/catch boundary, which yields `[]` and leaves the chat
response unaffected — capture failure never breaks a turn, mode-aware or not. Where mode
resolution cannot determine an effective mode (D1's fail-closed fallback), the outcome is
`governed-assist`. A failed UI hydration also explicitly restores `governed-assist`, while a failed
persist leaves the previously persisted selection unchanged and surfaces a content-free error.
Revision conflicts are not retried as authority changes: the client retains its prior confirmed
mode and must hydrate fresh state before a widening request can be accepted. A stale downgrade
remains admissible at the atomic store boundary, preserving the safer operator intent regardless of
network completion order.

Diagnostics emitted for a captured turn stay strictly content-free, per the evidence-redaction
invariant in `AGENTS.md` §1/§7: mode plus per-status counts and hashes only, never candidate
bodies or user text.

## Consequences

### Positive

- Memory capture now means what the product's autonomy model says it means: Ask for approval holds
  routine memories for review; Supervised workspace and Full access let them through, subject to the
  same confidence gate the maintenance sweep already enforces.
- The Memory Journal (#2547's projection, #2548's UI, M1.2/M1.3) has a real `proposed` vs.
  `accepted` distinction to render, driven by mode, instead of a distinction that was previously a
  fixed function of content alone.
- Legacy callers that omit `ConversationMemoryRequestWire.mode` are byte-identical to the original
  #2546 behavior: the server-owned deployment ceiling remains the effective capture mode.
- No new capture path, promotion mechanism, mode ordering, or memory-local autonomy model is
  introduced. The additive wire field and policy route reuse the existing request, store, and
  canonical clamp seams.

### Negative

- A `supervised-coding`/`autonomous-delivery` user now gets memories written and made retrievable
  without a review step they may not have anticipated from capture alone; this is the intended
  product meaning of those modes (routine work proceeds unattended) but is a real behavior change
  for existing users who select a higher mode without reading its memory implications.
- The requested mode is surface-selected, but the effective mode is still capped by the
  coding-runtime deployment ceiling. A user can therefore persist Full access while the effective
  mode remains narrower; the policy response exposes both values so this is observable rather than
  a silent widening.
- Routing `accepted` through `planMemoryMaintenance` means a mode-eligible candidate can still land
  as `proposed` if its confidence is below `promoteStrength`; this is correct per D4 but is a subtler
  outcome than "mode decides status," and must be documented for support/triage.

### Neutral

- The confidential/restricted/secret hard denials were already mode-invariant in effect (mode did
  not exist as an input before this ADR); D3 makes that invariance explicit and normative rather
  than changing it.
- No change to the sealed-vault write path (ADR-0035): capture still persists exactly the same
  encrypted record shape through the same vault, regardless of mode.

## Alternatives Considered

### Alternative 1: A memory-local autonomy/approval model

- **Pros**: could be tuned precisely to memory's own risk profile (e.g. a fourth "review batch"
  state) without being constrained by the coding-workbench vocabulary.
- **Cons**: directly contradicts ADR-0129 D1 ("no surface may introduce an additional user-facing
  autonomy mode, a surface-local approval envelope, or a parallel authority stack"); would require
  its own UI, its own persistence, and its own drift-prevention machinery that the shared model
  already provides.
- **Why rejected**: ADR-0129 D1 is not advisory; memory capture is exactly the kind of new
  autonomy-capable surface D6 anticipates, and the shared three-mode ladder already expresses the
  needed graduation (hold for review → proceed unattended).

### Alternative 2: Mode controls a new, capture-local acceptance threshold instead of routing through governance

- **Pros**: would let mode directly set an acceptance bar (e.g. a per-mode confidence cutoff)
  without depending on the shared maintenance planner's `shouldPromote` gate.
- **Cons**: creates a second, capture-local notion of "promotable to accepted" that can drift from
  the standing maintenance sweep's notion, doubling the surface a future change to promotion
  criteria must update and violating the reuse-first rule in `AGENTS.md` §5.
- **Why rejected**: `planMemoryMaintenance`/`shouldPromote` already encodes exactly this judgment
  and already runs against every record in the system; mode-eligibility as a gate in front of it
  achieves the product outcome with one promotion lever, not two.

### Alternative 3: Apply the full ADR-0138 resource/risk matrix to memory capture (map capture onto `workspace-contained`/`external-file` resource scopes and risk tiers)

- **Pros**: maximal consistency with the coding-workbench matrix's shape; a single shared evaluator
  would decide capture the same way it decides editor and connector effects.
- **Cons**: memory capture is not a discrete user-initiated effectful action with a resource scope
  and an approval risk tier — it is a continuous, per-turn background classification of already
  content-gated candidates. Forcing it into the closed `(resource scope, risk)` matrix would require
  either fabricating a resource scope that means nothing outside coding (poor fit, per ADR-0129 D2's
  "genuinely new action classes are added to the shared contracts with an ADR note") or overloading
  an existing one incorrectly.
- **Why rejected**: ADR-0129 D2 requires new action classes to be added deliberately, not implied by
  a forced matrix fit; a direct three-mode → target-status mapping (D2 of this record) is the
  correct-sized mapping for a surface whose only decision is "hold for review, or don't," and it
  remains fully within ADR-0129 D1's product-wide model without inventing a matrix cell that would
  mean nothing to any other consumer of the shared matrix.

## Related

- [ADR-0129](ADR-0129-product-wide-authority-and-autonomy-model.md) — D1 (product-wide model), D2
  (action-class mapping requirement), D3 (mode-independent hard denials), D6 (forward citation
  rule this ADR satisfies).
- [ADR-0138](ADR-0138-monotonic-product-wide-autonomy-semantics-and-code-task-terminology.md) — the
  monotonicity invariant D2 of this record inherits, and the fail-closed-to-`governed-assist` rule
  D1 of this record restates for the capture path.
- [ADR-0124](ADR-0124-coding-autonomy-modes-and-sidecar-runtime-authority.md) — D2's fail-closed
  effective-mode rule, the deployment-ceiling signal this ADR reads.
- [ADR-0035](ADR-0035-memory-vault-encryption-at-rest.md) — the sealed vault memory capture
  continues to persist through unchanged.
- [ADR-0019](ADR-0019-modular-package-architecture.md) — dependency direction; this ADR introduces
  no new package-graph edge and no memory-package type sharing across a sideways boundary.
- [ADR-0117](ADR-0117-type-aware-memory-decay-semanticization.md) — precedent for an additive,
  env-independent, default-preserving technique inside the memory subsystem; this ADR follows the
  same "legacy path stays byte-identical" discipline for callers without a provisioned mode.
- Issue #2546 (Memory M1.1 — mode-aware memory capture); parent Epic #2537 (MemoriaViva program);
  companion Issue #2547 (Memory M1.2 — Memory Journal, renders the `proposed`/`accepted`
  distinction this ADR establishes).

## Date

2026-07-19
