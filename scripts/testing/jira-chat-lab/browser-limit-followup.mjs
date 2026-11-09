// Selective follow-up after a completed limit run: the Story step and the Coding Workbench step.
// It reopens the run's retained product state and its three Chats and repeats none of the earlier
// steps. Importing this module never starts a live lab.
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSession } from "./lab-client.mjs";
import {
  createLimitRunContext,
  openLimitRunChats,
  readLimitFieldTruth,
} from "./browser-limit-run.mjs";
import {
  followupArguments,
  loadFollowupBlocks,
  openLimitFollowupIntent,
  prepareFollowupTruth,
  runLimitFollowup,
} from "./limit-run-followup.mjs";
import { withExclusiveProcessLock } from "./requirements/work-project-lock.mjs";

const FOLLOWUP_TIMEOUT_MS = 4 * 60 * 60 * 1000;

async function runSteps(live, options, steps, intent, blocks) {
  const signal = globalThis.AbortSignal.timeout(FOLLOWUP_TIMEOUT_MS);
  const opened = await openLimitRunChats(live, options, intent);
  try {
    const ctx = await createLimitRunContext(live, opened, options, intent, signal);
    await prepareFollowupTruth(ctx, readLimitFieldTruth);
    return await runLimitFollowup(ctx, steps, blocks);
  } finally {
    await opened.document.close();
  }
}

async function main(argv) {
  const { steps, ...options } = followupArguments(argv);
  const session = loadSession(options.sessionDir);
  const blocks = await loadFollowupBlocks();
  await withExclusiveProcessLock(
    join(session.directory, "browser-limit-run-owner"),
    "browser-limit-followup",
    async (assertOwned) => {
      const intent = openLimitFollowupIntent(session.directory, options, assertOwned);
      const { withLiveChat } = await import("./chat-read.mjs");
      let outcome;
      await withLiveChat({
        session,
        modelId: options.modelId,
        embeddingModelId: options.embeddingModelId,
        browser: true,
        ownedChild: true,
        retainState: true,
        restoreState: intent.state.stateDirectory,
        modelRetries: 0,
        run: async (live) => {
          outcome = await runSteps(live, options, steps, intent, blocks);
        },
      });
      if (outcome?.status !== "green") process.exitCode = 1;
      console.log(
        JSON.stringify({
          operation: "jira-browser-limit-followup",
          status: outcome?.status ?? "incomplete",
          steps,
        }),
      );
    },
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2)).catch((error) => {
    console.log(
      JSON.stringify({
        operation: "jira-browser-limit-followup",
        status: "incomplete",
        errorType: error instanceof Error ? error.name : "unknown",
      }),
    );
    process.exitCode = 1;
  });
}
