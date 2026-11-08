import assert from "node:assert/strict";
import { join } from "node:path";
import { labSessionConnection } from "./lab-client.mjs";
import { openWorkflowBrowser, sendBrowserTurn, workflowHistory } from "./browser-workflow-turn.mjs";
import { projectAgileRead, projectInventory, nativePages, oneNewProject, unchangedProjects,
  exactIssue, epicRelation, exactSprint, exactMembership, completedOperation, permissionRefusal,
  oneObservedEffect } from "./project-agile-oracles.mjs";

function noUnexpectedEffect(snapshot) {
  assert.equal(snapshot.blocked, 0, "A blocked extra dispatch is a failed qualification");
  assert.ok(snapshot.forwarded <= 1);
  assert.ok(snapshot.statuses.every((status) => status === 400 || status === 403));
}

async function visibleReceipt(environment, text) {
  const cards = environment.region.getByRole("region", { name: "Jira action", exact: true });
  await cards.filter({ hasText: text }).last().waitFor();
  assert.equal(await cards.locator("pre").count(), 0);
}

async function visibleLink(environment, key, path) {
  const link = environment.region.getByRole("link").filter({ hasText: key }).first();
  await link.waitFor();
  assert.equal(await link.getAttribute("href"), `${labSessionConnection(environment.context.session).httpsOrigin}${path}`);
}

async function visibleBoardLink(environment, boardId) {
  const destination = `${labSessionConnection(environment.context.session).httpsOrigin}/secure/RapidBoard.jspa?rapidView=${boardId}`;
  const link = environment.region.getByRole("region", { name: "Jira action", exact: true })
    .getByRole("link").and(environment.page.locator(`a[href="${destination}"]`)).first();
  await link.waitFor();
  assert.ok((await link.innerText()).trim().length > 0, "The actual board destination has a readable label");
}

async function step(environment, definition) {
  const { context, group, witness, persist } = environment;
  group.current = { name: definition.name, phase: "prepared", chatId: environment.chat.id };
  witness.arm(definition.wire);
  persist();
  const turn = await sendBrowserTurn(environment.page, environment.region, context,
    environment.chat.id, definition.prompt, {
      operations: [definition.operation], reviewText: definition.reviewText ?? [],
      allowFailure: definition.denied === true,
      persist: (state) => { Object.assign(group.current, state); persist(); },
      beforeDecision: () => assert.equal(witness.snapshot().forwarded, 0),
    });
  const wire = witness.snapshot();
  if (definition.denied) noUnexpectedEffect(wire);
  else oneObservedEffect(wire);
  assert.equal(turn.decisions, wire.forwarded,
    "Every forwarded write requires exactly its visible approval; preflight refusals require none");
  const proof = await definition.verify(turn);
  group.results.push({ name: definition.name, clientTurnId: turn.clientTurnId,
    userId: turn.user.id, approvals: turn.decisions, wire, proof });
  group.current.phase = "independently-observed";
  persist();
  return proof;
}

async function issueRead(context, key) {
  return projectAgileRead(context.session, `/rest/api/2/issue/${encodeURIComponent(key)}?fields=*all`);
}

