// The sentence pools of the scripted writer (#4208): generic work talk in German and English that a
// person of a given role could say to an assistant, with no preference, habit, decision, credential or
// third party in it. The scripted writer is the floor of the corpus, used by tests and offline builds;
// it combines these pools by slots, so thousands of exchanges are mostly distinct, but it is not a
// substitute for model-written text and the variety figures say so. German object phrases are in the
// accusative, so every template below uses only verbs and prepositions that take it.
//
// Words that carry a typical fact term (format, brevity, order, tools) are kept out on purpose; the
// generator additionally filters every sentence against the blueprint's own terms.

//
// The pools are data and live in `pools/<language>.json`; this module loads and freezes them.
import { readFileSync } from "node:fs";
import { URL, fileURLToPath } from "node:url";

const LANGUAGES = Object.freeze(["de", "en"]);

function deepFreeze(value) {
  if (typeof value !== "object" || value === null) return value;
  for (const item of Object.values(value)) deepFreeze(item);
  return Object.freeze(value);
}

function loadPool(language) {
  const path = fileURLToPath(new URL(`./pools/${language}.json`, import.meta.url));
  return JSON.parse(readFileSync(path, "utf8"));
}

export const POOLS = deepFreeze(
  Object.fromEntries(LANGUAGES.map((language) => [language, loadPool(language)])),
);
