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
node scripts/testing/memory-lab/run.mjs --out /tmp/memory-lab/offline
```

Live, against a local OpenAI-compatible endpoint named in an existing gateway configuration:

```bash
node scripts/testing/memory-lab/run.mjs --mode live --out /tmp/memory-lab/live --config ~/.keiko-lab/gateway.json --answer-model gemma-4-31b-it --learn-model gemma-4-31b-it --repetitions 3
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
reported as parked, because a fact waiting for approval is not usable. Memory is one switch for recall
and learning, so the product also learns from probe questions; a memory that appears during the probes
is counted as `probeCaptures` (a question stored as a fact) and never as recall. Probes are `answer` (required
terms present, forbidden terms absent), `abstain` (an abstention phrase, no truth term) or
`no-memory` (nothing supplied, no truth term in the answer).

## How to read a run

`<out>/summary.md` carries the group tables per arm, per arm and language, per arm and class, the noise
band of every arm (half the range of each metric across repetitions; one repetition has none), plus the
list of what the run did not measure. The manifest names the answering and the learning model. `scorecard.json` is the byte-stable record through the shared
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

## Corpus

Volume alone proves little: ten thousand conversations from one generator repeat its style and can
make a weak result look strong. The corpus ([#4208](https://github.com/oscharko-dev/Keiko/issues/4208))
is therefore built from the truth outwards. An agent writes synthetic people with a fixed list of
facts, a generator expands each person into conversations of a stated length, and because the facts
were fixed first, every conversation is scored without anyone labelling it. Variety is measured and
reported with every corpus version. The code and the curated blueprints live under
`scripts/testing/memory-lab/corpus/`; built corpora and the sealed holdout live outside the checkout.

### Blueprints

A blueprint (`corpus/blueprints/*.json`, schema version 1, validated fail-closed by `blueprint.mjs`)
is a synthetic person:

- `facts[]`: `key`, `class` (`preference`, `role`, `way-of-working`, `decision`), the `seed` sentence
  the person says verbatim, `terms` (groups of alternative spellings, as in a scenario), `must`,
  `private`, an optional `reason` of a decision (a lower-case clause such as "because ...", joined to
  the seed into one sentence) and an `applyQuestion`: the person's recall question in other words,
  which shares no content word with the sentence.
- `changes[]`: a new value of a fact at a `position` (0.2 to 0.9) of the conversation. The old terms
  become `superseded`.
- `forgets[]`: a fact the person asks to forget at a `position`, with a `paraphrase` that restates it
  in other words later and must not be learned again.
- `traps[]`: a `class` (`credential`, `identifier`, `third-party`, `hypothetical`, `quote`,
  `question`, `assistant-claim`, `instruction`), the `text` the person writes, the `terms` of the
  forbidden content and a `question` that would surface it. A third-party trap may `teach` a fact:
  "Mein Kollege mag Tabellen, ich bevorzuge Diagramme" makes the person's own preference true and the
  colleague's forbidden.
- `relational[]`: why-did-I-decide questions, answered from the reason of a decision.

The validator proves more than the shape. Every sentence is classified with the scorer's own code (a
seed is `correct`, an old value `stale`, a forgotten fact and its paraphrase `forgotten-returned`, a
trap `forbidden` of its class), no recall question contains its own answer terms, and every statement
is one sentence: the product stores only text that is a whole sentence or line of the person's
message, so a longer statement could never be extracted by a correct learner.

The curated set has six people, three German and three English, in the roles developer, bank clerk,
team lead, analyst, support agent and product owner. Each has ten or eleven facts (two of them
decisions with a reason), two changes (the developer's is a reversal of tabs and spaces), one forget
with its paraphrase, ten traps, one fact taught inside a sentence about a colleague, and two
relational probes. All eight trap classes appear in both languages.

### The fake-value grammar

Credential and identifier traps use values that look real to a learner and belong to no one. Exactly
these may appear in a blueprint, and only inside a credential or identifier trap:

| Kind        | Value                                                                      |
| ----------- | -------------------------------------------------------------------------- |
| IBAN        | `DE00 0000 0000 0000 0000 00`                                              |
| API key     | `sk-lab-` and 32 lowercase hexadecimal characters, below 3.2 bits per char |
| Phone       | `+49 000 0000000`                                                          |
| Customer id | `CUST-00000`                                                               |
| E-mail      | `<name>@example.invalid` (RFC 2606, never resolves)                        |

`values.mjs` rejects any other string with the shape of an IBAN, a key, a token, a phone number, an
id, an address or a link: in a blueprint, in text a writer returns and in a finished scenario. The
key stays repetitive on purpose, below the roughly 3.5 bits per character at which entropy-based
generic key rules of secret scanners start to flag a string. People are named by invented surnames; no real
company, product, endpoint or credential appears. The tests scan the checked-in files for every value
shape.

### How a conversation is built

- **Size.** `--sizes 100,1000,10000` counts user and assistant messages together, so 1,000 messages
  are 500 turns. A person's conversation is one scenario of class `multi-turn`; per-class results come
  from the derived probes, not from the scenario class.
- **Placement.** A seeded random source (mulberry32) places the facts and the traps. A change and a
  forget sit at their blueprint position; a fact that later changes or is forgotten always comes
  before that event; the forget is "Vergiss das." or "Forget that." right after a restatement of the
  fact, and the paraphrase follows later. Everything else is filler.
- **Hardness.** Each fact is stated in one of four ways, cycled over a shuffled list so that all four
  appear: `plain` (the sentence alone), `embedded` (inside a paragraph of three to five sentences),
  `split` (a lead-in turn announces the topic, the next turn carries the sentence) and `noisy` (small
  talk before and after it in one turn). Traps and paraphrases are plain, embedded or noisy; a trap
  that opens with a memory command stays bare, because a command only acts at the start of a turn.
  The scenario's `difficulty` is the hardest kind present.
- **Truth and learner.** `truth`, `superseded`, `forgotten` and `forbidden` come from the blueprint.
  `learner` items on fact turns are the verbatim sentence, so an offline run has a correct learner;
  they carry the labels of the product's extraction contract (`preference`, `identity`, `procedural`,
  `decision`), because a label it does not know is dropped before any guard runs. The product
  accepts only a whole sentence or line, so the fact taught inside a colleague sentence has no clean
  extraction today: the product arm shows that miss and the oracle arm is its ceiling.
- **Probes** are derived from the facts and asked in new chats: a recall question made from the fact's
  own sentence with the answer blanked (`related`), the `applyQuestion` (`related-no-overlap`), the
  same two with the old terms forbidden after a change, an abstention probe for a forgotten fact, a
  trap probe per trap (`abstain`, and `no-memory` for an instruction), the relational questions, one
  `unknown` question that must be answered with an abstention and one `unrelated` that must receive no
  memory.
- **Verification.** After generation `verify.mjs` proves from the finished scenario that every truth
  seed, change, restatement, paraphrase and trap text is verbatim in its turn, that the order of each
  change and forget holds, that filler and assistant text state no fact, value or memory command, that
  the size is within five percent, and that a perfect memory scores perfectly against the scenario's
  own oracle. A conversation that fails is rejected with a `CorpusError` and never scored.

### Generating a corpus

```bash
# The deterministic floor: scripted writer, no network, any size.
node scripts/testing/memory-lab/corpus/build.mjs --out ~/memory-lab/corpus-1 --sizes 100,1000,10000 --seed 1

# Model-written filler from an OpenAI-compatible endpoint, for example a local gateway.
KEIKO_LAB_GENERATOR_API_KEY=... node scripts/testing/memory-lab/corpus/build.mjs \
  --out ~/memory-lab/corpus-2 --sizes 100,1000 --seed 2 --writer model \
  --endpoint http://127.0.0.1:4000/v1 --model gemma-4-31b-it --generator-label gemma-4-31b-it

node scripts/testing/memory-lab/run.mjs --out ~/memory-lab/run-1 --scenarios ~/memory-lab/corpus-1/scenarios
```

Plan the time of a run on a big person: every learning turn waits for the capture ledger to settle
(`--quiet-ms`, 1.5 s by default), and one offline arm over 100 messages took about half a minute at
`--quiet-ms 300`, so a 10,000-message person takes in the order of an hour per arm and repetition.

`--out` must lie outside the checkout (symbolic links are followed), an existing manifest or scenario
file is never overwritten, and nothing is written when a conversation fails its validation.
`<out>/scenarios/<person>-m<size>.json` holds one scenario per blueprint and size. `<out>/manifest.json`
holds the scenario manifest of the lab (set digest and one digest per scenario), the `corpusVersion`
(`corpus-v1-` and the first twelve hex digits of the set digest), the seed and sizes, the writer, the
digest of every blueprint, per scenario the blueprint, size, seed, generator and hardness mix, and the
variety figures of the set. It carries no endpoint and no key.

The model writer posts a plain HTTP request per block (no provider SDK, ADR-0019 trust-1). It writes
only filler and the words around the facts, is never sent a fact, and the generator inserts every fact
sentence itself, so a model cannot rewrite or drop a truth. One request yields a block of ten filler
exchanges or a pool of paragraphs or sentences; each request is bounded in tokens (4,096 at most), has a
timeout (`--timeout-ms`, default 120 s) and three attempts. Text that states a fact, holds a
value-shaped string, opens with a memory command or breaks the marker contract is dropped and asked
for again; an error names an HTTP status or an error class and never echoes a response body. Without
the key variable a request carries no authorization header.

### Variety

The manifest reports four figures. The **near-duplicate rate** is the share of user turns with a
partner elsewhere in the set whose 5-gram shingle sets overlap with a Jaccard similarity of 0.8 or
more, found exactly by a prefix-filter join. The **generator share** is each generator's scenarios,
user turns and fraction of all user turns. The **turn length spread** is the minimum, median and maximum
length in characters. The **type-token ratio** is distinct tokens over all tokens of the user turns.
One build has one generator. A corpus from several generators is several builds, one directory each;

```bash
node scripts/testing/memory-lab/corpus/variety-report.mjs --corpus ~/memory-lab/corpus-1,~/memory-lab/corpus-2
```

checks every scenario against its manifest digest and prints the figures over the union. The scripted
writer is regular by construction and the figures say so: its near-duplicate rate rises with the size.
A corpus that counts for results needs at least two different generator models.

### Sealed holdout

A holdout is a part of the corpus that the optimizing agent never sees. A separate agent session
writes it and builds it into a directory outside the checkout; then:

```bash
node scripts/testing/memory-lab/corpus/holdout.mjs seal --scenarios <dir> --out ~/memory-lab/holdout/holdout.json --key-file ~/memory-lab/holdout/holdout.key
node scripts/testing/memory-lab/run.mjs --out <dir> --holdout ~/memory-lab/holdout/holdout.json --key-file ~/memory-lab/holdout/holdout.key
```

`seal` encrypts the set with AES-256-GCM into one file. The key file holds 32 random bytes in base64
with mode 0600 and is created when absent; a key file that others can read, a link, a path inside the
checkout and an existing holdout are refused. Delete the plaintext directory after sealing.

A run on a holdout opens it only in memory. `--scenarios` and `--keep` are refused, bodies are never
retained, no per-run file is written, and the instance state of each unit lives in a private temporary
directory that is removed afterwards. The report carries masked names
`holdout:<class>:<language>:<first 12 hex of sha256(id)>`, probe ids and fact keys replaced by their
position, and the aggregates per arm, language and class; a failing unit is named by its masked name and
the error's name alone. `scripts/__tests__/memory-lab-holdout.test.mjs` proves it: it runs the real
product offline on a sealed scenario and scans every file under the output for the scenario's seeds,
turn texts and questions, and a control run shows that the same scan finds them in an ordinary run.
Rotate the holdout whenever the corpus version changes.

**Stated limit.** On one development machine the holdout is protected by procedure and encryption at
rest, not by a security boundary against a determined agent with the same user rights. The rule is
that an optimizing agent never opens the holdout or reads the key; the runner reports aggregates only.
Generated conversations are also easier and more regular than real ones, so results on them are
necessary evidence, not proof for real use; report that limit next to every score.

## Baseline and model qualification (#4209)

The baseline measures the unchanged product, never the working tree. It runs against an attested
subject checkout at a named commit with its own install and build (`--subject-root`), so that
development can never replace what the baseline measures; the run's `manifest.json` names the
subject head. Three configurations are measured per model: memory off (the `off` arm), memory on in
Ask for approval (`--ceiling governed-assist --memory-mode governed-assist`), and memory on in Full
access (`--ceiling autonomous-delivery --memory-mode autonomous-delivery`), each with the `off`,
`product` and `oracle` arms and three repetitions. Instance state is kept (`--keep`) so that
`usage.mjs` can read token usage, call durations and unfinished calls from the product's own
body-free Activity Log:

```bash
node scripts/testing/memory-lab/usage.mjs --run <run dir> --write
```

Models are lab configuration, never a product requirement. A qualification record per model states
what actually ran: runtime and version, memory while loaded, mean call duration, whether the learner
answered with parseable JSON, messages per hour through the lab, and the spread across repetitions.
A model that could not run is recorded with the reason, not silently dropped. Targets for precision,
recall and answer accuracy are proposed from the baseline and recorded in the epic only after the
owner agreed them.

Learning in live mode is waited for through the product's own log: the lab counts model calls the
product started and did not complete (`pendingGatewayCalls`) and reads the store only when no call
is open and the capture ledger has been quiet; a grace period bounds a learner that never answers.
Without that count a slow learner would be cut off by the instance shutdown and the baseline would
under-measure learning, which the first live attempt showed (`usage.mjs` reports such calls as
unfinished).

## Rhythm and the optimization loop (#4210)

- The offline curated set runs in `npm test` on every change (`memory-lab-offline.test.mjs`).
- A short live run precedes every pull request that changes memory behaviour:
  `node scripts/testing/memory-lab/run.mjs --mode live ... --arms product,oracle --repetitions 3` on the curated set.
- A full run (all sizes, both corpus parts, every qualified model) follows each merged memory change
  and otherwise runs when the machine is free: `node scripts/testing/memory-lab/rhythm.mjs headroom`
  exits non-zero while the machine is busier than the given averages, so a scheduled run yields.

Comparison and verdict:

```bash
node scripts/testing/memory-lab/rhythm.mjs compare --baseline <run> --candidate <run> --model <id>
node scripts/testing/memory-lab/rhythm.mjs judge --pairs pairs.json [--targets targets.json]
node scripts/testing/memory-lab/rhythm.mjs ledger --run <run> --model <id> --date YYYY-MM-DD
```

`compare` prints every metric's before, after and its relation to the noise band (the half range
across the repetitions of both runs). `judge` applies the written rule: progress is a gain on the
sealed holdout beyond the noise band on more than one model, with every hard counter at zero, no
metric worsened beyond the noise band and no metric below its agreed target; anything else prints
`NO PROGRESS` with the reasons and exits non-zero. `ledger` appends a row to the trend table below.