async function createIssue(environment, type, summary, epic) {
  const { group, context } = environment;
  const project = group.project;
  const query = `project = ${project.key} ORDER BY key`;
  const readIssues = () => nativePages((path) => projectAgileRead(context.session, path),
    `/rest/api/2/search?jql=${encodeURIComponent(query)}&fields=summary,issuetype,project`, "issues");
  const before = await readIssues();
  return step(environment, {
    name: type === "Epic" ? "project-epic" : "project-task", operation: "jira.create",
    prompt: `Create exactly one ${type} in project ${project.key}, summary "${summary}", with a readable description of this synthetic acceptance task. Discover the current type and required fields. ${epic ? `It implements Epic ${epic.key}; bind the actual native Epic relationship in the same create.` : "Set the native Epic name to the summary if required."} Use the ordinary single-issue create action; do not create any other issue or retry a write. Show the key and link.`,
    reviewText: [summary],
    wire: { method: "POST", path: "/rest/api/2/issue", admit: (body) => body?.fields?.summary === summary &&
      (body.fields.project?.key === project.key || String(body.fields.project?.id) === project.id) },
    verify: async (turn) => {
      const result = completedOperation(turn, "jira.create");
      const after = await readIssues();
      const prior = new Set(before.map((issue) => issue.key));
      const added = after.filter((issue) => !prior.has(issue.key));
      assert.equal(added.length, 1);
      assert.equal(result.issueKey, added[0].key);
      const native = await issueRead(context, added[0].key);
      const observed = exactIssue(native, { projectKey: project.key, summary, issueType: type });
      if (epic) epicRelation(native, epic, await projectAgileRead(context.session, "/rest/api/2/field"));
      await visibleReceipt(environment, observed.key);
      await visibleLink(environment, observed.key, `/browse/${observed.key}`);
      return observed;
    },
  });
}

async function createProject(environment, actor, denied) {
  const { context, group } = environment;
  const key = denied ? group.deniedKey : group.key;
  const name = denied ? `${group.name} denied` : group.name;
  const before = await projectInventory(context.session);
  assert.equal(before.some((project) => project.key === key), false);
  return step(environment, {
    name: denied ? "project-denied" : "project-permitted", operation: "jira.create-project", denied,
    prompt: `Create one Jira Software Scrum project with key ${key}, name "${name}", project lead ${actor.name}, and the supported native Scrum project template. Inspect current native options and permissions first. Do not create a replacement project, change permissions, or retry a rejected/uncertain write. Return the actual project key and link, or the precise permission failure.`,
    reviewText: [key, name],
    wire: { method: "POST", path: "/rest/api/2/project", admit: (body) => body?.key === key && body.name === name && body.lead === actor.name },
    verify: async (turn) => {
      const after = await projectInventory(context.session);
      if (denied) {
        permissionRefusal(turn);
        unchangedProjects(before, after);
        assert.equal(after.some((project) => project.key === key), false);
        await environment.region.getByText(/permission|administrator|administration/i).last().waitFor();
        return { denied: true, projectCreated: false };
      }
      const result = completedOperation(turn, "jira.create-project");
      const project = oneNewProject(before, after, { key, name });
      const native = await projectAgileRead(context.session, `/rest/api/2/project/${project.id}`);
      assert.equal(native.key, key);
      assert.equal(native.projectTypeKey, "software");
      assert.equal(native.lead?.name, actor.name);
      assert.equal(result.projectKey, key);
      await visibleReceipt(environment, key);
      await visibleLink(environment, key, `/projects/${key}/summary`);
      return project;
    },
  });
}

async function createBoard(environment) {
  const { context, group } = environment;
  const jql = `project = ${group.project.key} ORDER BY Rank ASC`;
  const filterName = `${group.name} filter`;
  group.filter = await step(environment, {
    name: "board-filter", operation: "jira.create-filter", reviewText: [filterName],
    prompt: `Create one saved filter named "${filterName}" with JQL "${jql}". Inspect the actual owner and default sharing first. This qualification accepts only PRIVATE default sharing; accept its documented non-atomic creation limitation but do not change sharing, favourites or create global shares. Do not retry creation.`,
    wire: { method: "POST", path: "/rest/api/2/filter", admit: (body) => body?.name === filterName && body.jql === jql },
    verify: async (turn) => {
      const result = completedOperation(turn, "jira.create-filter");
      const native = await projectAgileRead(context.session, `/rest/api/2/filter/${result.filterId}`);
      assert.equal(native.name, filterName);
      assert.equal(native.jql, jql);
      assert.deepEqual(native.sharePermissions, []);
      return { id: String(native.id), name: native.name };
    },
  });
  const name = `${group.name} board`;
  const list = () => nativePages((path) => projectAgileRead(context.session, path),
    `/rest/agile/1.0/board?name=${encodeURIComponent(name)}`, "values");
  const before = await list();
  assert.equal(before.filter((board) => board.name === name).length, 0);
  return step(environment, {
    name: "board-create", operation: "jira.board-create", reviewText: [name, group.filter.id],
    prompt: `Create exactly one Scrum board named "${name}" using the saved filter ${group.filter.id}. Read the filter first and preserve its private sharing. Show its real board link; do not retry.`,
    wire: { method: "POST", path: "/rest/agile/1.0/board", admit: (body) => body?.name === name && body.type === "scrum" && String(body.filterId) === group.filter.id },
    verify: async (turn) => {
      const result = completedOperation(turn, "jira.board-create");
      const boards = (await list()).filter((board) => board.name === name);
      assert.equal(boards.length, 1);
      assert.equal(String(boards[0].id), result.boardId);
      const config = await projectAgileRead(context.session, `/rest/agile/1.0/board/${result.boardId}/configuration`);
      assert.equal(config.type, "scrum");
      assert.equal(String(config.filter.id), group.filter.id);
      await visibleReceipt(environment, result.boardId);
      await visibleBoardLink(environment, result.boardId);
      return { id: result.boardId, name };
    },
  });
}

