import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { openLimitStep } from "./limit-run-step.mjs";
import {
  projectAgileRead,
  nativePageObservation,
  exactSprintBulkIssues,
  sprintBulkTurn,
  sprintBulkLiveMembership,
  sprintBulkClosedIssues,
  observedEffects,
  sprintBulkEligibleTasks,
  sprintBulkInboundTasks,
} from "./project-agile-oracles.mjs";
import { runtimeTemplateProjectKey } from "./requirements/templates.mjs";

const STEP = "ac6-sprint-bulk";
const DONE_COUNT = 5;
const DAY_MS = 86_400_000;
class NativeProofUnavailable extends Error {}

const id = (value) => {
  const text = String(value);
  assert.match(text, /^[1-9][0-9]{0,19}$/u);
  return text;
};
const sameKeys = (actual, expected) => assert.deepEqual([...actual].sort(), [...expected].sort());
const ownKeys = (value, keys) => sameKeys(Object.keys(value), keys);

function validateOptions({ size, batch }) {
  assert.ok(Number.isInteger(size) && size >= 200 && size <= 300);
  assert.equal(batch, 50);
  return { size, batch };
}

function initialCounts(size, batch) {
  return {
    size,
    batch,
    created: 0,
    selected: 0,
    moved: 0,
    done: 0,
    createBatches: 0,
    moveBatches: 0,
    decisions: 0,
    constraintRefusals: 0,
    membershipPages: 0,
    backlogPages: 0,
    unconfirmedReceipts: 0,
  };
}

async function save(run, phase) {
  await run.journal.checkpoint({
    ...(phase === undefined ? {} : { phase }),
    resources: run.resources,
    counts: run.counts,
  });
}

async function submit(
  run,
  operation,
  prompt,
  admit,
  { count = 1, denied = false, identity = () => "one", wire } = {},
) {
  run.ctx.signal.throwIfAborted();
  const approved = new Set();
  if (run.ctx.witness !== undefined) {
    assert.ok(Array.isArray(wire));
    run.ctx.witness.arm(wire);
  }
  const turn = await run.ctx.turn(run.ctx.chat, prompt, {
    operations: [operation],
    allowFailure: true,
    timeoutMs: 1_800_000,
    beforeDecision: (exchange) => {
      assert.equal(denied, false, "A known state constraint must refuse before approval");
      assert.equal(exchange.call.name, operation.replaceAll(/[.-]/gu, "_"));
      assert.equal(admit(exchange.call.arguments), true);
      if (run.ctx.witness !== undefined)
        assert.equal(run.ctx.witness.snapshot().forwarded, approved.size);
      const selected = identity(exchange.call.arguments);
      assert.equal(approved.has(selected), false, "No repeated approval for a selected mutation");
      assert.ok(approved.size < count);
      approved.add(selected);
    },
  });
  const receipts = sprintBulkTurn(turn, {
    operation,
    count,
    admit,
    denied,
    requireApprovals: run.ctx.requireApprovals === true,
  });
  if (run.ctx.witness !== undefined) {
    const snapshot = run.ctx.witness.snapshot();
    observedEffects(snapshot, wire);
    assert.ok(turn.decisions === 0 || turn.decisions === snapshot.forwarded);
    run.counts.wireWrites += snapshot.forwarded;
  }
  run.counts.decisions += turn.decisions;
  if (!denied)
    run.counts.unconfirmedReceipts += receipts.filter(
      (receipt) => receipt.outcome !== "succeeded",
    ).length;
  return { receipts, turn };
}

function searchPath(key, fields, type = "Task") {
  return `/rest/api/2/search?jql=${encodeURIComponent(`project = ${key} AND issuetype = ${type} ORDER BY id ASC`)}&fields=${fields}`;
}

async function tasks(run) {
  return (
    await nativePageObservation(
      run.read,
      searchPath(
        run.key,
        `summary,description,issuetype,project,status,${run.epicField},${run.sprintField}`,
      ),
      "issues",
    )
  ).values;
}

function selectedTasks(run, observed) {
  const selected = new Set(run.resources.taskRefs.map((item) => item.key));
  const found = observed.filter((issue) => selected.has(issue.key));
  exactSprintBulkIssues(found, run.resources.taskRefs);
  for (const issue of found) assert.ok(run.epicKeys.has(issue.fields[run.epicField]));
  return found;
}

