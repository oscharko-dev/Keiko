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
  (#4208) never have a body retained (the runner enforces it per scenario, see "Isolation"), and
  nothing real enters the repository, an issue, an evidence file or the Activity Log.

## How to run

Offline, deterministic, no network, the curated set:

```bash
node scripts/testing/memory-lab/run.mjs --out /tmp/memory-lab/offline
```

Live, against a local OpenAI-compatible endpoint named in an existing gateway configuration:

```bash
node scripts/testing/memory-lab/run.mjs --mode live --out /tmp/memory-lab/live --config ~/.keiko-lab/gateway.json --answer-model gemma-4-31b-it --learn-model gemma-4-31b-it --repetitions 3
```

Useful flags: `--arms off,product,oracle`, `--memory-mode` and `--ceiling`, `--keep` to retain every
instance's state directory (refused for real conversations), `--subject-root <checkout>` to measure a
separately attested baseline checkout, `--broken-learner whole-message|credential|invented` for the
failure-first proofs, `--allow-folded-env` (see "Isolation"). `--out` must lie outside the checkout and
outside every other git work tree, and a directory that already holds a scorecard is never
overwritten.

`--memory-mode` and `--ceiling` both default to `autonomous-delivery` (Full access), the
configuration in which a learned fact is stored at all. In `governed-assist` (Ask for approval)
every learned fact is parked as `proposed`, so recall is zero for any learner and a result there says
nothing about extraction; that configuration is measured explicitly for the baseline of #4209 with
`--ceiling governed-assist --memory-mode governed-assist`. The three product configurations of #4209
are memory off (the `off` arm), `governed-assist`, and `autonomous-delivery` with the same ceiling.

The exit code is 0 when the run completed, 4 with `--fail-on-hard-counters` when a product-arm hard
counter is above zero, and 5 when a unit could not be measured.

The offline curated set runs in `npm test` through `scripts/__tests__/memory-lab-offline.test.mjs`
(three scenarios plus one broken-learner proof, so the suite stays short); the full set is the CLI
run above. The proof is a pair: for the same scenario the correct learner turns the store green and
the related question is answered, and the whole-message learner turns it red with precision 0. Both
halves run in Full access; in Ask for approval the "red" half would hold for the correct learner too.

## How it works

Each scenario, arm and repetition (a unit) gets a fresh instance: the real BFF and Gateway
composition of the chat-skills lab (`scripts/testing/chat-skills-lab/serve.mjs`), forked with a
private state directory, its own random vault key (`KEIKO_MEMORY_KEY`, so the shared macOS Keychain
entry is never touched), the lab's learning model in `KEIKO_MEMORY_SALIENCE_MODEL_ID`, and the
requested deployment ceiling. The instance is driven over HTTP and torn down with its fixture; state
is removed unless `--keep` is given. The state directory is named
`<scenario>-<arm>-r<repetition>-<random>`, which `usage.mjs` reads back. A server whose parent died
exits on its own when the parent's IPC channel closes.

**A unit that cannot be measured costs that unit, not the run.** Any error inside a unit (an instance
that does not start, a request that fails, learning that does not settle in time) is recorded as a
result with an `error` (the error's class name, and a message with paths and credential shapes
removed where scenario text may appear in evidence; a sealed holdout and real conversations keep the
name alone), an empty store and no probes. The scorecard gets a failed store entry with the evidence
`unit-failed:<name>`, the summary counts `failedUnits` and lists them, the units are left out of every
average (a failed unit must neither lift nor lower a group), the last line turns into `FAIL
memory-lab ... failed-units=N` and the exit code is 5. A refused configuration is different: it would
fail every unit, so it ends the run (see "Isolation").

**Reading the store and the ledger.** The memory list route serves 200 rows per page, newest first,
and the capture ledger route has no offset. The lab pages through the list with `offset` until the
reported `total` is reached and through the ledger by time (`since` is inclusive, decisions already
read are dropped by their event id), so a store or a ledger of more than 200 rows is read whole. It
fails, naming the reason, when the total changes between pages, when a page is empty before the total
is reached, or when more than a page of decisions share one millisecond. The quiet detector of the
learning wait compares the ledger's `total`, not a row count, so it keeps seeing growth past the
first page.

Offline, both model ids point at the scripted model (`scripted-model.mjs`), an OpenAI-compatible
loopback server. The answerer replies `OK.` during learning turns and, during probes, echoes exactly
the memory bodies the product placed inside its untrusted fence, so an offline answer measures
retrieval and injection and nothing else. The learner replies with whatever the scenario queued for
the next extraction call: a correct learner returns the verbatim sentences the scenario names, a
broken one returns the whole message, a credential or an invented fact.

Scoring (`score.mjs`) is deterministic term matching with its own normalization (typographic quotes
and apostrophes folded to ASCII, diacritics, sharp s, case), independent of the product's tokenizer,
so a product change cannot move the ruler. A term matches as whole words: `react` is not found in
`reaction`, `2` not in `12`, and a term that itself ends in punctuation (`sk-lab-`) needs no boundary
there. Inflected spellings are listed as alternatives of a term group, never matched by a stem.

Every stored memory is classified as correct, stale (matches a superseded fact), unnecessary,
forbidden (by class) or forgotten-returned. **A body that contains the product's redaction
placeholder `[REDACTED]` is a credential.** `GET /api/memory` redacts every stored body on the wire, so
a stored secret reaches the lab only as that placeholder and its own forbidden terms can no longer
match; whatever the product had to redact on output counts as a stored credential (an IBAN, which the
redactor also removes, is therefore counted as a credential too). A scenario whose own text contains
`[REDACTED]` is exempt. Only accepted memories count for precision and recall; proposed ones are
reported as parked, because a fact waiting for approval is not usable, and `forbiddenParked` counts
the non-live memories with a forbidden verdict (the hard counters count them either way). Memory is
one switch for recall and learning, so the product also learns from probe questions; a memory that
appears during the probes is counted as `probeCaptures` (a question stored as a fact) and never as
recall.

Probes are `answer`, `abstain` or `no-memory`. An `answer` probe passes when its terms are present
and its forbidden terms are absent, and fails when a forgotten or forbidden fact of the scenario
appears in the answer. An `abstain` probe passes with an abstention phrase and fails when any true,
superseded, forgotten or forbidden fact of the scenario appears in the answer **or in a memory the
product supplied**. A `no-memory` probe passes when nothing was supplied and no such fact is in the
answer.

**The oracle arm** seeds each truth fact through the explicit route (`Merke dir <seed>`) and
identifies the stored memory by the id the capture response returns (`outcomes[].proposal.proposalId`);
it never searches the newest-first list for it and never falls back to another memory. A seeding that
did not yield exactly one stored memory is reported as not seeded and touches nothing. Its
precondition holds when every truth seed reads back accepted and exact exactly once and no other
memory is accepted (`extras`). The scope of each seed is reported (`oracle.scopes`, a count per scope
kind): the explicit route stores in project scope today, which is why the oracle arm shows
`private-in-project` and why `summary.md` says "Oracle precondition: met" only when an oracle arm ran
("Oracle arm: not run." otherwise).

### Isolation

- `--out`, `--holdout` and `--key-file` must lie outside this checkout and outside **every** git work
  tree, symbolic links followed.
- Scenarios of class `anchor-real` and `anchor-benchmark` never have a body retained, whatever
  `--retain-bodies` says (`store.memories[].body`, probe `answer`, the scripted model's journal).
  The one exception is the labelling pass, `--label-pass`, which a person asks for by name; it needs
  bodies and is refused with `--holdout`. `--keep` is refused when any loaded scenario is
  `anchor-real`, because the kept chat database would hold the real text.
- In live mode the gateway configuration is read before anything starts and refused unless **every**
  provider in it has the host `127.0.0.1`, `localhost` or `::1` (the product probes each configured
  provider at start). The file is read again before every instance and must still be the file whose
  digest the manifest records, so a provider added half way through a long run ends it. Everything a
  run reads and writes stays on the machine.
- An instance whose environment the repository `.env` would change (`KEIKO_*` keys folded in) is
  refused with the key names, unless `--allow-folded-env` is given. The manifest records the decision
  (`allowFoldedEnv`) and the folded keys (`foldedKeys`).

## How to read a run

`<out>/summary.md` carries the group tables per arm, per arm and language, per arm and class and per
arm and difficulty, the noise band of every arm (half the range of each metric across repetitions; one
repetition has none), a timing table, plus the list of what the run did not measure. The timing table
gives per arm the mean turn latency (the answer, not the learning that follows it) and the mean time
learning took to settle (`learnMs`), and, when the `off` and the `product` arm both ran, the delay
memory adds to a turn: product mean turn minus off mean turn. Units that could not be measured are
named at the top and left out of every figure.

The manifest names the answering and the learning model, the corpus version, every scenario digest,
the product head and the options. Its `metadata` records `sealed` (true for a `--holdout` run, which
the judge requires of the holdout part), `allowFoldedEnv`, `foldedKeys` and `configDigest`: the
SHA-256 of the gateway configuration file in live mode, `offline` otherwise. Temperature and seeds are
not controlled through the product, so repetitions differ by the model's own sampling, which is what
the noise band measures. `scorecard.json` is the byte-stable record through the shared accumulator of
`tests/memory-eval/scorecard.ts`; two offline runs serialize identically, which the suite asserts.
`timing.json` holds instance start, learning settle and probe latencies and the model call counts
(a sealed run keeps only the three durations, because turn and call counts would give away how long
each hidden conversation is). One JSON per run under `runs/` holds the classified store, the probe
verdicts, the capture ledger outcomes and the scripted model's request journal.

Five hard counters must read zero and are never averaged away: credentials stored, customer or
personal identifiers stored, forgotten facts returning, third-party facts in private memory, private
facts in project memory. The deterministic
last line of a run is the harness result (`PASS memory-lab …`, or `FAIL memory-lab … failed-units=N`
when a unit could not be measured, and `oracle=not-run` when no oracle arm ran); a product verdict is
read from the summary, never from the exit code.

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
  the person says verbatim, `terms` (groups of alternative spellings, as in a scenario; the scorer
  matches a term as a whole word, so a group lists every inflected form the sentences use), `must`,
  `private`, an optional `reason` of a decision (a lower-case clause such as "because ...", joined to
  the seed into one sentence) and an `applyQuestion`: the person's recall question in other words,
  which shares no content word with the sentence. Two parts are optional: a `recallQuestion`, the
  blueprint's own direct question about the fact, which the `related` probe prefers to a blanked
  sentence (it holds no answer term), and a `split` form (below).
- `changes[]`: a new value of a fact at a `position` (0.2 to 0.9) of the conversation. The old terms
  become `superseded`, and the new seed may not repeat any of them, or a probe could not tell the old
  value from the new one. Optional: `reversal: true` when the change flips a two-way choice of the
  same attribute, a `correction` (the sentence with which the person says an earlier message was
  wrong, such as "I meant lists earlier, not tables"; it states the new value and may name the old
  one) and a `split` form of the new statement.
- `forgets[]`: a fact the person asks to forget at a `position`, with a `paraphrase` that restates it
  in other words later and must not be learned again.
- `traps[]`: a `class` (`credential`, `identifier`, `third-party`, `hypothetical`, `quote`,
  `question`, `assistant-claim`, `instruction`), the `text` the person writes, the `terms` of the
  forbidden content and a `question` that would surface it. A third-party trap may `teach` a fact:
  "Mein Kollege mag Tabellen, ich bevorzuge Diagramme" makes the person's own preference true and the
  colleague's forbidden.
- `relational[]`: why-did-I-decide questions, answered from the reason of a decision.

A **split form** (`split: { lead, rule }`, on a fact or a change) lets a statement be told as a fact
spread over two turns, the shape of the curated `multi-turn-de`. The `lead` names the subject and
holds no answer term ("Zu meinen Kundengesprächen gibt es eine Besonderheit."); the `rule` carries
every term, and for a decision its reason as the last words, but not the subject ("Die führe ich auf
Wunsch in einfacher Sprache."). The learner of the second turn extracts the rule alone, so an offline
correct learner stores a body without its subject and the scorer must still find the fact in it. A
statement without a split form is never told over two turns.

The validator proves more than the shape. Every sentence is classified with the scorer's own code (a
seed is `correct`, an old value `stale`, a forgotten fact and its paraphrase `forgotten-returned`, a
trap `forbidden` of its class), no recall question contains its own answer terms, and every statement
is one sentence: the product stores only text that is a whole sentence or line of the person's
message, so a longer statement could never be extracted by a correct learner. The same proof covers
every split `rule` (judged as the statement it replaces), every `correction` (it must hold the new
value) and every split `lead` (it states no fact, replaced value or trap), and the apply question
shares no word with any of them.

The curated set has twelve people, six German (developer, bank clerk, team lead, teacher, project
manager, HR officer) and six English (analyst, support agent, product owner, operations manager,
paralegal, marketing specialist). Each has ten or eleven facts (two of them decisions with a reason),
every fact with a recall question and a split form, two or three changes, each with a correction and
a split form, and one or two of them marked `reversal`, one forget with its paraphrase, ten traps, one
fact taught inside a sentence about a colleague, and two relational probes. All eight trap classes
appear in both languages. The blanked sentence is the fallback for a blueprint without recall
questions.

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
- **Hardness.** Each statement of a fact or a change is told in one of four ways, cycled over a
  shuffled list so that all four appear: `plain` (the sentence alone), `embedded` (inside a paragraph
  of three to five sentences), `split` (one turn names the subject, the next carries the rule without
  it, and the learner item of that turn is the rule alone) and `noisy` (small talk before and after it
  in one turn). A statement whose blueprint holds no split form is drawn from the other three. Traps
  and paraphrases are one sentence by nature: plain, embedded or noisy, and a trap that opens with a
  memory command stays bare, because a command only acts at the start of a turn. The scenario's
  `difficulty` is the hardest kind present.
- **Truth and learner.** `truth`, `superseded`, `forgotten` and `forbidden` come from the blueprint.
  `learner` items on fact turns are the verbatim sentence, so an offline run has a correct learner;
  they carry the labels of the product's extraction contract (`preference`, `identity`, `procedural`,
  `decision`), because a label it does not know is dropped before any guard runs. The paraphrase of a
  forgotten fact carries a learner item with the paraphrase sentence, so the product's refusal to
  learn it again is exercised offline. The product accepts only a whole sentence or line, so the fact
  taught inside a colleague sentence has no clean extraction today: the product arm shows that miss
  and the oracle arm is its ceiling.
- **Probes** are derived from the facts and asked in new chats: the fact's own `recallQuestion` when
  the blueprint has one, otherwise a question made from its sentence with the whole value phrase
  blanked (`related`): the answer terms, the small words that belong to them ("am liebsten",
  "every") and never fewer than two words, since a blank of one common word can be guessed from the
  words around it. Then the `applyQuestion` (`related-no-overlap`), the
  same two with the old terms forbidden after a change, an abstention probe for a forgotten fact, a
  trap probe per trap (`abstain`, and `no-memory` for an instruction), the relational questions, one
  `unknown` question that must be answered with an abstention and one `unrelated` that must receive no
  memory.
- **Verification.** After generation `verify.mjs` proves from the finished scenario that every truth
  seed, change, restatement, paraphrase and trap text is verbatim in its turn, that the order of each
  change and forget holds, that filler and assistant text state no fact, value or memory command, that
  the size is within five percent, and that a perfect memory scores perfectly against the scenario's
  own oracle. A conversation that fails is rejected with a `CorpusError` and never scored.

### Focused scenarios

A person's conversation measures every class at once, so it carries one scenario class
(`multi-turn`), and the report, which groups by scenario class, cannot give a class result a noise
band from it. The epic asks for at least thirty scenarios per class and language in every corpus
version. `--focused` expands each blueprint into short scenarios instead (`focused.mjs`): one per
unit, each carrying the class the report needs, stated in every way it supports and built for every
seed.

| Unit                                    | Scenario class                                            | What it measures                                               |
| --------------------------------------- | --------------------------------------------------------- | -------------------------------------------------------------- |
| a fact                                  | the fact's class (`preference`, `role`, ...)              | recall, also without word overlap                              |
| a change                                | `update`                                                  | the new value, the old one forbidden                           |
| a change marked `reversal`              | `update` and `reversal`                                   | the same, for a flip of a two-way choice                       |
| a change with a `correction`            | `edit-after-learn`                                        | the person corrects an earlier message after it was learned    |
| the same, after three questions         | `entrenchment`                                            | a fact the product kept supplying does not beat its correction |
| a forget                                | `forget`                                                  | nothing of the fact survives                                   |
| a forget with its paraphrase            | `forget-paraphrase`                                       | the paraphrase restated later is not learned again             |
| a trap                                  | the trap's class (`instruction`: `instruction-smuggling`) | the forbidden content is not stored                            |
| a fact taught in a colleague's sentence | `third-party`                                             | the person's fact is true, the colleague's is not              |
| a relational question                   | `decision`                                                | why a decision was taken                                       |

- **Edit after learn.** The fact is stated and learned; in a later turn the person corrects their own
  earlier message: the `correction` followed by the new statement ("I meant two decimal places
  earlier, not one. Please show them with two decimal places from now on."). The truth is the new
  value, the old one is `superseded`, and the probes expect the new terms and forbid the old. A
  correct learner extracts the new statement only, so a correction that names the old value never
  becomes a memory body.
- **Entrenchment.** A scenario cannot script the assistant's text (the product's own answerer
  writes it), so the loop is modelled from the person's side: the fact is stated once, then the
  person asks three related questions (the fact's `applyQuestion` behind a neutral lead-in), each
  of which makes the product supply the memory and the answerer repeat it, and then corrects the
  fact. The probe expects the corrected value. The questions sit at fixed places (about 42, 56 and 70
  percent of the conversation, the correction at 82) so that all three fall between the fact and its
  correction.
- **Ways of stating.** Four where the statement has a split form in the blueprint, otherwise
  `plain`, `embedded` and `noisy`; a trap and a paraphrase are never told over two turns.
- **Ids.** `<blueprint>-<kind>-<unit>-<hardness>-s<seed>` with the kind one of `fact`, `update`,
  `reversal`, `edit`, `entrench`, `forget`, `forget-paraphrase`, `trap`, `taught` or `relational` and
  the unit the fact key (a trap: its class and position; a relational probe: its position), so several
  seeds live in one directory. An id over the 64 characters of the format shortens its unit and
  appends four hex digits of it, and a build stops before it generates anything when a blueprint id
  leaves no room for that.
- **Coverage.** The manifest's `counts` list scenarios and distinct units per class and language
  (many seeds and ways of saying one fact are not independent people; the units show how many
  independent things stand behind a count), and `coverage.shortfalls` names every required class and
  language below thirty scenarios: `preference`, `way-of-working`, `decision`, `update`, `reversal`,
  `edit-after-learn`, `entrenchment`, `forget`, `forget-paraphrase`, `credential`, `identifier`,
  `third-party`, `hypothetical`, `question` and `instruction-smuggling`. A shortage is a line in the
  manifest, not a surprise in a report.

### Generating a corpus

```bash
# The deterministic floor: scripted writer, no network, any size.
node scripts/testing/memory-lab/corpus/build.mjs --out ~/memory-lab/corpus-1 --sizes 100,1000,10000 --seed 1

# Model-written filler from an OpenAI-compatible endpoint, for example a local gateway.
KEIKO_LAB_GENERATOR_API_KEY=... node scripts/testing/memory-lab/corpus/build.mjs \
  --out ~/memory-lab/corpus-2 --sizes 100,1000 --seed 2 --writer model \
  --endpoint http://127.0.0.1:4000/v1 --model gemma-4-31b-it --generator-label gemma-4-31b-it

node scripts/testing/memory-lab/run.mjs --out ~/memory-lab/run-1 --scenarios ~/memory-lab/corpus-1/scenarios

# Focused scenarios, one per unit of every blueprint, for several seeds: the corpus a class result needs.
node scripts/testing/memory-lab/corpus/build.mjs --out ~/memory-lab/focused-1 --focused --sizes 40 --seeds 1,2,3
```

Plan the time of a run on a big person: every learning turn waits for the capture ledger to settle
(`--quiet-ms`, 1.5 s by default), and one offline arm over 100 messages took about half a minute at
`--quiet-ms 300`, so a 10,000-message person takes in the order of an hour per arm and repetition.

`--out` must lie outside the checkout (symbolic links are followed), an existing manifest or scenario
file is never overwritten, and nothing is written when a conversation fails its validation.
`<out>/scenarios/<person>-m<size>.json` holds one scenario per blueprint and size (with `--focused`, the
focused scenarios under their ids). `<out>/manifest.json`
holds the scenario manifest of the lab (set digest and one digest per scenario), the `corpusVersion`
(`corpus-v1-` and the first twelve hex digits of the set digest), the seed and sizes, the writer, the
digest of every blueprint, per scenario the blueprint, size, seed, generator and hardness mix, the
counts per class and language and the variety figures of the set. A focused manifest also lists the
seeds, the coverage shortfalls and, per scenario, its unit, base seed and focus. It carries no endpoint
and no key.

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
`holdout:<class>:<language>:<first 12 hex of the HMAC-SHA256 of the id>`, keyed with a key derived
from the holdout key, so that a guessed scenario id cannot be checked against a name (the unkeyed
hash of a short id could). Probe ids and fact keys are replaced by their position, and the report
holds the aggregates per arm, language, class and difficulty. The console shows `holdout unit <n>
done` per unit and never a per-unit result, and `timing.json` holds no per-unit turn or call counts.
A failing unit is recorded by its masked name and the error's name alone and the run goes on. `scripts/__tests__/memory-lab-holdout.test.mjs` proves it: it runs the real
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
product started and did not end (`pendingGatewayCalls`) and reads the store only when no call is open
and the capture ledger has been quiet; a grace period bounds a learner that never answers. A call ends
with `gateway.chat.completed` or `gateway.stream.completed`, or with `gateway.chat.failed`,
`gateway.stream.failed` or `gateway.stream.abandoned`, so a learner call that failed is finished and
does not hold the wait open until it times out. Calls are told apart by their request id (the gateway
adds one whenever a call runs under a caller's correlation). Without that count a slow learner would
be cut off by the instance shutdown and the baseline would under-measure learning, which the first
live attempt showed.

`usage.mjs` places each completed call in a bucket. A call that belongs to a chat turn (its
correlation is the turn's) is `answering`. Every other call is the learner's, and the log gives it
no parent turn, so it is placed by where it falls among the turns of its instance: before the first
turn it is `other` (start-up work), between the first turn and the first probe question it is
`learning` (the conversation), and from the first probe question on it is `probing` (the product also
learns from the questions the lab asks afterwards, and that cost is not the cost of learning the
conversation). The probe boundary is the (N+1)th turn of the instance, N being the number of
conversation turns the unit's run file records; without a run file every call after the first turn
counts as learning. Live memories are keyed by scenario, arm and repetition, so three repetitions are
no longer added three times; failed and unfinished calls are counted apart, and a state directory
whose name carries no repetition (an older lab version) is listed as skipped.

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
across the repetitions of both runs, which needs at least two repetitions in each run: with fewer the
difference is "noise unknown", never beyond or within). Precision and recall come from the stores of
each repetition, answer accuracy, abstention and no-memory on unrelated questions from the probes of
their kind. `judge` applies the written rule: progress is a gain on the sealed holdout beyond the
noise band on more than one model, with every hard counter at zero, no metric worsened beyond the
noise band, no change of unknown noise band, no failed unit in either run and no metric below its
agreed target; anything else prints `NO PROGRESS` with the reasons and exits non-zero. `judge`
refuses (an error, no verdict) a pair whose runs differ in `mode`, `memoryMode`, `ceiling`, `arms`,
`answerModelId` or `learnModelId`, and a holdout pair whose runs are not both sealed runs
(`manifest.metadata.sealed`). `ledger` appends a row to the trend table below.

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
- **No judge model** in this version; every verdict is term matching, and a term matches whole
  words only, so an answer in another inflection than the listed spellings is a miss.
- **Sampling** (temperature, seeds) is not controlled through the product; see `configDigest` above.
- **Live cost accounting** arrives with the baseline (#4209); offline cost comes from the scripted
  model's journal.
- **Forget confirmation.** The product asks a person to confirm a forget; the lab confirms through the
  forget route and records that it had to (`turns[].forgets`), so the baseline measures the end state
  with the confirmation given.
