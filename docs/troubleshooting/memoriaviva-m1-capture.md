# MemoriaViva Mode-Aware Capture Troubleshooting

This entry addresses cases where the Twin does not learn a stated fact — or learns it under an
unexpected mode — on desktop chat or realtime voice. Each entry follows the troubleshooting guide
format ([Symptom / Root Cause / Diagnostic Steps / Resolution](./README.md)).

Mode-aware capture is governed by [ADR-0146](../adr/ADR-0146-mode-aware-memory-capture.md), which
extends the product-wide autonomy model
([ADR-0129](../adr/ADR-0129-product-wide-authority-and-autonomy-model.md), amended by
[ADR-0138](../adr/ADR-0138-monotonic-product-wide-autonomy-semantics-and-code-task-terminology.md)).
Autonomy-mode names are **Ask for approval** (`governed-assist`), **Supervised workspace**
(`supervised-coding`), and **Full access** (`autonomous-delivery`). All examples use synthetic
content; never paste a real memory body, secret, or customer data into a finding.

## 1. Capture did not run in mode X

| Field             | Value                                                 |
| ----------------- | ----------------------------------------------------- |
| Severity          | Medium                                                |
| Surface           | Local UI (MemoriaViva), desktop chat, realtime voice  |
| Stable identifier | No new row appears in the Memory Journal after a turn |

**Symptom**

A chat turn or a spoken statement contains a durable fact, but no new entry appears in the Memory
Journal (`Journal` header action in the MemoriaViva window) after the turn completes.

**Root Cause**

Capture is gated by several independent, fail-closed conditions evaluated in a fixed order before a
candidate ever reaches the mode-aware decision: the caller's Authority Envelope must be valid and
unexpired, memory must be enabled for the request (`memory-salience.ts`'s
`captureSalientFromTurn`), the turn's salience extraction must yield at least one candidate fact,
the candidate must clear the secret scanner (`scanForSecrets`), and it must clear the category
denylist (default categories: health data, identifiable-third-party statements) before the mode
decision ever runs. A candidate refused by a secret, category, or authority hard denial is
**never** captured or proposed, in any mode — this is by design, not a bug. Separately, in **Ask
for approval** a routine fact is captured as a `proposed` row (visible in the Journal, but not yet
applied) rather than silently dropped — if you expected silent learning, you are likely in a
stricter mode than intended.

**Diagnostic Steps**

1. Open the MemoriaViva window and confirm the **Use MemoriaViva in chat requests** toggle is on;
   if it is off, capture does not run at all for that turn.
2. Open the **Journal** and check for a content-free **Refused** row for the turn in question. A
   Refused row (with no body) confirms a hard denial fired — this is expected behavior, not a
   defect; no memory body or denied input is shown, but a redacted reason code (e.g.
   `denied-category`) may be visible.
3. Confirm the active autonomy mode in **MemoriaViva → Request settings**. In **Ask for approval**
   a routine fact is captured as a `proposed` row, not a silently-applied one; check the Journal
   for a row with the "Awaiting review" indicator rather than assuming nothing happened.
4. For a realtime-voice turn, background capture settles asynchronously (typically within a few
   seconds); voice- and desktop-originated captures are tagged distinctly in the underlying data
   (`voice` vs `conversation-center`) so a future Journal revision can surface it, but today's
   Journal UI renders both surfaces identically — the absence of a visible surface badge is not a
   defect.

**Resolution**

1. If the toggle was off, turn it on and repeat the turn.
2. If a Refused row is present, a fail-closed hard-denial gate (authority, secret, or category)
   rejected the request; this is the boundary working as intended — do not attempt to relax it to
   force a capture through, in any mode.
3. If the row is `proposed` rather than auto-accepted, either select a more permissive mode
   (**Supervised workspace** or **Full access**) in Request settings, or use the Journal's **Keep**
   action to promote the individual proposal.
4. If no row and no Refused marker appear at all, confirm the turn's model response actually
   contains an extractable fact (Keiko does not force-capture every turn — the salience filter is
   intentionally low, not zero).

---

## 2. Selected mode does not stick after reload

| Field             | Value                                                      |
| ----------------- | ---------------------------------------------------------- |
| Severity          | Low                                                        |
| Surface           | Local UI (MemoriaViva), memory autonomy policy persistence |
| Stable identifier | Autonomy control resets to "Ask for approval" after reload |

**Symptom**

The three-mode autonomy control (**Ask for approval / Supervised workspace / Full access**) is set
to a non-default mode, but after reloading the window it shows **Ask for approval** again.

**Root Cause**

The selected mode is persisted server-side and hydrated on mount. A hydrate-seam failure (for
example the persistence route being unreachable) falls back to the safe default — **Ask for
approval** — by design (a hydrate failure must never silently fall back to Full access). This
looks identical to "the setting didn't save" but is a different, fail-closed condition.

**Diagnostic Steps**

1. Look for an inline, content-free error near the autonomy control immediately after reload; its
   presence confirms a hydrate-seam failure rather than a persistence bug.
2. Confirm the change actually persisted at selection time — a persist-seam rejection surfaces a
   redacted error and leaves the previously persisted mode unchanged, so the mode you _think_ you
   selected may never have been written.

**Resolution**

1. If an inline error is present, retry the selection after confirming the local UI/BFF process is
   healthy (`.keiko/ui.log`).
2. If no error was shown, reselect the mode and confirm no error appears this time, then reload to
   verify it now persists.

---

## Related documentation

- [ADR-0146](../adr/ADR-0146-mode-aware-memory-capture.md) — the normative mode-aware capture
  decision (target status by mode, hard-denial precedence, fail-closed defaults).
- [ADR-0129](../adr/ADR-0129-product-wide-authority-and-autonomy-model.md) — the product-wide
  autonomy model and mode vocabulary.
- [Troubleshooting guide](./README.md) — the full local-failure runbook and the entry template.
