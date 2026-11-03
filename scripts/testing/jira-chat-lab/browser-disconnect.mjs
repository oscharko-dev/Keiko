import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { requireLicense } from "./lab-client.mjs";
import { withLiveChat } from "./chat-read.mjs";
import { chatToolRequest, commentState, privateJson } from "./chat-write.mjs";
import { observedMutationFault } from "./chat-fault-transport.mjs";
import { runBrowserWrite } from "./browser-write.mjs";
import {
  browserChatHistory,
  browserQualificationArguments,
  prepareBrowserWrite,
  recoverBrowserTurn,
  verifyBrowserToolTurn,
} from "./browser-recovery.mjs";
import {
  dropCommittedBrowserCompletion,
  verifyBrowserStreamFailure,
} from "./browser-response-drop.mjs";
import { reportFaultQualificationFailure } from "./chat-lifecycle.mjs";

const SCRIPT = fileURLToPath(import.meta.url);

function verifyConfirmedTransport(observer, drop) {
  const state = observer.snapshot();
  assert.equal(state.attempts, 1);
  assert.equal(state.forwarded, 1);
  assert.equal(state.injected, 0);
  assert.equal(state.actualStatus, 201);
  drop.assertDropped();
}

async function unchangedEffect(context, intent, observer, drop) {
  verifyConfirmedTransport(observer, drop);
  assert.deepEqual(await commentState(context.session, intent.key, intent.marker), intent.after);
  const completed = await browserChatHistory(context, intent);
  assert.deepEqual(verifyBrowserToolTurn(completed, intent, "succeeded"), intent.identity);
  return completed;
}

async function recoverDroppedCompletion(page, context, group, observer, drop) {
  const intent = group.current;
  verifyConfirmedTransport(observer, drop);
  await verifyBrowserStreamFailure(page, intent.clientTurnId);
  intent.browserStreamFailed = true;
  intent.bufferedFallbacks = drop.snapshot().bufferedRequests;
  assert.ok(intent.bufferedFallbacks <= 1);
  intent.after = await commentState(context.session, intent.key, intent.marker);
  assert.deepEqual(intent.after, { total: intent.before.total + 1, matches: 1 });
  intent.phase = "physical-disconnect-with-confirmed-single-effect";
  privateJson(group.pendingPath, group);
  await unchangedEffect(context, intent, observer, drop);
  await page.reload();
}

async function browserCase(context, group, observer, drop) {
  const intent = group.current;
  await prepareBrowserWrite(context, group);
  const result = await runBrowserWrite({
    context,
    chat: intent.chat,
    intent,
    prompt: chatToolRequest(context, intent.chat, intent).content,
    beforeDecision: async () => {
      assert.equal(observer.snapshot().attempts, 0);
      assert.deepEqual(
        await commentState(context.session, intent.key, intent.marker),
        intent.before,
      );
    },
    onIntent: (clientTurnId, request) => {
      intent.clientTurnId = clientTurnId;
      intent.request = request;
      privateJson(group.pendingPath, group);
    },
    observe: () => browserChatHistory(context, intent),
    beforeOutcome: ({ page }) => recoverDroppedCompletion(page, context, group, observer, drop),
    afterCompleted: ({ page }) =>
      recoverBrowserTurn(page, group, "succeeded", () =>
        unchangedEffect(context, intent, observer, drop),
      ),
  });
  assert.deepEqual(result.decisions, { grants: 1, approvals: 1 });
  verifyConfirmedTransport(observer, drop);
  intent.decisions = result.decisions;
}

async function qualify(session, modelId, group, key) {
  const intent = {
    key,
    marker: `Synthetic physical browser disconnect ${randomUUID()}`,
    mode: "governed-assist",
    transport: "browser",
    connection: "keyboard",
    phase: "prepared",
  };
  group.current = intent;
  privateJson(group.pendingPath, group);
  const observer = observedMutationFault(
    {
      method: "POST",
      path: `/rest/api/2/issue/${key}/comment`,
      body: { body: intent.marker },
    },
    "none",
  );
  const drop = dropCommittedBrowserCompletion(
    () => intent.chat?.id,
    (canonical) => {
      intent.identity = verifyBrowserToolTurn(canonical, intent, "succeeded");
      intent.phase = "durable-completion-before-physical-drop";
      privateJson(group.pendingPath, group);
    },
  );
  await withLiveChat({
    session,
    modelId,
    browser: true,
    retainState: true,
    configureServer: drop.configureServer,
    decorateAtlassianHttp: observer.decorate,
    stateReady: (stateDirectory) => {
      intent.stateDirectory = stateDirectory;
      privateJson(group.pendingPath, group);
    },
    run: (context) => browserCase(context, group, observer, drop),
  });
  verifyConfirmedTransport(observer, drop);
  await requireLicense(session);
  group.result = completedDisconnectResult(intent);
}

function completedDisconnectResult(intent) {
  assert.equal(intent.browserStreamFailed, true);
  assert.equal(intent.phase, "regenerate-preserved");
  return {
    effects: 1,
    physicalBffSocketDrop: true,
    browserStreamFailed: intent.browserStreamFailed,
    bufferedFallbacks: intent.bufferedFallbacks,
    jiraOutcome: "succeeded",
    jiraResponseFaultInjected: false,
    duplicatePreserved: true,
    reloadPreserved: true,
    visibleRegeneratePreserved: true,
  };
}

async function main() {
  const selected = await browserQualificationArguments("browser-disconnect");
  if (selected === undefined) return;
  const { session, modelId, pendingPath, key } = selected;
  const group = { id: randomUUID(), pendingPath };
  privateJson(pendingPath, group, true);
  await qualify(session, modelId, group, key);
  privateJson(join(session.directory, `browser-disconnect-${group.id}.json`), group, true);
  rmSync(pendingPath);
  console.log(
    JSON.stringify({ qualification: "jira-browser-physical-disconnect", passed: true, effects: 1 }),
  );
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT)
  await main().catch((error) =>
    reportFaultQualificationFailure("jira-browser-physical-disconnect", error),
  );
