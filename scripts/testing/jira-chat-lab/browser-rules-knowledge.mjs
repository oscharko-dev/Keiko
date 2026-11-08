// Real UI + real model qualification, never invoked by the source regression suite.
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSession } from "./lab-client.mjs";
import { privateJson } from "./private-json.mjs";
import { withLiveChat } from "./chat-read.mjs";
import { withWorkProjectLock } from "./requirements/work-project-lock.mjs";
import { runBrowserRulesKnowledge } from "./browser-rules-knowledge-journey.mjs";

export function rulesKnowledgeArguments(argv) {
  const [directory, modelId, embeddingModelId, boardId, ...extra] = argv;
  if (!directory || !modelId || !embeddingModelId || modelId === embeddingModelId ||
    !/^[1-9][0-9]{0,14}$/u.test(boardId ?? "") || extra.length !== 0)
    throw new TypeError("Usage: browser-rules-knowledge.mjs <session-directory> <model-id> <embedding-model-id> <REQ-board-id>");
  return { directory, modelId, embeddingModelId, boardId };
}

async function main(argv) {
  const options = rulesKnowledgeArguments(argv);
  const session = loadSession(options.directory);
  const intentPath = join(session.directory, "browser-rules-knowledge-intent.json");
  // An existing intent, including a failed one, requires independent reconciliation, not replay.
  privateJson(intentPath, { schemaVersion: 1, scenario: "rules-knowledge", phase: "reserved" }, true);
  let result;
  await withWorkProjectLock(session.directory, "browser-rules-knowledge", () => withLiveChat({
    session, modelId: options.modelId, embeddingModelId: options.embeddingModelId,
    browser: true, retainState: true, modelRetries: 0,
    run: async (context) => { result = await runBrowserRulesKnowledge(context, { ...options, intentPath }); },
  }));
  // The withLiveChat closing license check must also finish before the private success record.
  privateJson(intentPath, { schemaVersion: 1, scenario: "rules-knowledge", phase: "completed", result });
  console.log(JSON.stringify({ operation: "jira-browser-rules-knowledge", passed: true, ...result }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2));
}
