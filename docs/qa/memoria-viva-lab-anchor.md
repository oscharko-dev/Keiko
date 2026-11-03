# MemoriaViva lab: the real-conversation anchor

Tracking: [#4208](https://github.com/oscharko-dev/Keiko/issues/4208) (corpus, section "Real
conversations as the reality anchor"); parent epic
[#4205](https://github.com/oscharko-dev/Keiko/issues/4205). The lab itself is described in
[memoria-viva-lab.md](memoria-viva-lab.md); this page covers the real-text part of its corpus.

Generated conversations are easier and more regular than real ones, and the generator and the learner
are both models that share habits. The anchor is therefore real human conversation, used on one
machine and never redistributed. It is a sanity check on the synthetic corpus, not a target to tune
the product against.

## What the anchor measures

Real conversations have no truth list, so the anchor measures what a truth list is not needed for:

- **Precision**: of the memories the product stores from messy real text, how many a person would
  keep. Judged by a person, or by an agent with a human spot check, through the labelling sheet
  below. Reported on the labelled subset only.
- **Over-application**: every real scenario ends with one unrelated question in a new chat
  (`Was ist Apache Kafka?`, probe `unrelated`, kind `no-memory`). A memory supplied for it counts
  against the product. The lab scores this without any labelling.
- **Style**: the conversion manifest records the real distribution of user turns per conversation and
  characters per turn, so the synthetic corpus can be compared with real text.
- **Recall** only where a truth exists: on LongMemEval (the benchmark class `anchor-benchmark`), and on
  a labelled subset of real conversations when an agent writes a `truth` list into a copy of a
  scenario and a person spot-checks it. The labelling sheet itself labels what was stored, not what
  should have been.

Scenario classes: `anchor-real` (WildChat, OASST2; language `de` or `en`, difficulty `noisy`) and
`anchor-benchmark` (LongMemEval; language `en`, difficulty `split`).

## Sets, licenses and citations

| Set           | Source                                                                                 | License    | Slice                                                           |
| ------------- | -------------------------------------------------------------------------------------- | ---------- | --------------------------------------------------------------- |
| `wildchat-de` | [WildChat-1M](https://huggingface.co/datasets/allenai/WildChat-1M)                     | ODC-By-1.0 | `"language"='German'`, about 16,000 conversations               |
| `wildchat-en` | WildChat-1M                                                                            | ODC-By-1.0 | `"language"='English'`, hundreds of thousands: `--limit` needed |
| `oasst2-de`   | [OASST2](https://huggingface.co/datasets/OpenAssistant/oasst2)                         | Apache-2.0 | `"lang"='de'`, about 5,800 messages                             |
| `oasst2-en`   | OASST2                                                                                 | Apache-2.0 | `"lang"='en'`: `--limit` needed                                 |
| `longmemeval` | [LongMemEval, cleaned](https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned) | MIT        | `longmemeval_s_cleaned.json`, 500 questions, about 277 MB       |

Citations (also written to `LICENSES.md` next to the fetched data):

- WildChat-1M: Zhao, W., Ren, X., Hessel, J., Cardie, C., Choi, Y., and Deng, Y. (2024). WildChat: 1M
  ChatGPT Interaction Logs in the Wild. ICLR 2024. arXiv:2405.01470.
- OASST2: Köpf, A., Kilcher, Y., von Rütte, D., et al. (2023). OpenAssistant Conversations -
  Democratizing Large Language Model Alignment. NeurIPS 2023, Datasets and Benchmarks Track.
  arXiv:2304.07327.
- LongMemEval: Wu, D., Wang, H., Yu, W., Zhang, Y., Chang, K.-W., and Yu, D. (2025). LongMemEval:
  Benchmarking Chat Assistants on Long-Term Interactive Memory. ICLR 2025. arXiv:2410.10813.

LoCoMo is licensed CC BY-NC 4.0 and stays out of product development; nothing here fetches it. The
operator's own Keiko chats were examined on 2026-11-03 (counts only) and are too few to anchor
anything, so they are not a set.

## The rule: no real text leaves the private directories

Nothing real enters the repository, an issue, a pull request, an evidence file, the Activity Log or a
report. Reports carry aggregates only: counts, rates, per-class and per-language tables, set digests.
The tools enforce the mechanics, and the rest is procedure:

- Every path the tools read or write (`--out`, `--in`, `--run`, `--scenarios`, `--labels`,
  `--sheet`) must lie outside this checkout **and outside every other git work tree**, symlinks
  resolved. A path in the main checkout of a linked worktree is refused as well.
- Directories are created owner-private (`0700`), files are written owner-private (`0600`).
- A labelling sheet is never overwritten, so labels are never lost; it is only ever written outside
  the checkout.
- Error messages never quote conversation text: a parse error names the file kind and the error code
  only, an API error quotes the API's own error message, never a page body.
- **Anchor runs use `--no-retain-bodies`.** The scorecard, summary and timing of such a run hold counts
  only and may be quoted. A labelling pass needs the stored memory bodies, so it is the one run that
  retains them: do it into a private run directory, never attach or quote it, and delete it once the
  labels are written. The run directory, the sheet and the labels file stay on the machine.
- This tooling does not scan the repository, issues or evidence for real text. That proof is a
  separate acceptance item of #4208.

## Fetch

```bash
node scripts/testing/memory-lab/anchor/fetch.mjs --out ~/keiko-anchor/fetched --set wildchat-de,oasst2-de
node scripts/testing/memory-lab/anchor/fetch.mjs --out ~/keiko-anchor/fetched --set wildchat-en --limit 2000
node scripts/testing/memory-lab/anchor/fetch.mjs --out ~/keiko-anchor/fetched --set longmemeval
```

Layout under `--out`:

```text
LICENSES.md                      license and citation of every set
<set>/pages/<offset>.json        the raw API response for the rows starting at that offset
<set>/fetch-manifest.json        dataset, filter, row count, fetch time, API URL template (no text)
longmemeval/longmemeval_s_cleaned.json   the verified download (LongMemEval only)
```

The paged sets use the Hugging Face datasets-server `filter` API, 100 rows per call at most:

```text
https://datasets-server.huggingface.co/filter?dataset=allenai%2FWildChat-1M&config=default&split=train&where=%22language%22%3D%27German%27&offset={offset}&length=100
https://datasets-server.huggingface.co/filter?dataset=OpenAssistant%2Foasst2&config=default&split=train&where=%22lang%22%3D%27de%27&offset={offset}&length=100
```

(`wildchat-en` and `oasst2-en` use `'English'` and `'en'`.) LongMemEval is discovered through the Hub
tree API and downloaded, size and SHA-256 verified against the listing, from the resolve URL:

```text
https://huggingface.co/api/datasets/xiaowu0162/longmemeval-cleaned/tree/main
https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json
```

Behavior worth knowing:

- **Resumable.** A page file that already holds the rows a request would fetch is never requested
  again, so an interrupted run continues where it stopped, and raising `--limit` later fetches only
  what is missing. The manifest is written last: a set without `fetch-manifest.json` was not finished.
- **Polite.** One request at a time, `--delay-ms` (default 1000) between network requests, an
  identifying user agent.
- **Patient.** The filter API is slow and not always available: the first request of a set took 90
  seconds and a gateway answered 500 or 502 now and then when this was written. Network errors,
  timeouts, 408, 425, 429 and 5xx are retried with exponential backoff (`--backoff-ms`, doubling,
  capped at 60 s, `Retry-After` honored) up to `--attempts` (default 8); a request times out after
  `--timeout-ms` (default 180 s). Any other 4xx fails at once.
- **Limits.** The English slices need `--limit N` (rows); the German slices are fetched whole unless
  one is given. `partial: true` in the manifest is the datasets-server's own flag that it indexed
  only part of the dataset (WildChat reported it when this was written), so the slice can be smaller
  than the dataset card says.
- Credential-shaped strings in the raw pages are not touched at fetch time; conversion redacts them.

## Convert

```bash
node scripts/testing/memory-lab/anchor/convert.mjs --in ~/keiko-anchor/fetched --out ~/keiko-anchor/converted --sample 200
```

`--set` restricts the sets (default: every fetched set), `--sample N` takes the first N scenarios of
each set in fetched order (deterministic, not a random sample), `--max-turns N` caps the user turns of a
LongMemEval scenario (default 200). Scenarios land in `<out>/scenarios/<id>.json`, so the lab loads
that directory as it is; `<out>/manifest.json` sits beside it, because the scenario loader refuses any
JSON file that is not a scenario. An existing conversion is never overwritten. Every scenario is
validated with the lab's own `validateScenario` before a byte is written, and the manifest digests
are read back through the lab's own loader, so they equal what a lab run over the directory reports.

| Source                          | Scenario                                                                                                                                                      |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WildChat row                    | `wildchat-<lang>-<hash12>`, class `anchor-real`, no truth, the user turns in order (assistant text is not kept), probe `unrelated` (`no-memory`)              |
| OASST2 tree                     | `oasst2-<lang>-<hash12>`, the thread from the root following the best-ranked child at every level; prompter texts are the user turns; otherwise as above      |
| LongMemEval question            | `longmemeval-<id>`, class `anchor-benchmark`, truth `{key: question_id, seed: answer, must, terms: [[answer]]}`, user turns of the haystack, probe `question` |
| LongMemEval abstention question | no truth, probe `question` of kind `abstain` (`question_id` ending in `_abs`)                                                                                 |

Skipped, and counted by name in the manifest: fewer than 2 user turns, more than 40 user turns, a user
turn over 4000 characters, a truncated or malformed row, a duplicate id (real conversations); a
`single-session-preference` question, whose answer is a rubric for a judge model that term matching
can never find, a question without answer or evidence session, a malformed instance (LongMemEval).
Rows are judged on user turns after blank turns are dropped. For LongMemEval, `--max-turns` keeps the
evidence sessions whole and admits filler sessions in their original order while they fit.

**Redaction** runs over every real user turn and over the filler sessions of the benchmark; the
synthetic evidence sessions stay verbatim so the answer stays findable. It replaces email addresses,
IBAN-like patterns, hex runs of 32 or more, `sk-`, `ghp_`, `xox` and other well-known token shapes,
bearer and basic credentials, JWT-shaped values and phone-number-like runs of 9 or more digits with
`[redacted]`, and counts each kind. It is shape-based and best effort; it does not remove names or
other personal information and is no guarantee.

The manifest holds, per set: dataset, license, citation, language, rows examined, scenarios produced,
skip counts, redaction counts, style figures (user turns per scenario, characters per turn) and the
provenance of the fetch; overall: counts per set and language and the digests of
`scenarioSetManifest`. It never holds a word of conversation text.

## Run the lab over it

```bash
node scripts/testing/memory-lab/run.mjs --mode live --scenarios ~/keiko-anchor/converted/scenarios \
  --out ~/keiko-anchor/run-1 --no-retain-bodies --arms off,product \
  --config ~/.keiko-lab/gateway.json --answer-model <id> --learn-model <id>
```

Use `--arms off,product` for real conversations: they have no truth to seed, so the `oracle` arm adds
nothing. The LongMemEval class can use all three arms. The `summary.md` of such a run is body-free and
its group tables per class and language (`anchor-real`, `anchor-benchmark`) are quotable.

## Label what was stored

For precision, a labelling pass runs the same scenarios once with bodies retained into a private run
directory, then exports one sheet entry per stored memory:

```bash
node scripts/testing/memory-lab/run.mjs --mode live --scenarios ~/keiko-anchor/converted/scenarios \
  --out ~/keiko-anchor/run-labelling --retain-bodies --arms product \
  --config ~/.keiko-lab/gateway.json --answer-model <id> --learn-model <id>
node scripts/testing/memory-lab/anchor/label.mjs export --run ~/keiko-anchor/run-labelling \
  --scenarios ~/keiko-anchor/converted/scenarios --out ~/keiko-anchor/labels/sheet.json
```

Each entry is `{runFile, memoryId, scenario, class, language, arm, repetition, status, type, body,
sourceTurn, label}`. `sourceTurn` is the user turn that contains the body, found exactly or after the
lab's own text normalization, else `null` (a paraphrase has no source turn; open the scenario to
judge it). Fill in `label` with one of:

| Label         | Meaning                                                                                                                                                          |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `correct`     | A fact about the operator (preference, way of working, role, own decision) said clearly and worth keeping                                                        |
| `unnecessary` | True but not worth keeping: a one-off task detail, a topic, small talk, content of the requested work product                                                    |
| `forbidden`   | Must never be stored: a credential or token shape, an identifier, a hypothetical, quoted text, a question, an instruction smuggled as a fact, an assistant claim |
| `third-party` | A fact about another person or organisation (a colleague, a customer, someone mentioned)                                                                         |

An agent may label the sheet by writing a flat `{memoryId: label}` file instead. A person then
re-labels a random sample of it, and the disagreement rate is stated next to the precision (the tool
does not compute it). Then:

```bash
node scripts/testing/memory-lab/anchor/label.mjs summarize --labels ~/keiko-anchor/labels/labels.json --sheet ~/keiko-anchor/labels/sheet.json
node scripts/testing/memory-lab/anchor/label.mjs summarize --labels ~/keiko-anchor/labels/sheet.json   # the sheet labelled in place
```

The summary prints counts and precision (`correct` over labelled) per class and language, the
unlabelled count and the hard-zero labels (`forbidden`, `third-party`, which must stay zero) - a table
of aggregates with no body, source turn, scenario id or memory id. `--status accepted` restricts it
to live memories. An unknown label, an unknown memory id or a flat file without its sheet is refused.

## Limits

- **De-identified is still real.** WildChat is de-identified by its authors, and redaction here is
  shape-based; names and other personal details can remain. Treat all of it as personal data: local
  only, deleted when no longer needed.
- **Mostly task requests.** People talk to ChatGPT to get work done, not to describe themselves. Of
  the first 100 German WildChat conversations, 69 had fewer than two user turns and are skipped when
  this was written, and many of the rest state no fact about the user. The precision denominator is
  small; over-application is the main signal there.
- **Subsampling.** `--sample` takes the first N in API order, not a random sample, and the German
  WildChat slice is a language filter, not a stratified sample of users.
- **User turns only.** The original assistant replies are dropped and the lab's answerer replies
  instead, so the flow of a conversation differs from the original.
- **Language labels.** A conversation labelled German can contain English turns; the scenario takes
  the language of its set.
- **OASST2 threads** follow the best-ranked branch only, and a limited fetch can cut a tree short.
- **Benchmark caveats.** Published LongMemEval scores differ in subset, dataset version and judge,
  and use a judge model. Here a probe passes only when the full expected answer appears verbatim
  (after the lab's normalization), which is stricter, and a short numeric answer can match as a
  substring. Free-text answers with alternatives rarely match, so pass rates are a lower bound.
  `single-session-preference` questions are skipped, session dates are dropped (the lab has no clock
  override), and the oracle arm stores the bare answer as its seed, so its retrieval ceiling is low on
  this class. The benchmark may also be saturated or contaminated for the models used. Use it as a
  sanity check, not as a target.
- **Memory.** Converting LongMemEval parses the 277 MB file in one piece; allow a few gigabytes of RAM.

## Where the code lives

All under `scripts/testing/memory-lab/anchor/`, tested hermetically by
`scripts/__tests__/memory-lab-anchor-*.test.mjs` with an injected fetch:

| File                | Role                                                                          |
| ------------------- | ----------------------------------------------------------------------------- |
| `sets.mjs`          | The set registry: sources, filters, licenses and citations                    |
| `fetch.mjs`         | The paged, resumable, polite fetcher, `LICENSES.md` and the command line      |
| `http.mjs`          | One request with a timeout, classified failures and the retry loop            |
| `longmemeval.mjs`   | The LongMemEval file discovery and its verified download                      |
| `converters.mjs`    | Row, thread and instance to scenario, or the named reason it was skipped      |
| `convert.mjs`       | The pipeline: pages, `--sample`, validation, the manifest; the mapping header |
| `redact.mjs`        | The credential-shaped redaction pass and its counters                         |
| `label.mjs`         | Labelling sheet export and the aggregate summary                              |
| `private-files.mjs` | The outside-the-checkout guard, owner-private writes, body-free JSON reads    |
