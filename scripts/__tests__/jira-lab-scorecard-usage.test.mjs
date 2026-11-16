// The scorecard's usage errors, proven by running the script (#4369): an invocation that would grade
// nothing and call it valid, an empty selection and a German session with the English graders are
// refused before any Jira or model is touched.
import { execFile } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const run = promisify(execFile);
const SCORECARD = resolve(
  import.meta.dirname,
  "../testing/jira-chat-lab/requirements/scorecard.mjs",
);
const SESSION = {
  schemaVersion: 1,
  project: "keiko-jira-4081-0123456789ab",
  httpPort: 18090,
  httpsPort: 18453,
  jiraVersion: "10.3.26",
  jiraImageDigest: "a".repeat(64),
  syntheticOnly: true,
};

const directories = [];

/** A private session record that loads, with the language of the lab session it stands for. */
function sessionDirectory(locale) {
  const directory = mkdtempSync(join(tmpdir(), "scorecard-usage-"));
  directories.push(directory);
  writeFileSync(join(directory, "session.json"), JSON.stringify(SESSION), { mode: 0o600 });
  chmodSync(join(directory, "session.json"), 0o600);
  // `undefined` is a session that never ran seed-language.mjs: no language record at all.
  if (locale !== undefined)
    writeFileSync(join(directory, "language.json"), JSON.stringify({ locale }));
  return directory;
}

/** Runs the scorecard and returns what it refused with: its stderr text, or "" when it did not fail. */
async function refusal(args) {
  try {
    await run(process.execPath, [SCORECARD, ...args], { timeout: 110_000 });
    return "";
  } catch (error) {
    return String(error.stderr ?? error.message);
  }
}

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("scorecard usage errors, by execution", () => {
  it("refuses every invocation that would grade nothing or run the wrong thing", async () => {
    const english = sessionDirectory("en_US");
    const german = sessionDirectory("de_DE");
    // Sessions that cannot be told: no language record at all, French, Austrian German.
    const unrecorded = sessionDirectory(undefined);
    const french = sessionDirectory("fr_FR");
    const austrian = sessionDirectory("de_AT");
    const base = ["--project", "KEIKO", "--set", "composer"];
    const cases = [
      ["a Composer run with neither a model nor a rehearsal", [english, ...base], "needs --model"],
      [
        "a rehearsal that names a model",
        [english, ...base, "--rehearse", "--model", "m"],
        "takes no --model",
      ],
      ["an empty --types list", [english, ...base, "--model", "m", "--types", ""], "--types needs"],
      [
        "an empty --modes list",
        [english, ...base, "--model", "m", "--modes", ","],
        "--modes needs",
      ],
      [
        "a rehearsal on the document set",
        [english, "--project", "KEIKO", "--rehearse"],
        "--rehearse needs",
      ],
      [
        "the Composer journeys on a German session",
        [german, ...base, "--model", "m", "--only", "C01"],
        "German-language",
      ],
      [
        "a session without a language record",
        [unrecorded, ...base, "--model", "m"],
        "no language.json",
      ],
      // The language guard and the selection are checked by the script itself, before any Jira.
      [
        "a report part that does not exist",
        [english, ...base, "--model", "m", "--parts", "s12"],
        "--parts names s12",
      ],
      ["a French session", [french, ...base, "--model", "m"], "neither en_* nor de_DE"],
      ["an Austrian-German session", [austrian, ...base, "--rehearse"], "neither en_* nor de_DE"],
    ];
    const answers = await Promise.all(cases.map(([, args]) => refusal(args)));
    cases.forEach(([name, , message], index) => {
      expect(answers[index], name).toContain(message);
    });
  }, 120_000);
});