async function nativeSetup(run) {
  const project = await run.read(`/rest/api/2/project/${run.key}`);
  assert.equal(project.key, run.key);
  const type = project.issueTypes.filter((item) => item.name === "Task" && item.subtask === false);
  assert.equal(type.length, 1);
  run.projectId = id(project.id);
  run.taskTypeId = id(type[0].id);
  const fields = await run.read("/rest/api/2/field");
  for (const [property, suffix] of [
    ["epicField", "gh-epic-link"],
    ["sprintField", "gh-sprint"],
  ]) {
    const found = fields.filter(
      (field) => field.schema?.custom === `com.pyxis.greenhopper.jira:${suffix}`,
    );
    assert.equal(found.length, 1);
    assert.match(found[0].id, /^customfield_[1-9][0-9]*$/u);
    run[property] = found[0].id;
  }
  const epics = (
    await nativePageObservation(
      run.read,
      searchPath(run.key, "project,issuetype", "Epic"),
      "issues",
    )
  ).values;
  run.epicKeys = new Set(
    epics.map((epic) => {
      assert.equal(epic.fields.project.key, run.key);
      assert.equal(id(epic.fields.project.id), run.projectId);
      assert.equal(epic.fields.issuetype.name, "Epic");
      assert.match(epic.key, new RegExp(`^${run.key}-[1-9][0-9]*$`, "u"));
      return epic.key;
    }),
  );
  await nativeBoard(run);
}

async function nativeBoard(run) {
  const boards = (
    await nativePageObservation(
      run.read,
      `/rest/agile/1.0/board?projectKeyOrId=${run.key}&type=scrum`,
      "values",
    )
  ).values;
  const boundBoard = run.resources.boardId;
  if (boundBoard === undefined)
    assert.equal(boards.length, 1, "An unbound project must have exactly one Scrum board");
  const board =
    boundBoard === undefined ? boards[0] : boards.find((item) => id(item.id) === id(boundBoard));
  assert.ok(board !== undefined && board.type === "scrum");
  run.resources.boardId = id(board.id);
  const associated = (
    await nativePageObservation(
      run.read,
      `/rest/agile/1.0/board/${run.resources.boardId}/project`,
      "values",
    )
  ).values;
  assert.equal(
    associated.filter((item) => item.key === run.key && id(item.id) === run.projectId).length,
    1,
  );
  run.config = await run.read(`/rest/agile/1.0/board/${run.resources.boardId}/configuration`);
  assert.equal(run.config.type, "scrum");
  assert.equal(id(run.config.id), run.resources.boardId);
  run.doneStatuses = new Set(
    run.config.columnConfig.columns.at(-1).statuses.map((status) => id(status.id)),
  );
  assert.ok(run.doneStatuses.size > 0);
}

function selectionScope(run) {
  return {
    projectKey: run.key,
    projectId: run.projectId,
    taskTypeId: run.taskTypeId,
    sprintFieldId: run.sprintField,
    epicFieldId: run.epicField,
    epicKeys: run.epicKeys,
    doneStatuses: run.doneStatuses,
  };
}

async function bindExistingTasks(run) {
  const observed = await tasks(run);
  const bound = run.resources.taskRefs.length > 0;
  const candidates = bound ? selectedTasks(run, observed) : observed;
  const eligible = await sprintBulkEligibleTasks(run.read, candidates, selectionScope(run));
  if (eligible.length < run.counts.size) throw new NativeProofUnavailable();
  const selected = bound ? eligible : eligible.slice(0, run.counts.size);
  if (bound) exactSprintBulkIssues(selected, run.resources.taskRefs);
  else run.resources.taskRefs = selected.map((issue) => ({ id: id(issue.id), key: issue.key }));
  assert.equal(run.resources.taskRefs.length, run.counts.size);
  run.counts.selected = run.resources.taskRefs.length;
  await save(run);
}

async function reverifyUnmovedTasks(run) {
  const selected = selectedTasks(run, await tasks(run));
  const eligible = await sprintBulkEligibleTasks(run.read, selected, selectionScope(run));
  exactSprintBulkIssues(eligible, run.resources.taskRefs);
}

async function sprint(run, state) {
  const observed = await run.read(`/rest/agile/1.0/sprint/${run.resources.sprintId}`);
  assert.equal(id(observed.id), run.resources.sprintId);
  assert.equal(id(observed.originBoardId), run.resources.boardId);
  assert.equal(observed.name, run.sprintName);
  assert.equal(observed.state, state);
  if (state !== "future") {
    assert.ok(Number.isFinite(Date.parse(observed.startDate)));
    assert.ok(Date.parse(observed.endDate) > Date.parse(observed.startDate));
  }
  if (state === "closed") assert.ok(Number.isFinite(Date.parse(observed.completeDate)));
  return observed;
}

