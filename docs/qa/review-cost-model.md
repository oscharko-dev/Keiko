# What a model-backed review costs, and what makes it expensive

Operator note for [`keiko-for-quality.yml`](../../.github/workflows/keiko-for-quality.yml). Written
after a single day of development consumed roughly a month's model budget, from numbers measured on
that day rather than estimated.

## The prices, derived from real billing lines

| Meter                  | EUR per 1M tokens |
| ---------------------- | ----------------- |
| `gpt-5.4` input        | 2.17              |
| `gpt-5.4` cached input | 0.22              |
| `gpt-5.4` output       | 13.00             |

Cached input matters more than it looks: in the billing lines that had settled at the time of
writing, 7.4M tokens billed as cached against 6.5M uncached. Repeated reviews of the same pull
request are the case the provider's own prompt cache is best at, so the marginal cost of a
re-review is below the first one even before this workflow's own memoization.

Output is six times the input price but a tiny share of the volume — a review emits findings, not
files. Do not tune for it.

## What a review costs

**Roughly 25k tokens per reviewed file**, derived from the day's _total_ spend — about 96 EUR read
off the credit ledger — against roughly 3,000 file reviews.

That figure does not reconcile with the token counts above, and the reason matters. The Cost
Management API had materialized only about 18% of that day's usage when this was written: 17.86 EUR
of the roughly 96 EUR the ledger already showed. Dividing the _materialized_ token counts by the
same 3,000 file reviews gives about 4.6k per file. Both numbers are real and they measure different
windows. Plan with 25k, because it comes from money actually spent, and expect the materialized
per-file figure to rise toward it as billing settles.

| Change    | First review (empty store)     | Later push (most files unchanged)    |
| --------- | ------------------------------ | ------------------------------------ |
| 5 files   | ~0.15 EUR, completes           | ~0.03 EUR                            |
| 50 files  | ~1.50–3.50 EUR, completes      | ~0.03–0.25 EUR                       |
| 135 files | ~4.50 EUR, **truncated at 2M** | ~0.10 EUR, when a store was retained |

At the 25k planning figure a 135-file change wants roughly 3.4M tokens, which the 4M ceiling
accommodates — it completes, hands off a store, and every later push is cheap. Under the previous
2M ceiling the same change truncated, seeded nothing, and paid in full again on the next push.

Two different thresholds are easy to conflate, and they are far apart:

- the **allotment** meets the cap at about **77 files** — the formula grants 1.3 × 40,000 = 52,000
  tokens per file, and the 4M ceiling divides by that at 76.9, with the line term only lowering it.
  Past this point the engine is handed the ceiling rather than what the formula asked for;
- the run actually **truncates** when consumption reaches 4M, which at the measured 25k per file is
  around **160 files**.

So the ceiling starts binding at roughly half the size where it starts cutting. A change between
those two numbers is capped but still completes.

The ceiling was 2M for one day, while the store was inert. Raising it back to 4M is the cheaper
direction, not a relaxation: a run that exceeds the ceiling settles incomplete, an incomplete run
hands off no store, and such a pull request then pays in full on every push forever. A ceiling low
enough to be hit is self-defeating.

The spread on the first-review column is prompt caching: the lower bound assumes the provider
caches most of the prompt across files, the upper bound assumes none of it.

## What actually made a day expensive

Three multipliers, in the order they cost money. None of them is the price per token.

**A memoization store that never persisted.** Every push sent every file to the model again. The
diagnostics said so plainly — `cache.store_loaded` reported zero entries and `cache.hits` zero on
every run — and nobody was reading them. One 135-file pull request was reviewed twenty-one times in
a day: about 2,800 file reviews dispatched for one piece of work.

Those diagnostics measure this workflow's own memoization, not what the provider billed. The
provider's prompt cache still applied — that is where the 7.4M cached tokens above came from — so
the repeats were cheaper than a first review, just not free. Workflow memoization does not compete
with prompt caching: it removes the model call entirely, where caching only makes it cost less.

**The same work on two branches.** The same audit ran on two branches of the same change, so every
review of it was paid for twice.

**A ceiling that a large change can exhaust — still true here today.** A review that runs out of
budget settles _incomplete_, and an incomplete run persists no store, so a large pull request never
converges: every push starts empty and spends the ceiling again. A _lower_ ceiling makes this worse
rather than better, by turning more pull requests into the non-converging case.

Do not read this one in the past tense. The upstream fix exists — Keiko-for-Quality#75 lets a
truncated run keep the verdicts for files it actually reached — but **this repository does not have
it yet**, and adopting it takes two steps, not one:

1. advance the pin to a release carrying #75; and
2. move the store hand-off and the signing job off `outcome == 'complete'` and onto the
   `store_written` output (Keiko-for-Quality#78), because budget exhaustion still settles
   `INCOMPLETE` — without this the store is written on the review runner and stranded there.

Until both are done, a large pull request here re-prices every file on every push **for as long as
it has no retained complete store to fall back on**. The locator takes the newest eligible
same-named artifact rather than the previous run's, so a pull request that completed while it was
smaller keeps benefiting from that older store until the seven-day retention expires; the
non-converging case is the one that has never completed under its current identity. Either way the
honest budget response is to split the change rather than to raise or lower the ceiling.

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
reported `store_loaded entries:2` and `hits:1 misses:1`.

Both files this document was introduced with are review-relevant, including this one: the profile's
`docs/qa/**/*.md` entry wins over the broader prose exclusion. Worth knowing before predicting what
a change will cost — "it is only documentation" is not the same as "it is not reviewed."

## Levers, strongest first

1. **Keep the store working.** It is the only mechanism with a factor-of-twenty effect. Everything
   else is a factor of two or three.
2. **Do not review the same change twice.** One branch per piece of work.
3. **`token_budget`** is a ceiling, not a spend: the action allots
   `min(ceiling, clamp(1.3 × (files × 40k + lines × 60), 80k, 6M))`, so ordinary pull requests sit
   far below it and lowering it changes nothing for them. It binds only large changes — and a change
   it truncates settles incomplete, which publishes a blocking conversation rather than passing
   silently.

## Stopping spend in an emergency

Setting `KEIKO_QUALITY_ENABLED` to `false` stops new jobs but does **not** touch runs already
requested, queued, or in progress — those keep their credentials until they finish or time out. The
complete two-step containment, including the cancellation loop that checks its own query limit, is
in [the troubleshooting entry](../troubleshooting/model-review-spend.md).
