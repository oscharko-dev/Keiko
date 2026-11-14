// Re-grades the large-project step of S10 from a SAVED run, offline (#4369): no model and no new Keiko
// turn. The answer and the `jira.report` exchanges come from the retained Chat state of the run
// (`keiko-jira-live-chat-*/ui.db`), the figures from Jira itself through JQL counts as the session's
// oracle reader sees them. Use it after an oracle fix instead of repeating a model run.
// Usage: node regrade-large-project.mjs <session-directory> <retained-chat-state-directory>
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isMainModule } from "../../../lib/is-main-module.mjs";
import { loadSession } from "../lab-client.mjs";
import { journeyContext } from "./journeys.mjs";
import { LARGE_PROJECT, largeProjectPart } from "./large-project.mjs";

const PROMPT_START = "Werte den Fortschritt";

/** The saved LRG progress turn: its answer and the exchanges of the report calls that preceded it. */
export function savedLargeTurn(messages) {
  const at = messages.findIndex(
    (message) =>
      message.role === "user" &&
      message.content.startsWith(PROMPT_START) &&
      message.content.includes(LARGE_PROJECT),
  );
  if (at < 0) throw new TypeError("The saved run holds no large-project progress turn");
  const answer = messages.slice(at + 1).find((message) => message.role === "assistant");
  if (answer === undefined) throw new TypeError("The saved large-project turn has no answer");
  const transcript = messages[at].toolTranscript;
  return { answer: answer.content, toolExchanges: transcript?.exchanges ?? [] };
}

/** The messages of a retained state, in order, with the stored tool transcript parsed. */
export function savedMessages(stateDirectory) {
  const database = new DatabaseSync(join(resolve(stateDirectory), "ui.db"), { readOnly: true });
  try {
    return database
      .prepare("select role, content, tool_transcript_json from chat_messages order by timestamp")
      .all()
      .map((row) => ({
        role: String(row.role),
        content: String(row.content ?? ""),
        toolTranscript:
          typeof row.tool_transcript_json === "string"
            ? JSON.parse(row.tool_transcript_json)
            : undefined,
      }));
  } finally {
    database.close();
  }
}

/** The context the step needs: the saved turn instead of a model, the live Jira as the oracle. */
function offlineContext({ session, truth, saved }) {
  const live = journeyContext({}, session, truth);
  return {
    truth,
    oracleReader: live.oracleReader,
    displayNames: live.displayNames,
    count: live.count,
    freshChat: async () => ({ id: "saved-run" }),
    turn: async () => ({ ...saved, failure: undefined, durationMs: 0, toolCalls: 0 }),
  };
}

async function main() {
  const [directory, state] = process.argv.slice(2);
  if (!directory || !state)
    throw new TypeError("Usage: regrade-large-project.mjs <session> <state>");
  const session = loadSession(directory);
  const truth = JSON.parse(
    readFileSync(join(session.directory, "requirements-truth.json"), "utf8"),
  );
  const saved = savedLargeTurn(savedMessages(state));
  const { part } = await largeProjectPart(offlineContext({ session, truth, saved }));
  console.log(JSON.stringify({ operation: "regrade-large-project", ...part }));
}

if (isMainModule(import.meta.url)) await main();