async function createSprint(run) {
  const path = `/rest/agile/1.0/board/${run.resources.boardId}/sprint`;
  const before = (await nativePageObservation(run.read, path, "values")).values;
  assert.equal(
    before.some((entry) => entry.state === "active" || entry.name === run.sprintName),
    false,
  );
  const { receipts } = await submit(
    run,
    "jira.sprint-create",
    `Create exactly one future sprint on Scrum board ${run.resources.boardId}, name ${JSON.stringify(run.sprintName)}. No dates, no other writes or retry.`,
    (args) => {
      ownKeys(args, ["name", "originBoardId"]);
      return args.name === run.sprintName && args.originBoardId === run.resources.boardId;
    },
    {
      wire: [
        {
          method: "POST",
          path: "/rest/agile/1.0/sprint",
          status: 201,
          admit: (body) => {
            ownKeys(body, ["name", "originBoardId"]);
            return body.name === run.sprintName && id(body.originBoardId) === run.resources.boardId;
          },
        },
      ],
    },
  );
  const after = (await nativePageObservation(run.read, path, "values")).values;
  const added = after.filter((entry) => !before.some((old) => id(old.id) === id(entry.id)));
  assert.equal(added.length, 1);
  run.resources.sprintId = id(added[0].id);
  assert.equal(receipts[0].sprintId, run.resources.sprintId);
  await sprint(run, "future");
  await save(run);
}

async function constraint(run, from, target) {
  const before = await sprint(run, from);
  const beforeTasks = await tasks(run);
  await membership(run, run.resources.taskRefs, true);
  await submit(
    run,
    "jira.sprint-update",
    `Attempt exactly once to change sprint ${run.resources.sprintId} directly from ${from} to ${target}. Report the native state constraint refusal; do not use an intermediate state, approval, other write or retry.`,
    (args) => {
      ownKeys(args, ["sprintId", "state"]);
      return args.sprintId === run.resources.sprintId && args.state === target;
    },
    { denied: true, wire: [] },
  );
  assert.deepEqual(await sprint(run, from), before);
  assert.deepEqual(await tasks(run), beforeTasks);
  await membership(run, run.resources.taskRefs, true);
  run.counts.constraintRefusals += 1;
  await save(run);
}

async function membership(run, expected, full = false) {
  const proof = await nativePageObservation(
    run.read,
    `/rest/agile/1.0/sprint/${run.resources.sprintId}/issue`,
    "issues",
  );
  exactSprintBulkIssues(proof.values, expected);
  if (full)
    assert.ok(proof.pages >= 4, "The actual membership must span more than three native pages");
  run.counts.membershipPages = proof.pages;
  return proof.values;
}

async function moveTasks(run) {
  for (let offset = 0; offset < run.resources.taskRefs.length; offset += run.counts.batch) {
    const batch = run.resources.taskRefs.slice(offset, offset + run.counts.batch);
    const keys = batch.map((item) => item.key);
    const all = await tasks(run);
    const selected = all.filter((issue) => keys.includes(issue.key));
    const eligible = await sprintBulkEligibleTasks(run.read, selected, selectionScope(run));
    exactSprintBulkIssues(eligible, batch);
    const { receipts } = await submit(
      run,
      "jira.sprint-move-issues",
      `Move exactly these Tasks to future sprint ${run.resources.sprintId} in one bounded action: ${keys.join(", ")}. No other membership or field change, no retry.`,
      (args) => {
        ownKeys(args, ["sprintId", "issues"]);
        assert.equal(args.sprintId, run.resources.sprintId);
        sameKeys(args.issues, keys);
        return true;
      },
      {
        wire: [
          {
            method: "POST",
            path: `/rest/agile/1.0/sprint/${run.resources.sprintId}/issue`,
            status: 204,
            admit: (body) => {
              ownKeys(body, ["issues"]);
              sameKeys(body.issues, keys);
              return true;
            },
          },
        ],
      },
    );
    sameKeys(receipts[0].issueKeys, keys);
    await membership(run, run.resources.taskRefs.slice(0, offset + batch.length));
    run.counts.moved += batch.length;
    run.counts.moveBatches += 1;
    await save(run);
  }
  await membership(run, run.resources.taskRefs, true);
  await sprintBulkLiveMembership(
    run.read,
    selectedTasks(run, await tasks(run)),
    run.sprintField,
    run.resources.sprintId,
  );
}