async function sprintRead(environment, state) {
  const { group, context } = environment;
  const native = await projectAgileRead(context.session, `/rest/agile/1.0/sprint/${group.sprint.id}`);
  exactSprint(native, { ...group.sprint, boardId: group.board.id, state });
  return { id: String(native.id), name: native.name, state: native.state, boardId: String(native.originBoardId) };
}

async function sprintMembership(environment) {
  const { context, group } = environment;
  const issues = await nativePages((path) => projectAgileRead(context.session, path),
    `/rest/agile/1.0/sprint/${group.sprint.id}/issue`, "issues");
  exactMembership(issues, [group.task.key]);
  return issues.map((issue) => issue.key);
}

async function constraint(environment, name, desiredState, observedState) {
  const { group } = environment;
  return step(environment, {
    name, operation: "jira.sprint-update", denied: true,
    prompt: `Attempt once to change sprint ${group.sprint.id} from its current ${observedState} state to ${desiredState} using the sprint update action. Report the native-state constraint refusal. Do not change any other field, start an intermediate state, create a replacement, or retry.`,
    wire: undefined,
    verify: async (turn) => {
      const exchanges = turn.exchanges.filter((exchange) => exchange.call.name === "jira_sprint_update");
      assert.equal(exchanges.length, 1);
      assert.notEqual(exchanges[0].result?.data?.outcome, "succeeded");
      assert.equal(exchanges[0].result?.data?.reason, "invalid-transition");
      assert.equal(environment.witness.snapshot().forwarded, 0, "Known invalid state must refuse before effects");
      const state = await sprintRead(environment, observedState);
      assert.ok(turn.answer.trim().length > 0);
      return { ...state, refused: true };
    },
  });
}

