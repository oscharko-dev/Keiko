// Registry of the licensed public conversation sets the anchor tooling can fetch (#4208). One place
// names each set's source, filter, license and citation, so the fetcher, the converter and the
// LICENSES.md the fetcher writes cannot disagree. LoCoMo (CC BY-NC 4.0) is deliberately absent: it
// stays out of product development.

export const DATASETS_SERVER = "https://datasets-server.huggingface.co";
export const HUB = "https://huggingface.co";
// The datasets-server accepts at most 100 rows per call.
export const PAGE_SIZE = 100;

/** Source families: what a set is a slice of, with the license terms that travel with the data. */
export const SOURCES = Object.freeze({
  wildchat: Object.freeze({
    title: "WildChat-1M",
    dataset: "allenai/WildChat-1M",
    license: "ODC-By-1.0",
    licenseName: "Open Data Commons Attribution License v1.0",
    licenseUrl: "https://opendatacommons.org/licenses/by/1-0/",
    homepage: "https://huggingface.co/datasets/allenai/WildChat-1M",
    description:
      "Real users talking to ChatGPT, de-identified by the dataset authors. The slice used here is filtered by conversation language.",
    citation:
      "Zhao, W., Ren, X., Hessel, J., Cardie, C., Choi, Y., and Deng, Y. (2024). WildChat: 1M ChatGPT Interaction Logs in the Wild. International Conference on Learning Representations (ICLR 2024). arXiv:2405.01470.",
  }),
  oasst2: Object.freeze({
    title: "OASST2",
    dataset: "OpenAssistant/oasst2",
    license: "Apache-2.0",
    licenseName: "Apache License 2.0",
    licenseUrl: "https://www.apache.org/licenses/LICENSE-2.0",
    homepage: "https://huggingface.co/datasets/OpenAssistant/oasst2",
    description:
      "Human-written prompter and assistant messages of the OpenAssistant conversation trees. The slice used here is filtered by message language.",
    citation:
      "Köpf, A., Kilcher, Y., von Rütte, D., et al. (2023). OpenAssistant Conversations - Democratizing Large Language Model Alignment. Advances in Neural Information Processing Systems 36 (NeurIPS 2023), Datasets and Benchmarks Track. arXiv:2304.07327.",
  }),
  longmemeval: Object.freeze({
    title: "LongMemEval",
    dataset: "xiaowu0162/longmemeval-cleaned",
    license: "MIT",
    licenseName: "MIT License",
    licenseUrl: "https://opensource.org/license/mit",
    homepage: "https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned",
    description:
      "500 questions over synthetic multi-session chat histories (the cleaned release, the LongMemEval_S file only; project page https://github.com/xiaowu0162/LongMemEval).",
    citation:
      "Wu, D., Wang, H., Yu, W., Zhang, Y., Chang, K.-W., and Yu, D. (2025). LongMemEval: Benchmarking Chat Assistants on Long-Term Interactive Memory. International Conference on Learning Representations (ICLR 2025). arXiv:2410.10813.",
  }),
});

const WILDCHAT_FILTER = Object.freeze({ config: "default", split: "train" });
const OASST2_FILTER = Object.freeze({ config: "default", split: "train" });

/**
 * The fetchable sets. `where` is the datasets-server filter expression; `requiresLimit` marks the
 * English slices, which hold hundreds of thousands of rows and are never fetched whole by default.
 */
export const ANCHOR_SETS = Object.freeze({
  "wildchat-de": Object.freeze({
    family: "wildchat",
    language: "de",
    dataset: SOURCES.wildchat.dataset,
    ...WILDCHAT_FILTER,
    where: `"language"='German'`,
    requiresLimit: false,
  }),
  "wildchat-en": Object.freeze({
    family: "wildchat",
    language: "en",
    dataset: SOURCES.wildchat.dataset,
    ...WILDCHAT_FILTER,
    where: `"language"='English'`,
    requiresLimit: true,
  }),
  "oasst2-de": Object.freeze({
    family: "oasst2",
    language: "de",
    dataset: SOURCES.oasst2.dataset,
    ...OASST2_FILTER,
    where: `"lang"='de'`,
    requiresLimit: false,
  }),
  "oasst2-en": Object.freeze({
    family: "oasst2",
    language: "en",
    dataset: SOURCES.oasst2.dataset,
    ...OASST2_FILTER,
    where: `"lang"='en'`,
    requiresLimit: true,
  }),
  longmemeval: Object.freeze({
    family: "longmemeval",
    language: "en",
    dataset: SOURCES.longmemeval.dataset,
    revision: "main",
    requiresLimit: false,
  }),
});

export const ANCHOR_SET_NAMES = Object.freeze(Object.keys(ANCHOR_SETS));

/** The registered set, or a usage-grade error naming the sets that exist. */
export function anchorSet(name) {
  const set = Object.hasOwn(ANCHOR_SETS, name) ? ANCHOR_SETS[name] : undefined;
  if (set === undefined)
    throw new RangeError(`unknown set "${name}"; use one of ${ANCHOR_SET_NAMES.join(", ")}`);
  return set;
}

/** The license terms of a set's source family. */
export function sourceOf(set) {
  return SOURCES[set.family];
}
