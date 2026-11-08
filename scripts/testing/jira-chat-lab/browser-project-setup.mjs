// AC5 observes the orchestrator's two prepared Chats and sends only through its turn owner.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { URLSearchParams } from "node:url";
import { readPrivateFile } from "./lab-client.mjs";
import { openLimitStep } from "./limit-run-step.mjs";
import {
  projectAgileRead,
  projectInventory,
  nativePages,
  unchangedProjects,
  oneNewProject,
  completedOperation,
  permissionRefusal,
} from "./project-agile-oracles.mjs";

class SetupProofFailure extends TypeError {
  constructor(detail, options) {
    super(detail, options);
    this.detail = detail;
  }
}
function proof(condition, detail = "project-readback-unavailable") {
  if (!condition) throw new SetupProofFailure(detail);
}
function digest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function projectIdentity(ctx) {
  let deniedKey = `ZX${digest(ctx.projectKey).slice(0, 8).toUpperCase()}`;
  if (deniedKey === ctx.projectKey) deniedKey = `ZY${deniedKey.slice(2)}`;
  return { key: ctx.projectKey, name: `Limit ${ctx.projectKey}`, deniedKey };
}

async function nativeActor(session, authorization, administer) {
  const actor = await projectAgileRead(session, "/rest/api/2/myself", authorization);
  proof(
    actor.active === true &&
      typeof actor.key === "string" &&
      actor.key.length > 0 &&
      typeof actor.name === "string" &&
      actor.name.length > 0,
    "project-identity-unavailable",
  );
  const permissions = await projectAgileRead(
    session,
    "/rest/api/2/mypermissions?permissions=ADMINISTER",
    authorization,
  );
  proof(
    permissions.permissions?.ADMINISTER?.havePermission === administer,
    "project-identity-unavailable",
  );
  return { key: actor.key, name: actor.name, authorization, digest: digest(actor.key) };
}

async function actorsFor(ctx) {
  const deniedToken = ctx.deniedToken ?? join(ctx.session.directory, "secrets", "restricted-token");
  const permittedToken =
    ctx.permittedToken ?? join(ctx.session.directory, "secrets", "admin-token");
  proof(
    typeof deniedToken === "string" &&
      isAbsolute(deniedToken) &&
      typeof permittedToken === "string" &&
      isAbsolute(permittedToken),
    "project-identity-unavailable",
  );
  const deniedAuth = `Bearer ${readPrivateFile(deniedToken)}`;
  const permittedAuth = `Bearer ${readPrivateFile(permittedToken)}`;
  proof(deniedAuth !== permittedAuth, "project-identity-unavailable");
  const denied = await nativeActor(ctx.session, deniedAuth, false);
  const permitted = await nativeActor(ctx.session, permittedAuth, true);
  proof(
    denied.key !== permitted.key && denied.name !== permitted.name,
    "project-identity-unavailable",
  );
  return { denied, permitted };
}

async function browserJson(page, path) {
  const response = await page.request.get(path);
  proof(response.status() === 200, "project-identity-unavailable");
  return response.json();
}
async function credentials(page) {
  const result = await browserJson(page, "/api/atlassian-connectors/credentials");
  proof(Array.isArray(result.credentials), "project-identity-unavailable");
  return result.credentials;
}
async function currentChat(ctx, supplied) {
  proof(
    typeof supplied?.id === "string" && typeof supplied.projectPath === "string",
    "project-identity-unavailable",
  );
  const query = new URLSearchParams({
    id: supplied.id,
    projectPath: supplied.projectPath,
  });
  const result = await browserJson(ctx.page, `/api/chats?${query}`);
  const matches = result.chats?.filter(
    (chat) =>
      chat.id === supplied.id &&
      chat.projectPath === supplied.projectPath &&
      chat.selectedModel === ctx.modelId,
  );
  proof(matches?.length === 1, "project-identity-unavailable");
  const chat = matches[0];
  proof(
    chat.status !== "closed" &&
      chat.effectiveToolMode === "autonomous-delivery" &&
      chat.jiraAdministrationEnabled === true,
    "project-identity-unavailable",
  );
  return chat;
}
function patCredential(credential) {
  return (
    credential?.provider === "jira" &&
    credential.deployment === "data-center" &&
    credential.authScheme === "bearer-pat" &&
    typeof credential.authRef === "string"
  );
}
function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}
function readyPod(credential) {
  const pod = credential?.livePod;
  proof(
    patCredential(credential) &&
      pod?.verificationStatus === "ok" &&
      pod.verificationInProgress === false &&
      positiveInteger(pod.authenticationGeneration) &&
      positiveInteger(pod.verificationRevision),
    "project-identity-unavailable",
  );
  return pod;
}
async function boundPod(chat, credential) {
  const pod = readyPod(credential);
  const binding = chat.jiraPodBinding;
  proof(
    binding?.podId === pod.podId &&
      binding.authenticationGeneration === pod.authenticationGeneration &&
      Number.isSafeInteger(binding.bindingGeneration) &&
      binding.bindingGeneration > 0,
    "project-identity-unavailable",
  );
  return { pod, binding };
}

