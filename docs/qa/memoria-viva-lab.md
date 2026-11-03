# MemoriaViva measurement lab

Tracking: [#4207](https://github.com/oscharko-dev/Keiko/issues/4207) (runner and scorecard),
[#4208](https://github.com/oscharko-dev/Keiko/issues/4208) (corpus),
[#4209](https://github.com/oscharko-dev/Keiko/issues/4209) (baseline),
[#4210](https://github.com/oscharko-dev/Keiko/issues/4210) (rhythm); parent epic
[#4205](https://github.com/oscharko-dev/Keiko/issues/4205).

The lab is the instrument every MemoriaViva step is judged by. It drives the real product the way a
person does: it sends chat turns, lets the product learn, reads what the product stored through the
public routes, then asks questions in new chats and scores the answers. Everything is compared with
facts that were fixed before the conversation was written. The lab never opens the vault file and
never imports a memory package; what it measures is what a user would get.

## Principles

- **The truth comes first.** A scenario fixes its facts, its forbidden content, its turns and its
  questions before any run. The oracle never reaches the product.
- **A scorer that can fail.** Every metric is proven red with a deliberately wrong learner before it
  counts (`scripts/__tests__/memory-lab-score.test.mjs`, `memory-lab-offline.test.mjs`).
- **Three arms in every run.** `off` never enables memory (the floor). `product` learns from the turns
  (the measurement). `oracle` receives the truth facts as a curated store and only answers (the
  ceiling of retrieval and answering). Product minus oracle is extraction and update loss; oracle
  minus perfect is retrieval and answer loss. Without the oracle a red result cannot be classified as
  model or code.
- **No number without a noise band.** Repetitions, seeds where a provider supports them, and the
  spread across repetitions; a difference inside the noise is never reported as progress.
- **No product code.** The lab lives under `scripts/testing/memory-lab/` and `tests/memory-eval/`.
  When a route is missing, that is a finding in the issue, not a test-only route in the product.
- **Body-free where it matters.** Synthetic scenario text may appear in evidence. Real conversations
  (#4208) run with `--no-retain-bodies`, and nothing real enters the repository, an issue, an
  evidence file or the Activity Log.

## How to run

Offline, deterministic, no network, the curated set:

```bash
npm run lab:memory -- --out /tmp/memory-lab/offline
```

Live, against a local OpenAI-compatible endpoint named in an existing gateway configuration:

```bash
npm run lab:memory -- --mode live --out /tmp/memory-lab/live --config ~/.keiko-lab/gateway.json --answer-model gemma-4-31b-it --learn-model gemma-4-31b-it --repetitions 3
```

Useful flags: `--arms off,product,oracle`, `--memory-mode` and `--ceiling` (the three product
configurations of #4209 are memory off, `governed-assist`, and `autonomous-delivery` with the same
ceiling), `--keep` to retain every instance's state directory, `--subject-root <checkout>` to measure
a separately attested baseline checkout, `--broken-learner whole-message|credential|invented` for
the failure-first proofs. `--out` must lie outside the checkout, and a directory that already holds a
scorecard is never overwritten.

The offline curated set runs in `npm test` through `scripts/__tests__/memory-lab-offline.test.mjs`
(two scenarios plus one broken-learner proof, so the suite stays short); the full set is the CLI
run above.

## How it works

Each scenario, arm and repetition gets a fresh instance: the real BFF and Gateway composition of the
chat-skills lab (`scripts/testing/chat-skills-lab/serve.mjs`), forked with a private state
directory, its own random vault key (`KEIKO_MEMORY_KEY`, so the shared macOS Keychain entry is never
touched), the lab's learning model in `KEIKO_MEMORY_SALIENCE_MODEL_ID`, and the requested deployment
ceiling. The instance is driven over HTTP and torn down with its fixture; state is removed unless
`--keep` is given. Repository `.env` keys the BFF would fold in are listed by name in
`manifest.json`; the lab sets every key that matters explicitly so that `.env` cannot change them.

Offline, both model ids point at the scripted model (`scripted-model.mjs`), an OpenAI-compatible
loopback server. The answerer replies `OK.` during learning turns and, during probes, echoes exactly
the memory bodies the product placed inside its untrusted fence, so an offline answer measures
retrieval and injection and nothing else. The learner replies with whatever the scenario queued for
the next extraction call: a correct learner returns the verbatim sentences the scenario names, a
broken one returns the whole message, a credential or an invented fact.

Scoring (`score.mjs`) is deterministic term matching with its own normalization (diacritics, sharp s,
case), independent of the product's tokenizer, so a product change cannot move the ruler. Every
stored memory is classified as correct, stale (matches a superseded fact), unnecessary, forbidden (by
class) or forgotten-returned. Only accepted memories count for precision and recall; proposed ones are
reported as parked, because a fact waiting for approval is not usable. Probes are `answer` (required
terms present, forbidden terms absent), `abstain` (an abstention phrase, no truth term) or
`no-memory` (nothing supplied, no truth term in the answer).

## How to read a run

`<out>/summary.md` carries the group tables per arm, per arm and language, per arm and class, plus the
list of what the run did not measure. `scorecard.json` is the byte-stable record through the shared
accumulator of `tests/memory-eval/scorecard.ts`; two offline runs serialize identically, which the
suite asserts. `timing.json` holds instance start, learning settle and probe latencies and the model
call counts; `manifest.json` names the corpus version, every scenario digest, the product head and the
options. One JSON per run under `runs/` holds the classified store, the probe verdicts, the capture
ledger outcomes and the scripted model's request journal.

Five hard counters must read zero and are never averaged away: credentials stored, customer or
personal identifiers stored, forgotten facts returning, third-party facts in private memory, private
facts in project memory. The deterministic
last line of a run is the harness result (`PASS memory-lab …`); a product verdict is read from the
summary, never from the exit code.

## Scenario format

One JSON file per scenario under `scripts/testing/memory-lab/scenarios/` (schema version 1, validated
fail-closed by `scenario.mjs`):

- `truth[]`: the facts a correct memory holds afterwards, each with a `key`, the exact `seed` body the
  oracle arm stores, `must` (counts for recall), `private` (must never land in project scope) and
  `terms` (groups of alternative spellings; one alternative per group must match).
- `superseded[]`, `forgotten[]`: facts that were true and replaced, or forgotten; a surviving memory
  is stale or a hard violation.
- `forbidden[]`: content that must never be stored, with a class (`credential`, `identifier`,
  `third-party`, `hypothetical`, `quote`, `question`, `assistant-claim`, `instruction`, `other`).
- `turns[]`: what the person writes, with the correct learner's verbatim items for offline runs and an
  optional `memory: false` for a turn written with memory off.
- `probes[]`: questions asked in new chats with an `expect` of kind `answer`, `abstain` or
  `no-memory`.

## Known limits of this version

- **Time.** Decay, validity windows and multi-day gaps cannot be exercised live: the server composes
  `now` as an injected function but exposes no override, and handlers call `Date.now()` directly.
  Time-dependent behaviour stays at package level with deterministic clocks (`tests/memory-eval`),
  which the report states. A lab-only clock through the existing seam remains a decision for #4207
  once step 6 needs it.
- **Answer quality offline** is retrieval and injection quality; a real model's answering is measured
  only live.
- **No judge model** in this version; every verdict is term matching.
- **Live cost accounting** arrives with the baseline (#4209); offline cost comes from the scripted
  model's journal.
- **Forget confirmation.** The product asks a person to confirm a forget; the lab confirms through the
  forget route and records that it had to (`turns[].forgets`), so the baseline measures the end state
  with the confirmation given.
