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

| Change    | First review (empty store) | Later push (most files unchanged) |
| --------- | -------------------------- | --------------------------------- |
| 5 files   | ~0.15 EUR                  | ~0.03 EUR                         |
| 50 files  | ~1.50–3.50 EUR             | ~0.03–0.25 EUR                    |
| 135 files | ~4.50 EUR                  | ~0.10 EUR                         |

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

**A ceiling that a large change can exhaust.** A review that runs out of budget settles _incomplete_,
and until Keiko-for-Quality#75 an incomplete run persisted nothing — so a large pull request could
never converge, and a _lower_ ceiling made that worse rather than better by turning more pull
requests into the non-converging case.

## How to tell whether memoization is working

Open a reviewer run's log and look for two diagnostics:

```text
cache.store_loaded  counts: { entries: N }
cache.hits          counts: { hits: H, misses: M }
```

Both files this document was introduced with are review-relevant, including this one: the profile's
`docs/qa/**/*.md` entry wins over the broader prose exclusion. Worth knowing before predicting what
a change will cost — "it is only documentation" is not the same as "it is not reviewed."

**`entries: 0` is a defect only under specific conditions.** A cold start is expected and correct
after any of these, because each one deliberately begins a fresh partition or leaves none to find:

- a change to `.github/keiko-for-quality.json`, the model id, the model protocol, or the reviewer
  pin — all four are hashed into the store's artifact name and bound into its signature context;
- the seven-day artifact retention expiring;
- the previous run settling incomplete for a reason that persists nothing;
- the store being disabled for that run, which the log states explicitly.

Suspect persistence only when a prior run under the _same_ identity completed inside the retention
window and this run still loads nothing.

**`hits` and `misses` count files, not pushes.** A push that changes three of twenty reviewable
files reads `hits: 17, misses: 3` — one miss per changed or uncached file. Several misses at once
are normal and are not evidence of a defect by themselves.

Measured end to end on 2026-08-03: a first run reported `store_loaded entries:0`, then
`hits:0 misses:2`, and appended two entries; the next push, changing only one of the two files,
reported `store_loaded entries:2` and `hits:1 misses:1`.

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

Two steps, and the first alone is not enough.

1. Set `vars.KEIKO_QUALITY_ENABLED` to `false`, so no new job starts and the environment's secrets
   are never materialized for one.
2. **Cancel every run already requested, queued, or in progress.** The variable does not touch
   them: a run that has started keeps its credentials and can keep spending until it finishes or
   reaches the thirty-minute job timeout.

```bash
gh api -X PATCH repos/<owner>/<repo>/actions/variables/KEIKO_QUALITY_ENABLED \
  -f name=KEIKO_QUALITY_ENABLED -f value=false
gh run list --workflow keiko-for-quality --json databaseId,status \
  --jq '.[] | select(.status != "completed") | .databaseId' | xargs -r -n1 gh run cancel
```

The full disable procedure, including what to record afterwards, is in
[`keiko-for-quality.md`](keiko-for-quality.md). Nothing else in this repository can spend model
budget on review; the scheduled re-qualification lives in the product repository, not here.