async function sprintLifecycle(environment) {
  const { context, group } = environment;
  const name = `${group.name} sprint`;
  const list = () => nativePages((path) => projectAgileRead(context.session, path),
    `/rest/agile/1.0/board/${group.board.id}/sprint`, "values");
  assert.equal((await list()).some((sprint) => sprint.name === name), false);
  group.sprint = await step(environment, {
    name: "sprint-create", operation: "jira.sprint-create", reviewText: [name, group.board.id],
    prompt: `Select Scrum board ${group.board.id} by reading its actual configuration, then create exactly one future sprint named "${name}" on it. Do not start it yet and do not retry creation.`,
    wire: { method: "POST", path: "/rest/agile/1.0/sprint", admit: (body) => body?.name === name && String(body.originBoardId) === group.board.id },
    verify: async (turn) => {
      const result = completedOperation(turn, "jira.sprint-create");
      const matches = (await list()).filter((sprint) => sprint.name === name);
      assert.equal(matches.length, 1);
      assert.equal(String(matches[0].id), result.sprintId);
      assert.equal(matches[0].state, "future");
      return { id: result.sprintId, name };
    },
  });
  await constraint(environment, "future-cannot-close", "closed", "future");
  await step(environment, {
    name: "sprint-membership", operation: "jira.sprint-move-issues", reviewText: [group.task.key],
    prompt: `Move only Task ${group.task.key} into future sprint ${group.sprint.id}. Preserve its Epic relation and verify the actual sprint membership. Do not move any other issue.`,
    wire: { method: "POST", path: `/rest/agile/1.0/sprint/${group.sprint.id}/issue`, admit: (body) => JSON.stringify(body?.issues) === JSON.stringify([group.task.key]) },
    verify: async (turn) => {
      completedOperation(turn, "jira.sprint-move-issues");
      const members = await sprintMembership(environment);
      epicRelation(await issueRead(context, group.task.key), group.epic, await projectAgileRead(context.session, "/rest/api/2/field"));
      return { members };
    },
  });
  const startDate = new Date().toISOString();
  const endDate = new Date(Date.now() + 7 * 86400000).toISOString();
  for (const state of ["active", "closed"]) {
    await step(environment, {
      name: state === "active" ? "sprint-start" : "sprint-complete", operation: "jira.sprint-update",
      reviewText: [group.sprint.id],
      prompt: state === "active"
        ? `Start sprint ${group.sprint.id}; set startDate ${startDate} and endDate ${endDate}. Read its current state and preserve its name, board and members. Change it once to active.`
        : `Complete the active sprint ${group.sprint.id} by changing its native state once to closed. Preserve the board; report the actual stored completion state. Do not create a new sprint or retry.`,
      wire: { method: "POST", path: `/rest/agile/1.0/sprint/${group.sprint.id}`, admit: (body) => body?.state === state },
      verify: async (turn) => {
        completedOperation(turn, "jira.sprint-update");
        return { ...await sprintRead(environment, state), members: await sprintMembership(environment) };
      },
    });
  }
  await constraint(environment, "closed-cannot-restart", "active", "closed");
}

export async function runProjectAgileJourney(context, group, inputs, witness, persist) {
  const denied = await openWorkflowBrowser(context, { label: "Denied project actor", tokenFile: inputs.deniedToken, administration: true });
  try {
    await createProject({ ...denied, context, group, witness, persist }, inputs.deniedActor, true);
  } finally { await denied.browser.close(); }
  const permitted = await openWorkflowBrowser(context, { label: "Permitted project actor", tokenFile: inputs.permittedToken, administration: true });
  const environment = { ...permitted, context, group, witness, persist };
  try {
    group.project = await createProject(environment, inputs.permittedActor, false);
    group.epic = await createIssue(environment, "Epic", `${group.name} requirement`);
    group.task = await createIssue(environment, "Task", `${group.name} implementation`, group.epic);
    group.board = await createBoard(environment);
    await sprintLifecycle(environment);
    const history = await workflowHistory(context, permitted.chat.id);
    const wire = witness.snapshot();
    await permitted.page.reload();
    await visibleReceipt(environment, group.project.key);
    await visibleReceipt(environment, group.epic.key);
    await visibleReceipt(environment, group.task.key);
    await visibleLink(environment, group.project.key, `/projects/${group.project.key}/summary`);
    await visibleLink(environment, group.epic.key, `/browse/${group.epic.key}`);
    await visibleLink(environment, group.task.key, `/browse/${group.task.key}`);
    await visibleBoardLink(environment, group.board.id);
    assert.deepEqual(await workflowHistory(context, permitted.chat.id), history);
    assert.deepEqual(witness.snapshot(), wire, "Reload must not replay any write");
    await sprintRead(environment, "closed");
    await sprintMembership(environment);
    await permitted.region.screenshot({ path: join(context.session.directory, `project-agile-${group.id}.png`) });
    group.reloadObserved = true;
    persist();
  } finally { await permitted.browser.close(); }
}
