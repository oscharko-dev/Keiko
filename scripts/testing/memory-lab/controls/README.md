# Preregistered Memory recall controls

These synthetic diagnostic inputs preserve the exact bytes fixed before their model runs. They
contain source messages, labelled facts and probe expectations. The [bindings](bindings.json) record
every file SHA-256 and both corpus identities. The paired analyzer consumes completed artifacts and
emits counts, truth keys and provenance without source messages, memory bodies or model answers.

The normal corpus remains the existing 21 scenarios, loaded digest
`becde3ec6f303d34344d1b9e7e0ff9abb285fd3d5f6b160e9a0c67570d192fe0`. These extra controls live outside
its `scenarios` directory and require an explicit `--scenarios` path:

| Directory        | Scenarios | Purpose                                                                                                                        |
| ---------------- | --------: | ------------------------------------------------------------------------------------------------------------------------------ |
| `release-recall` |      1 EN | One known project decision, lexical and paraphrased recall, near and far unrelated questions                                   |
| `rule-transfer`  |   2 DE/EN | A content-free announcement followed by the concrete rule, positive recall, a near unrelated question and an unknown attribute |

The original German case remains `../scenarios/multi-turn-de.json`, SHA-256
`390ac5769668654d84384bc4c0777b11a3e3ddab3f758806b9f39149ce53a51a`. It belongs to the primary corpus;
the transfer set adds two different, preregistered cases. The independent blind retrieval holdout is
separate from these public controls.

## Verify the frozen inputs

From the repository root, this local check verifies every byte hash, raw-set digest, loaded-set
digest and the separate corpus membership. It performs no model requests:

```bash
npm exec -- vitest run --config vitest.coverage.scripts.config.ts scripts/__tests__/memory-lab-public-controls.test.mjs
```

| Set      | Raw JSON set digest                                                | Canonical loaded set digest                                        |
| -------- | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| Release  | `fac1464b7a8aef293402e63bc9d4e9faa682894d6a27212ca7d14b5bb7e058a5` | `3e88147efaaf02b845c17e2d7509b60771c9023711ff4d462a4f085a51d3018e` |
| Transfer | `94de8d95261b8ec9d4ee1e408fb433e88e5c5c1d6eacc339edf31404b1198ad6` | `ee81ceabd7c196a65778379e8a1ac15586e732bbe7d4cdbc4434363769e96be8` |

The loader adds empty `superseded`, `forgotten` and `forbidden` arrays. Consequently its normalized
manifest differs from a manifest of the raw JSON objects even though every file byte is unchanged.
The **loaded** digest is the runner's corpus identity and the analyzer's comparison identity. The
Release preregistration initially recorded its raw digest; the byte hash binds both representations.

The three scenario files are excluded individually from Prettier because formatting would change
their preregistered hashes. The local hash check owns those bytes.

## Reproduce a paired live measurement

First run the unchanged primary 21-scenario audit. Run these additional controls afterward using
identical models and configuration on both sides. The diagnostic profile used local
`gemma-4-31b-it` for Chat and learning, and local `qwen3-embedding-8b` for embeddings. Provider routing
and the embedding capability belong in the private gateway configuration.

Use the driver checkout at `b93ec66482469d36c0f0f68b8cf6c71ca91832d3` for **both** measurements. Its 18
fixed instrument files have digest
`5e4f2a214fac93507ecc840fe4ab6f8369246382f44209706006643829c19505`. Each subject checkout needs its
own exact install and build; `--subject-root` selects the product under measurement. Preserve the
subject heads, distribution digests, config digest, model IDs, corpus digest and all three repetitions
from the resulting manifests. The two new standalone analysis files and these controls leave that
fixed instrument unchanged.

Set the per-model `KEIKO_MODEL_<NORMALIZED_MODEL_ID>_API_KEY` variables in the private parent
environment when the configured gateway requires authentication. For the two identical Gemma IDs,
that variable is `KEIKO_MODEL_GEMMA_4_31B_IT_API_KEY`. The lab inherits these keys; an absent Chat or
learner key becomes the lab's `lab` value. Keep key values and gateway configuration private.

The following template uses existing built checkouts and a fresh output root. Replace the paths with
the attested local paths. It runs the public controls with three repetitions, the `product` arm,
180-second settling limit, budget 1200 and autonomous-delivery mode and ceiling. It retains no bodies.

```bash
lab_driver_root=/absolute/path/to/driver-at-b93ec6648
lab_baseline_root=/absolute/path/to/built-baseline
lab_candidate_root=/absolute/path/to/built-candidate
lab_controls_root=/absolute/path/to/this/checkout/scripts/testing/memory-lab/controls
lab_gateway_config=/private/path/to/gateway.json
lab_output_root=/private/path/to/fresh-output
lab_analyzer=/absolute/path/to/this/checkout/scripts/testing/memory-lab/analyze-recall.mjs

for lab_control_set in release-recall rule-transfer; do
  for lab_side in baseline candidate; do
    if [ "$lab_side" = baseline ]; then
      lab_subject_root="$lab_baseline_root"
    else
      lab_subject_root="$lab_candidate_root"
    fi
    node "$lab_driver_root/scripts/testing/memory-lab/run.mjs" \
      --mode live --arms product --repetitions 3 \
      --scenarios "$lab_controls_root/$lab_control_set" \
      --out "$lab_output_root/$lab_control_set-$lab_side" \
      --subject-root "$lab_subject_root" --config "$lab_gateway_config" \
      --answer-model gemma-4-31b-it --learn-model gemma-4-31b-it \
      --memory-mode autonomous-delivery --ceiling autonomous-delivery \
      --budget-tokens 1200 --max-wait-ms 180000 --no-retain-bodies
  done
  node "$lab_analyzer" \
    "$lab_output_root/$lab_control_set-baseline" \
    "$lab_output_root/$lab_control_set-candidate" \
    "$lab_controls_root/$lab_control_set" product \
    > "$lab_output_root/$lab_control_set-comparison.json"
done
```

The analyzer checks manifest mode, arms, models, config, instrument, corpus and complete raw unit
inventories before comparison. It separates stored target availability, supplied relevant memory
and the original answer verdicts. Each introduced negative recall is reported by the same scenario,
arm, repetition and probe key, even when another false positive resolves and the total stays equal.
Allowed standing-profile presence is reported separately from query-specific retrieval. Original
scorecard criteria remain visible through `existingComparison`; offline scripted echo is labelled
as such, and live results retain the actual model identities. These files publish inputs and a
reproduction procedure; quantitative claims require the corresponding completed paired runs.
