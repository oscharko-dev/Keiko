# What a model-backed review costs, and what makes it expensive

Operator note for [`keiko-for-quality.yml`](../../.github/workflows/keiko-for-quality.yml). Written
after a single day of development consumed more than a month and a half's model budget — €212.62
against a €130.00 monthly credit. The first version was written the morning after from same-day
readings, and every one of them turned out to be a floor: the credit ledger showed about €96 (45%
of the final figure) and the Cost Management API €17.86 (8%). The numbers below are the settled
ones, and each carries its derivation.

## The prices, derived from real billing lines

| Meter                  | EUR per 1M tokens |
| ---------------------- | ----------------- |
| `gpt-5.4` input        | 2.17              |
| `gpt-5.4` cached input | 0.22              |
| `gpt-5.4` output       | 13.00             |

Cached input matters more than it looks: on the settled day, 56.8M input tokens billed as cached
(€12.49) against 76.3M uncached (€165.56) — 43% of the input volume for 7% of the input cost.
Without the provider's cache the same day would have cost about €111 more. Repeated reviews of the
same pull request are the case the provider's own prompt cache is best at, so the marginal cost of
a re-review is below the first one even before this workflow's own memoization.

A fourth meter family, long-context input and output, appeared on the settled day at about €12.25 —
under 6% of the total. It prices tokens beyond the standard context window higher; the share is
small enough that this document does not plan around it.

Output is six times the input price but a tiny share of the volume — a review emits findings, not
files. Do not tune for it.

## What a review costs

**Roughly 44k input tokens ≈ €0.07 per reviewed file**, derived from the settled day: €212.62 and
133.1M standard input tokens across roughly 3,000 file reviews. The figure reconciles three ways:
the incident change ran twenty-one completed reviews at 5.5–6M tokens each (its 135 files met the
6M allotment almost exactly), twenty-one times ~5.7M plus the day's small-change tail is the 133M
the meters billed, and €212.62 over ~3,000 files is €0.071.

An earlier version of this paragraph planned with 25k, derived from "about 96 EUR read off the
credit ledger against roughly 3,000 file reviews", and told the reader to expect the materialized
per-file figure to rise toward it as billing settled. It rose past it — the ledger itself was only
45% settled when read. The lesson is sharper than "billing lags": a same-day reading of either
source is a floor, not a total, so re-derive before quoting once the meters settle. One caveat
survives into the settled figure: the day was dominated by one audit change carrying large
evidence files, so 44k/€0.07 is the measured average of a heavy mix. A lighter source-file change
lands below it; no lighter day has settled yet to say how far.

| Change    | First review (empty store)                 | Later push (store hits, context intact) |
| --------- | ------------------------------------------ | --------------------------------------- |
| 5 files   | ~0.25–0.45 EUR, completes                  | ~0.03–0.10 EUR                          |
| 50 files  | ~2.50–4.50 EUR, completes                  | ~0.05–0.50 EUR                          |
| 135 files | ~8–13 EUR, completes at the ceiling's edge | ~0.20 EUR, when a store was retained    |

The 135-file figure is measured, not modelled: the incident change was exactly this size, and one
full review of it consumed 5.5–6M tokens — €12–13 with a cold prompt cache, €8–9 on warmed
repeats, roughly €9.50 per completed review on average. That average subtracts what the day's
total does not belong to this change: of €212.62, about €10 was the small-change tail and €4–6
corpus qualification runs, leaving ≈€199 across 21 completed reviews. This row has now
been wrong twice — first €3.40 (3.4M tokens misread as euros), then €4.30–7.30, whose floor
divided the unsettled €96 ledger figure — which is why every number in this document carries its
derivation inline.

The settled meters put that same change at 5.5–6M tokens per full review — essentially the whole
6M ceiling, not the comfortable 3.4M an earlier version claimed. It completed, but at the edge.
Under the 2M ceiling the same change truncated, seeded nothing, and paid in full again on the next
push. The worst case the ceiling permits is unchanged — a single run of 6M, roughly 7 to 13 EUR
depending on prompt-cache hit rate — but the size that reaches it is smaller than previously
written: a heavy 135-file change is already there.

Two different thresholds are easy to conflate, and how far apart they sit depends on the change:

- the **allotment** meets the cap at about **72 files** (action v0.13.0) — the formula grants
  1.3 × 64,000 = 83,200 tokens per file, and the 6M ceiling divides by that at 72.1, with the line
  term only lowering it. Past this point the engine is handed the ceiling rather than what the
  formula asked for. (Under the pre-v0.13.0 coefficient of 40k/file this threshold sat at ~115
  files; the coefficient moved to the measured live median after the 40k figure under-priced a
  55-file run into a truncated 7.1M double-pay — Keiko#2981.);
- the run actually **truncates** when consumption reaches 6M — around **90–135 files** depending
  on the change's weight (the incident-class heavy mix measured ~65k/file live, which reaches 6M
  near 92 files; lighter mixes sit further out). An earlier version said 240, from the unsettled
  25k-per-file figure.

So how far apart the two thresholds sit is a property of the change's weight, not of the formula:
a heavy change is capped at 72 and truncates not far past it — the thresholds nearly touch — while
a light change keeps real headroom between them. A change between the two numbers is capped but
still completes.