async function inspectChats(ctx) {
  proof(ctx.chat?.id !== ctx.deniedChat?.id, "project-identity-unavailable");
  const permittedChat = await currentChat(ctx, ctx.chat);
  const deniedChat = await currentChat(ctx, ctx.deniedChat);
  const knowledge =
    deniedChat.localKnowledgeScopes ??
    (deniedChat.localKnowledgeScope === undefined ? [] : [deniedChat.localKnowledgeScope]);
  proof(Array.isArray(knowledge) && knowledge.length === 0, "project-identity-unavailable");
  const listed = await credentials(ctx.page);
  const observed = async (chat) => {
    const matches = listed.filter((entry) => entry.livePod?.podId === chat.jiraPodBinding?.podId);
    proof(matches.length === 1, "project-identity-unavailable");
    return { ...(await boundPod(chat, matches[0])), credential: matches[0] };
  };
  const denied = await observed(deniedChat);
  const permitted = await observed(permittedChat);
  proof(
    denied.pod.podId !== permitted.pod.podId &&
      denied.credential.authRef !== permitted.credential.authRef &&
      denied.credential.displayName === "Limit Run Restricted",
    "project-identity-unavailable",
  );
  return { denied, permitted };
}

function bindingResources(ctx, { denied, permitted }) {
  return {
    chatId: ctx.chat.id,
    deniedChatId: ctx.deniedChat.id,
    deniedActorClass: "restricted",
    deniedPodId: denied.pod.podId,
    deniedAuthenticationGeneration: denied.pod.authenticationGeneration,
    deniedBindingGeneration: denied.binding.bindingGeneration,
    permittedPodId: permitted.pod.podId,
    permittedAuthenticationGeneration: permitted.pod.authenticationGeneration,
    permittedBindingGeneration: permitted.binding.bindingGeneration,
  };
}
function sameBindings(ctx, resources, observed) {
  return Object.entries(bindingResources(ctx, observed)).every(
    ([key, value]) => resources[key] === value,
  );
}

/** A valid zero-result page proves a count; an error or a missing total proves nothing. */
async function issueCount(session, jql) {
  const query = new URLSearchParams({ jql, startAt: "0", maxResults: "0", fields: "project" });
  const body = await projectAgileRead(session, `/rest/api/2/search?${query}`);
  proof(
    body.startAt === 0 &&
      Array.isArray(body.issues) &&
      body.issues.length === 0 &&
      Number.isSafeInteger(body.total) &&
      body.total >= 0,
  );
  return body.total;
}
async function inventory(session) {
  return {
    projects: await projectInventory(session),
    issues: await issueCount(session, "ORDER BY id ASC"),
  };
}
function unchangedDenied(before, after) {
  try {
    unchangedProjects(before.projects, after.projects);
  } catch {
    throw new SetupProofFailure("project-native-change");
  }
  proof(before.issues === after.issues, "project-native-change");
}
function createPrompt(identity, actor, denied) {
  const key = denied ? identity.deniedKey : identity.key;
  const name = denied ? `${identity.name} denied` : identity.name;
  return (
    `Create exactly one Jira Software Scrum project with key ${key}, name "${name}", ` +
    `project lead ${actor.name}, using a currently supported native Scrum project template. ` +
    "Inspect current options and permissions first. " +
    (denied
      ? "Then submit the creation exactly once even if a permission fact suggests a refusal: " +
        "only Jira's own response to that request decides it. "
      : "") +
    "Do not create issues, change permissions, " +
    "create a replacement, retry a rejected or uncertain write, or correct a permission failure. " +
    "Show the actual project key and link or the precise native permission refusal."
  );
}
async function chatAction(
  ctx,
  chat,
  journal,
  operation,
  prompt,
  counts,
  denied = false,
  reviewText = [],
) {
  ctx.signal.throwIfAborted();
  proof(
    sameBindings(ctx, journal.state.resources, await inspectChats(ctx)),
    "project-identity-unavailable",
  );
  const turn = await ctx.turn(chat, prompt, {
    operations: [operation],
    reviewText,
    allowFailure: denied,
    beforeDecision: () => {
      ctx.signal.throwIfAborted();
      throw new SetupProofFailure(
        denied ? "project-refusal-unverified" : "project-create-unconfirmed",
      );
    },
  });
  counts.approvals += turn.decisions;
  proof(turn.decisions === 0, denied ? "project-refusal-unverified" : "project-create-unconfirmed");
  return turn;
}

