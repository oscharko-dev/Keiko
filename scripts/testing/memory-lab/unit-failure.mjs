// A unit of the lab (one scenario, arm and repetition on its own instance) that could not be
// measured (#4207). One failing unit must not cost a run that took hours: the runner records it as a
// result with an `error`, an empty store and no probes, and goes on. The report turns such a result
// into a failed store entry (`unit-failed:<name>`) and counts it, so a failure is loud in the
// summary and in the exit code instead of being averaged away or silently dropped.
import { errorMessage } from "../coding-workbench-lab/lab-common.mjs";
import { HARD_COUNTERS } from "./score.mjs";
import { redactText } from "./anchor/redact.mjs";

const MAX_MESSAGE_CHARS = 300;
const ERROR_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/u;
// Two or more path segments, with or without a drive letter: a host path, never a route or a word.
const ABSOLUTE_PATH = /(?:[A-Za-z]:)?(?:[\\/][^\s\\/'"`<>|:*?()[\]{},;]+){2,}[\\/]?/gu;
const SPACES = /\s+/gu;

/** The error as the evidence may carry it: its class name and, when allowed, a scrubbed message. */
export function describeUnitError(error, includeMessage) {
  const name =
    typeof error?.name === "string" && ERROR_NAME.test(error.name) ? error.name : "Error";
  if (!includeMessage) return { name, message: "" };
  const redacted = redactText(errorMessage(error)).text;
  const message = redacted
    .replace(ABSOLUTE_PATH, "<path>")
    .replace(SPACES, " ")
    .trim()
    .slice(0, MAX_MESSAGE_CHARS);
  return { name, message };
}

function emptyStore() {
  return {
    stored: 0,
    live: 0,
    parked: 0,
    forbiddenParked: 0,
    correct: 0,
    precision: null,
    recall: null,
    missing: [],
    counters: Object.fromEntries(HARD_COUNTERS.map((name) => [name, 0])),
    verdicts: [],
    memories: [],
  };
}

/**
 * The result of a unit that threw. `name` is how the evidence calls the scenario (its id, or the
 * masked name of a sealed holdout). The message is included only for a run whose scenario text may
 * appear in evidence; a sealed holdout and real conversations keep the error's name alone, because a
 * failing call can echo the conversation in its message.
 */
export function failedUnitResult({ scenario, name, arm, repetition, error, includeMessage }) {
  return {
    scenario: name,
    language: scenario.language,
    class: scenario.class,
    difficulty: scenario.difficulty,
    arm,
    repetition,
    turns: [],
    store: emptyStore(),
    captures: [],
    probes: [],
    probeCaptures: 0,
    timing: { learnMs: 0, probeMs: 0 },
    requests: [],
    foldedKeys: [],
    instanceStartMs: 0,
    startupRereads: 0,
    error: describeUnitError(error, includeMessage),
  };
}

/** True for a result produced by `failedUnitResult`. */
export function isFailedUnit(result) {
  return result.error !== undefined;
}
