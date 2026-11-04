// Conversation text in the Activity Log (#4207, #4208). The log must stay body-free, and the lab holds
// the one thing that can prove it: the exact text it sent. After an instance has closed and before its
// state is removed, every long enough sentence the lab sent is looked for in the log files. A run of
// six words in the same order is no coincidence, and shorter text proves nothing in either direction.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const RUN_WORDS = 6;

function wordsOf(text) {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

function runsOf(words) {
  return Array.from({ length: Math.max(0, words.length - RUN_WORDS + 1) }, (_, index) =>
    words.slice(index, index + RUN_WORDS).join(" "),
  );
}

// What the lab itself put into the product: the user turns, the seeded poison and the probe questions.
function sentTexts(scenario) {
  return [
    ...scenario.turns.map((turn) => turn.user),
    ...(scenario.poison ?? []).map((entry) => entry.body),
    ...scenario.probes.map((probe) => probe.question),
  ];
}

/**
 * The number of texts the lab sent that the Activity Log repeats. A log directory that cannot be read
 * throws: the proof is missing, which is a failed unit and not a clean log.
 */
export function conversationTextInLog(logDirectory, scenario) {
  const logged = new Set();
  for (const name of readdirSync(logDirectory))
    for (const run of runsOf(wordsOf(readFileSync(join(logDirectory, name), "utf8"))))
      logged.add(run);
  return sentTexts(scenario).filter((text) => runsOf(wordsOf(text)).some((run) => logged.has(run)))
    .length;
}