async function deniedProject(ctx, journal, actors, identity, session, counts) {
  const before = await inventory(session);
  proof(
    !before.projects.some(
      (project) => project.key === identity.key || project.key === identity.deniedKey,
    ),
    "project-native-change",
  );
  counts.deniedAttempts += 1;
  await journal.checkpoint({ resources: { baselineDigest: digest(before) }, counts });
  const turn = await chatAction(
    ctx,
    ctx.deniedChat,
    journal,
    "jira.create-project",
    createPrompt(identity, actors.denied, true),
    counts,
    true,
  );
  const after = await inventory(session);
  unchangedDenied(before, after);
  try {
    permissionRefusal(turn);
  } catch (error) {
    // A missing or unpreserved native refusal is a refusal proof failure, not a readback failure.
    throw new SetupProofFailure("project-refusal-unverified", { cause: error });
  }
  proof(
    turn.decisions === 0 && !turn.exchanges.some((exchange) => exchange.effectStarted === true),
    "project-refusal-unverified",
  );
  counts.deniedProjects = 0;
  counts.deniedIssues = 0;
  await journal.checkpoint({ resources: { deniedVerified: true }, counts });
  return after;
}

async function nativeProject(session, identity, actor, projectId) {
  const project = await projectAgileRead(session, `/rest/api/2/project/${projectId}`);
  proof(
    String(project.id) === projectId &&
      project.key === identity.key &&
      project.name === identity.name &&
      project.projectTypeKey === "software" &&
      project.lead?.name === actor.name,
  );
  return {
    id: projectId,
    key: project.key,
    name: project.name,
    type: project.projectTypeKey,
    lead: digest(actor.key),
  };
}
async function permittedProject(ctx, journal, actors, identity, session, before, counts) {
  const turn = await chatAction(
    ctx,
    ctx.chat,
    journal,
    "jira.create-project",
    createPrompt(identity, actors.permitted, false),
    counts,
    false,
    [identity.key, identity.name],
  );
  const receipt = completedOperation(turn, "jira.create-project");
  const after = await inventory(session);
  const project = oneNewProject(before.projects, after.projects, identity);
  proof(
    receipt.projectKey === project.key && turn.decisions === 0 && before.issues === after.issues,
  );
  counts.createdProjects = 1;
  counts.issues = await issueCount(session, `project = ${identity.key} ORDER BY id ASC`);
  proof(counts.issues === 0, "project-native-change");
  await journal.checkpoint({ resources: { projectId: project.id }, counts });
  return nativeProject(session, identity, actors.permitted, project.id);
}

async function projectBoards(session, key) {
  return nativePages(
    (path) => projectAgileRead(session, path),
    `/rest/agile/1.0/board?projectKeyOrId=${encodeURIComponent(key)}`,
    "values",
  );
}
async function createBoard(ctx, journal, identity, session, counts) {
  await journal.checkpoint({ counts });
  const name = `${identity.name} filter`;
  const sharing = await projectAgileRead(session, "/rest/api/2/filter/defaultShareScope");
  proof(sharing.scope === "PRIVATE");
  const jql = `project = ${identity.key} ORDER BY Rank ASC`;
  const filterTurn = await chatAction(
    ctx,
    ctx.chat,
    journal,
    "jira.create-filter",
    `Create exactly one PRIVATE saved filter named "${name}" with JQL "${jql}". ` +
      "Read current default sharing first, preserve PRIVATE sharing, accept the documented non-atomic " +
      "creation limitation and do not change sharing or retry.",
    counts,
    false,
    [name],
  );
  const filter = completedOperation(filterTurn, "jira.create-filter");
  const native = await projectAgileRead(session, `/rest/api/2/filter/${filter.filterId}`);
  proof(
    native.name === name &&
      native.jql === jql &&
      Array.isArray(native.sharePermissions) &&
      native.sharePermissions.length === 0 &&
      filterTurn.decisions === 0,
  );
  await journal.checkpoint({ resources: { filterId: String(native.id) }, counts });
  const boardName = `${identity.name} Scrum`;
  const boardTurn = await chatAction(
    ctx,
    ctx.chat,
    journal,
    "jira.board-create",
    `Create exactly one Scrum board named "${boardName}" using saved filter ${native.id}. ` +
      "Read its filter and preserve private sharing. Show the actual board link and do not retry.",
    counts,
    false,
    [boardName, String(native.id)],
  );
  const receipt = completedOperation(boardTurn, "jira.board-create");
  proof(boardTurn.decisions === 0);
  return receipt.boardId;
}
async function scrumBoard(ctx, journal, identity, session, counts) {
  let boards = await projectBoards(session, identity.key);
  if (boards.length === 0) {
    const createdId = await createBoard(ctx, journal, identity, session, counts);
    boards = await projectBoards(session, identity.key);
    proof(boards.length === 1 && String(boards[0].id) === createdId);
  }
  proof(boards.length === 1 && boards[0].type === "scrum");
  const id = String(boards[0].id);
  const board = await readBoard(session, id, journal.state.resources.filterId);
  await journal.checkpoint({ resources: { boardId: id }, counts });
  return board;
}
async function readBoard(session, id, filterId) {
  const native = await projectAgileRead(session, `/rest/agile/1.0/board/${id}/configuration`);
  proof(String(native.id) === id && native.type === "scrum");
  if (filterId !== undefined) proof(String(native.filter?.id) === filterId);
  return { id, type: native.type };
}