The ceiling was 2M for one day, while the store was inert. It now sits at 6M, which is the largest
value that has any effect at all: the action's allotment formula clamps at 6,000,000 before this
input applies, so a bigger number would be inert. Raising it is the cheaper direction, not a
relaxation: a run that exceeds the ceiling settles incomplete and an incomplete
run hands off no store, so a pull request that has **never completed under its current identity**
pays in full on every push. One that completed while it was smaller keeps replaying that older
store until retention expires. A ceiling low enough to be hit is self-defeating for the first
group, which is the group that costs money.

The spread on the first-review column is prompt caching: the lower bound assumes the provider
caches most of the prompt across files, the upper bound assumes none of it.

The later-push column is the store's best case, and production shows the full range. Measured on
2026-08-03 across three pull requests: one paid 3 of 35 reviewable files on a later push (32 store
hits — about a tenth of a first review), one paid roughly half per push, and one paid all 19 of
its files on every push because each push kept invalidating the stored context
(`cache.context_invalidated: 12`). That last case is the store working as designed: a verdict is
deliberately not replayed once the surroundings it was formed under have moved. A push costs
anywhere from a tenth of the first review to all of it, and two terms add up to it: the directly
changed files, which by definition can never replay, and every unchanged file whose bound context
moved. The first term is the push's own size; the second is its coupling — which is why a small
push into shared context can still cost the whole review.

## What actually made a day expensive

Three multipliers, in the order they cost money. None of them is the price per token.

**A memoization store that never persisted.** Every push sent every file to the model again. The
diagnostics said so plainly — `cache.store_loaded` reported zero entries and `cache.hits` zero on
every run — and nobody was reading them. One 135-file pull request was reviewed twenty-one times in
a day: about 2,800 file reviews dispatched for one piece of work.

Those diagnostics measure this workflow's own memoization, not what the provider billed. The
provider's prompt cache still applied — that is where the 56.8M cached tokens above came from — so
the repeats were cheaper than a first review, just not free. Workflow memoization does not compete
with prompt caching: it removes the model call entirely, where caching only makes it cost less.

**The same work on two branches.** The same audit ran on two branches of the same change, so every
review of it was paid for twice.

**A ceiling that a large change can exhaust — still true here today.** A review that runs out of
budget settles _incomplete_, and an incomplete run persists no store, so a large pull request never
converges: every push starts empty and spends the ceiling again. A _lower_ ceiling makes this worse
rather than better, by turning more pull requests into the non-converging case.

Read this one in the past tense since the v0.11.0 repin: the pin carries Keiko-for-Quality#76 (a
truncated run keeps the verdicts for files it actually reached) and the workflow's store hand-off
and signing job gate on the action's `store_written` output (#78) instead of
`outcome == 'complete'` — both halves of the adoption landed together, because either alone
changes nothing. A truncated run now seeds the store it earned, so the non-converging "cold set"
shrinks to pull requests whose very first run fails before reaching any file. The locator behavior
is unchanged: it takes the newest eligible same-named artifact, so an older complete store inside
the seven-day retention still serves. Splitting an oversized change remains cheaper than arguing
with the ceiling.

## How to tell whether memoization is working

Open a reviewer run's log and look for two diagnostics:

```text
cache.store_loaded  counts: { entries: N }
cache.hits          counts: { hits: H, misses: M }
```

`hits` and `misses` count **files, not pushes**. A push that changes three of twenty reviewable
files reads `hits: 17, misses: 3` — one miss per changed or uncached file. Several misses at once
are normal.

`entries: 0` on a pull request that has been pushed to before is the expensive failure, and an
invisible one: nothing goes red, findings still publish, and only the bill moves. It is also
legitimate in several ordinary cases, so diagnosing it correctly matters —
[the troubleshooting entry](../troubleshooting/model-review-spend.md) lists which cold starts are
expected and how to tell a real persistence failure from one of them.

Measured end to end on 2026-08-03: a first run reported `store_loaded entries:0`, then
`hits:0 misses:2`, and appended two entries; the next push, changing only one of the two files,
reported `store_loaded entries:2` and `hits:1 misses:1`. At production scale the same day, a
36-file pull request (35 reviewable, 1 excluded) reported `hits: 32, misses: 3` on a later push —
the store replayed 91% of the files (32 of 35). That is a file hit rate, not an avoided-spend
percentage — these diagnostics count files, and spend varies by file weight.

Both files this document was introduced with are review-relevant, including this one: the profile's
`docs/qa/**/*.md` entry wins over the broader prose exclusion. Worth knowing before predicting what
a change will cost — "it is only documentation" is not the same as "it is not reviewed."

## Levers, strongest first

1. **Keep the store working.** It is the only mechanism with a factor-of-twenty effect. Everything
   else is a factor of two or three.
2. **Do not review the same change twice.** One branch per piece of work.
3. **`token_budget`** is a ceiling, not a spend: the action (v0.13.0) allots
   `min(ceiling, clamp(1.3 × (files × 64k + lines × 60), 150k, 6M))`, so ordinary pull requests sit
   far below it and lowering it changes nothing for them. It binds only large changes — and a change
   it truncates settles incomplete, which publishes a blocking conversation rather than passing
   silently.

## Stopping spend in an emergency

Setting `KEIKO_QUALITY_ENABLED` to `false` stops new jobs but does **not** touch runs already
requested, queued, or in progress — those keep their credentials until they finish or time out. The
complete two-step containment, including the cancellation loop that checks its own query limit, is
in [the troubleshooting entry](../troubleshooting/model-review-spend.md).
