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

Cached input matters more than it looks: on the measured day, 7.4M tokens billed as cached against
6.5M uncached. Repeated reviews of the same pull request are the case the provider's own prompt
cache is best at, so the marginal cost of a re-review is well below the first one even before this
workflow's own memoization.

Output is six times the input price but a tiny share of the volume — a review emits findings, not
files. Do not tune for it.

## What a review costs

Roughly **25k tokens per reviewed file**, from 3,000 file-reviews measured against their billed
cost. So:

| Change    | First review (empty store) | Later push (store hit) |
| --------- | -------------------------- | ---------------------- |
| 5 files   | ~0.15 EUR                  | ~0.03 EUR              |
| 50 files  | ~1.50–3.50 EUR             | ~0.03–0.25 EUR         |
| 135 files | ~4.50 EUR                  | ~0.10 EUR              |

The spread on the first-review column is prompt caching: the lower bound assumes the provider
caches most of the prompt across files, the upper bound assumes none of it.

## What actually made a day expensive

Three multipliers, in the order they cost money. None of them is the price per token.

**A memoization store that never persisted.** Every push re-read every file at full price. The
diagnostics said so plainly — `cache.store_loaded` reported zero entries and `cache.hits` zero on
every run — and nobody was reading them. One 135-file pull request was reviewed twenty-one times
in a day, each time from scratch: about 2,800 full-price file reviews for one piece of work.

**The same work on two branches.** The same audit ran on two branches of the same change, so every
review of it was paid for twice.

**A ceiling that a large change can exhaust.** A review that runs out of budget settles
_incomplete_, and until Keiko-for-Quality#75 an incomplete run persisted nothing — so a large pull
request could never converge, and a _lower_ ceiling made that worse rather than better by turning
more pull requests into the non-converging case.

## How to tell, in ten seconds, whether it is working

Open any reviewer run's log and look for two diagnostics:

```
cache.store_loaded  counts: { entries: N }
cache.hits          counts: { hits: H, misses: M }
```

Both files this document was introduced with are review-relevant, including this one: the
profile's `docs/qa/**/*.md` entry wins over the broader prose exclusion. Worth knowing before
predicting what a change will cost — "it is only documentation" is not the same as "it is not
reviewed."

`entries: 0` on a pull request that has been pushed to before means the store is not persisting —
the expensive failure, and an invisible one. `hits: 0` with a large `misses` on a re-push means the
store loaded but nothing matched: expected after a profile, model, or reviewer-pin change, since
each of those deliberately starts a fresh partition, and a defect otherwise.

A healthy re-push on an unchanged file set reads `hits: M-1, misses: 1`.

## Levers, strongest first

1. **Keep the store working.** It is the only mechanism with a factor-of-twenty effect. Everything
   else is a factor of two or three.
2. **Do not review the same change twice.** One branch per piece of work.
3. **`token_budget`** is a ceiling, not a spend: the action allots
   `min(ceiling, clamp(1.3 × (files × 40k + lines × 60), 80k, 6M))`, so ordinary pull requests sit
   far below it and lowering it changes nothing for them. It binds only large changes — and a
   change it truncates settles incomplete, which publishes a blocking conversation rather than
   passing silently.
4. **`vars.KEIKO_QUALITY_ENABLED`** is the emergency stop. Set it to `false` and the job never
   starts, so the environment's secrets are never materialized and nothing is spent. Nothing else
   in this repository can spend model budget on review.