async function executeSetup(ctx, journal, counts) {
  const identity = projectIdentity(ctx);
  const actors = await actorsFor(ctx);
  const bindings = await inspectChats(ctx);
  await journal.checkpoint({
    phase: "pending",
    resources: {
      ...bindingResources(ctx, bindings),
      deniedKey: identity.deniedKey,
    },
    counts,
  });
  const session = { ...ctx.session, oracleAuthorization: actors.permitted.authorization };
  const before = await deniedProject(ctx, journal, actors, identity, session, counts);
  const project = await permittedProject(ctx, journal, actors, identity, session, before, counts);
  const board = await scrumBoard(ctx, journal, identity, session, counts);
  counts.issues = await issueCount(session, `project = ${identity.key} ORDER BY id ASC`);
  proof(counts.issues === 0, "project-native-change");
  await journal.checkpoint({
    phase: "completed",
    resources: { baselineDigest: digest({ project, board }) },
    counts,
  });
  return journal.result("green", "project-created", counts);
}
function completedSetup(ctx, { resources, counts }) {
  return (
    ctx.chat?.id === resources.chatId &&
    ctx.deniedChat?.id === resources.deniedChatId &&
    resources.deniedVerified === true &&
    counts.deniedAttempts === 1 &&
    counts.deniedProjects === 0 &&
    counts.deniedIssues === 0 &&
    counts.createdProjects === 1
  );
}
async function reverifySetup(ctx, journal) {
  const { resources, counts } = journal.state;
  proof(completedSetup(ctx, journal.state));
  const actors = await actorsFor(ctx);
  proof(sameBindings(ctx, resources, await inspectChats(ctx)), "project-identity-unavailable");
  const session = { ...ctx.session, oracleAuthorization: actors.permitted.authorization };
  const identity = projectIdentity(ctx);
  const projects = await projectInventory(session);
  proof(!projects.some((entry) => entry.key === resources.deniedKey));
  const project = await nativeProject(session, identity, actors.permitted, resources.projectId);
  const boards = await projectBoards(session, identity.key);
  proof(
    boards.length === 1 && String(boards[0].id) === resources.boardId && boards[0].type === "scrum",
  );
  const board = await readBoard(session, resources.boardId, resources.filterId);
  proof(digest({ project, board }) === resources.baselineDigest);
  const issues = await issueCount(session, `project = ${identity.key} ORDER BY id ASC`);
  return journal.result("green", "project-reverified", { ...counts, issues });
}

function setupFailure(ctx, journal, counts, error) {
  const observed = journal.state.phase === "completed" ? journal.state.counts : counts;
  if (ctx.signal.aborted) return journal.result("unverified", "project-aborted", observed);
  if (error instanceof SetupProofFailure && journal.state.phase !== "completed")
    return journal.result(
      error.detail === "project-native-change" ? "red" : "unverified",
      error.detail,
      observed,
    );
  return journal.result("unverified", "project-readback-unavailable", observed);
}

/** Fresh project creation after a distinct, natively non-admin PAT proves the denied zero effect. */
export async function runProjectSetup(ctx, { deniedActor }) {
  assert.equal(deniedActor, true, "AC5 requires the separate denied actor proof");
  if (ctx.signal.aborted)
    return { step: "ac5-project", status: "unverified", detail: "project-aborted", counts: {} };
  const journal = await openLimitStep(ctx, "ac5-project");
  if (ctx.deniedChat === undefined || ctx.deniedChat === null)
    return journal.result("unverified", "denied-chat-unavailable", journal.state.counts);
  if (journal.state.phase === "pending")
    return journal.result("unverified", "project-pending", journal.state.counts);
  const counts = { deniedAttempts: 0, createdProjects: 0, approvals: 0 };
  try {
    proof(typeof ctx.turn === "function", "project-identity-unavailable");
    if (journal.state.phase === "completed") return await reverifySetup(ctx, journal);
    return await executeSetup(ctx, journal, counts);
  } catch (error) {
    return setupFailure(ctx, journal, counts, error);
  }
}