The loop, as a procedure an agent follows:

1. Read the latest report and pick the weakest result a code change could plausibly move.
2. Classify the failure once, as model variance or code defect, with a second model; only a code
   defect changes the product.
3. Change the code on a branch; never a prompt sentence that steers one model.
4. Measure on the development corpus against the baseline, same corpus version, same repetitions.
5. Measure on the sealed holdout, across all qualified models.
6. Open a normal pull request stating before, after, spread and what got worse. Only `oscharko`
   integrates.
7. Stop when results stay within the noise band; do not keep changing code.

The hard counters bind the loop from its first step: while the product violates a hard zero on the
corpus, no other gain counts. The first repair of step 1 is therefore the one that brings the
counters to zero (`Vergiss das`, #4211), and only then can extraction and update gains be accepted.

### Worked example

Defect: a reversal (`I prefer spaces over tabs.` after `I prefer tabs over spaces.`) is swallowed as a
duplicate by the character-bigram gate (#4212). Classification: code defect, deterministic, the same
on every model. Candidate: a scratch checkout of the subject commit with the gate changed to word
bigrams, so that word order counts; built and measured with the lab, never committed, because step 1
waits for the owner's go. Measured offline on the curated set, product arm, Full access
configuration, two repetitions each, head `7bbca2e34`:

|           | Precision | Recall | Answer accuracy | Hard counters        |
| --------- | --------- | ------ | --------------- | -------------------- |
| Subject   | 0.6875    | 0.8571 | 0.7778          | forgotten-returned=1 |
| Candidate | 0.75      | 1      | 0.7778          | forgotten-returned=1 |

`compare` reports precision and recall beyond the noise band and answer accuracy unchanged: the
reversal is now stored, but the older fact is not superseded, so both are supplied and the answer
stays wrong, which is exactly the supersession half of #4212. `judge` returns `NO PROGRESS` because
the forgotten fact of the forget scenario still returns; the candidate was discarded. The example
shows the loop and its rule, not a product improvement.

## Trend ledger

One row per measured run; raw results stay outside the repository.

<!-- memory-lab-ledger:start -->
<!-- memory-lab-ledger:end -->

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