async function updateSprint(run, state) {
  const args = { sprintId: run.resources.sprintId, state };
  if (state === "active") {
    args.startDate = new Date().toISOString();
    args.endDate = new Date(Date.now() + 7 * DAY_MS).toISOString();
  }
  const { receipts } = await submit(
    run,
    "jira.sprint-update",
    state === "active"
      ? `Start only future sprint ${run.resources.sprintId} once, starting ${args.startDate} and ending ${args.endDate}. Preserve its name, board, goal and membership; no other write or retry.`
      : `Complete only active sprint ${run.resources.sprintId} once. Keep unfinished Tasks in the backlog and completed Tasks Done. Preserve its name, board and goal; no other write or retry.`,
    (actual) => {
      assert.deepEqual(actual, args);
      return true;
    },
    {
      wire: [
        {
          method: "POST",
          path: `/rest/agile/1.0/sprint/${run.resources.sprintId}`,
          status: 200,
          admit: (body) => {
            const { sprintId: _sprintId, ...changes } = args;
            assert.deepEqual(body, changes);
            return true;
          },
        },
      ],
    },
  );
  assert.equal(receipts[0].sprintId, run.resources.sprintId);
  await sprint(run, state);
}

async function doneTransitionPlans(run) {
  const plans = [];
  for (const task of run.resources.taskRefs.slice(0, DONE_COUNT)) {
    const { transitions } = await run.read(`/rest/api/2/issue/${task.key}/transitions`);
    const allowed = transitions.filter(
      (entry) => entry.to?.statusCategory?.key === "done" && run.doneStatuses.has(id(entry.to.id)),
    );
    assert.ok(
      allowed.length > 0,
      "A native Done transition in the board's final column is required",
    );
    plans.push({ issueKey: task.key, transitionId: id(allowed[0].id) });
  }
  return plans;
}

async function finishSomeTasks(run) {
  const plans = await doneTransitionPlans(run);
  const { receipts } = await submit(
    run,
    "jira.transition",
    `Finish exactly these five Tasks, once each and in the listed order, in the board's final Done column: ${plans.map((plan) => plan.issueKey).join(", ")}. Discover their available transitions first; no field edits, other transitions or retry.`,
    (args) => {
      ownKeys(args, ["issueKey", "transitionId"]);
      return plans.some(
        (plan) => plan.issueKey === args.issueKey && plan.transitionId === args.transitionId,
      );
    },
    {
      count: DONE_COUNT,
      identity: (args) => args.issueKey,
      wire: plans.map((plan) => ({
        method: "POST",
        path: `/rest/api/2/issue/${plan.issueKey}/transitions`,
        status: 204,
        admit: (body) => {
          ownKeys(body, ["transition"]);
          return body.transition?.id === plan.transitionId;
        },
      })),
    },
  );
  sameKeys(
    receipts.map((receipt) => receipt.issueKey),
    plans.map((plan) => plan.issueKey),
  );
  const done = new Set(plans.map((plan) => plan.issueKey));
  for (const issue of selectedTasks(run, await tasks(run))) {
    assert.equal(issue.fields.status?.statusCategory?.key === "done", done.has(issue.key));
    if (done.has(issue.key)) assert.equal(run.doneStatuses.has(id(issue.fields.status.id)), true);
  }
  run.resources.doneKeys = [...done];
  run.counts.done = done.size;
  await membership(run, run.resources.taskRefs, true);
  await save(run);
}

async function finalNativeProof(run) {
  await sprint(run, "closed");
  await membership(run, run.resources.taskRefs, true);
  const selected = selectedTasks(run, await tasks(run));
  sprintBulkInboundTasks(selected, selectionScope(run));
  const backlog = await nativePageObservation(
    run.read,
    `/rest/agile/1.0/board/${run.resources.boardId}/backlog`,
    "issues",
  );
  run.counts.backlogPages = backlog.pages;
  sprintBulkClosedIssues(selected, run.resources.taskRefs, run.resources.doneKeys, backlog.values);
  await sprintBulkLiveMembership(run.read, selected, run.sprintField);
}

async function execute(run) {
  await bindExistingTasks(run);
  await reverifyUnmovedTasks(run);
  await save(run, "pending");
  await createSprint(run);
  await moveTasks(run);
  await constraint(run, "future", "closed");
  await updateSprint(run, "active");
  await membership(run, run.resources.taskRefs, true);
  await finishSomeTasks(run);
  await updateSprint(run, "closed");
  await finalNativeProof(run);
  await constraint(run, "closed", "active");
  completedCounts(run);
  await save(run, "completed");
}

function completedCounts(run) {
  assert.equal(run.resources.taskRefs.length, run.counts.size);
  assert.equal(run.counts.created, 0);
  assert.equal(run.counts.selected, run.counts.size);
  assert.equal(run.counts.moved, run.counts.size);
  assert.equal(run.counts.done, DONE_COUNT);
  assert.equal(run.counts.createBatches, 0);
  assert.equal(run.counts.moveBatches, Math.ceil(run.counts.size / run.counts.batch));
  assert.equal(run.counts.constraintRefusals, 2);
  const effects = run.counts.moveBatches + 8;
  assert.ok(
    Number.isSafeInteger(run.counts.decisions) &&
      run.counts.decisions >= 0 &&
      run.counts.decisions <= effects,
  );
  assert.ok(
    Number.isSafeInteger(run.counts.unconfirmedReceipts) && run.counts.unconfirmedReceipts >= 0,
  );
  if (run.ctx.requireApprovals === true) assert.equal(run.counts.decisions, effects);
  if (run.counts.wireWrites !== undefined) assert.equal(run.counts.wireWrites, effects);
}

function sprintRun(ctx, journal, key, size, batch) {
  const runIdentity = typeof ctx.intent.path === "string" ? ctx.intent.path : `${key}:${STEP}`;
  const provenanceDigest = createHash("sha256")
    .update(`${key}:${STEP}:${runIdentity}`)
    .digest("hex");
  const reverified = journal.state.phase === "completed";
  const run = {
    ctx,
    key,
    journal,
    reverified,
    resources: structuredClone(journal.state.resources),
    counts:
      journal.state.phase === "prepared" ? initialCounts(size, batch) : { ...journal.state.counts },
    sprintName: `Limit ${key} ${provenanceDigest.slice(0, 12)}`,
    read: async (path) => {
      try {
        return await projectAgileRead(ctx.session, path);
      } catch {
        throw new NativeProofUnavailable();
      }
    },
  };
  if (ctx.witness !== undefined && journal.state.phase === "prepared") run.counts.wireWrites = 0;
  assert.equal(run.resources.provenanceDigest ?? provenanceDigest, provenanceDigest);
  assert.equal(run.counts.size, size);
  assert.equal(run.counts.batch, batch);
  run.resources = {
    ...run.resources,
    provenanceDigest,
    taskRefs: run.resources.taskRefs ?? [],
    doneKeys: run.resources.doneKeys ?? [],
  };
  return run;
}

function successfulResult(run) {
  if (run.counts.unconfirmedReceipts > 0)
    return run.journal.result("unverified", "sprint-bulk-receipt-unconfirmed", run.counts);
  return run.journal.result(
    "green",
    run.reverified ? "sprint-bulk-reverified" : "sprint-bulk-confirmed",
    run.counts,
  );
}

function failedResult(run, error) {
  if (run.ctx.signal.aborted)
    return run.journal.result("unverified", "sprint-bulk-aborted", run.counts);
  const unavailable =
    error instanceof NativeProofUnavailable || run.journal.state.phase === "prepared";
  return run.journal.result(
    unavailable ? "unverified" : "red",
    unavailable ? "sprint-bulk-native-unavailable" : "sprint-bulk-verification-failed",
    run.counts,
  );
}

/** Normal Chat turns only. All qualification reads use the independent native oracle. */
export async function runSprintBulk(ctx, options) {
  const { size, batch } = validateOptions(options);
  if (ctx.requireApprovals !== undefined) assert.equal(typeof ctx.requireApprovals, "boolean");
  const key = runtimeTemplateProjectKey(ctx.projectKey);
  const journal = await openLimitStep(ctx, STEP);
  const run = sprintRun(ctx, journal, key, size, batch);
  try {
    await nativeSetup(run);
    if (journal.state.phase === "pending") {
      assert.equal(run.resources.taskRefs.length, run.counts.size);
      const selected = selectedTasks(run, await tasks(run));
      sprintBulkInboundTasks(selected, selectionScope(run));
      return journal.result("unverified", "sprint-bulk-pending", run.counts);
    }
    if (run.reverified) {
      completedCounts(run);
      await finalNativeProof(run);
    } else await execute(run);
    return successfulResult(run);
  } catch (error) {
    return failedResult(run, error);
  }
}
