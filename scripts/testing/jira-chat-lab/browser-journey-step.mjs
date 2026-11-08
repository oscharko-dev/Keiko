import assert from "node:assert/strict";
import { labSessionConnection } from "./lab-client.mjs";
import {
  JourneyStepFailure,
  observedEffects,
  oneObservedEffect,
  projectAgileRead,
  requireJourneyCondition,
} from "./project-agile-oracles.mjs";

export { JourneyStepFailure } from "./project-agile-oracles.mjs";

const OUTCOMES = new Set(["succeeded", "succeeded-unconfirmed", "rejected", "unknown"]);
const RESULT_CARDS =
  'section[aria-label]:has(> strong):has(> output), [role="group"][aria-label]:has(> strong):has(> output)';

function operationsOf(definition) {
  const supplied = definition.operations ?? [definition.operation];
  requireJourneyCondition(
    Array.isArray(supplied) || supplied instanceof Set,
    "definition-invalid",
    "turn",
  );
  const operations = [...new Set(supplied)];
  requireJourneyCondition(
    operations.length > 0 &&
      operations.every(
        (operation) =>
          typeof operation === "string" && /^jira\.[a-z0-9]+(?:[._-][a-z0-9]+)*$/u.test(operation),
      ),
    "definition-invalid",
    "turn",
  );
  return operations;
}

export async function visibleReceipt(environment, text) {
  const cards = environment.region.getByRole("region", { name: "Jira action", exact: true });
  await cards.filter({ hasText: text }).last().waitFor();
  assert.equal(await cards.locator("pre").count(), 0);
}

export async function visibleLink(environment, key, path) {
  const link = environment.region.getByRole("link").filter({ hasText: key }).first();
  await link.waitFor();
  assert.equal(
    await link.getAttribute("href"),
    `${labSessionConnection(environment.context.session).httpsOrigin}${path}`,
  );
}

export async function issueRead(context, key, read = projectAgileRead) {
  return read(context.session, `/rest/api/2/issue/${encodeURIComponent(key)}?fields=*all`);
}

function observedOutcome(exchange, options) {
  const result = exchange.result;
  const outcome = result?.data?.outcome;
  if (options.readOnly === true && outcome === undefined) {
    requireJourneyCondition(result?.status === "completed", "operation-outcome-unexpected", "turn");
    return "succeeded";
  }
  requireJourneyCondition(OUTCOMES.has(outcome), "operation-outcome-missing", "turn");
  if (options.denied === true) {
    const permission = result.data.reason ?? result.data.failureReason;
    requireJourneyCondition(
      outcome === "rejected" && permission === "permission-denied",
      "permission-refusal-missing",
      "turn",
    );
    return outcome;
  }
  return positiveOutcome(result, options, outcome);
}

function positiveOutcome(result, options, outcome) {
  const allowed = options.outcomes ?? ["succeeded", "succeeded-unconfirmed"];
  requireJourneyCondition(allowed.includes(outcome), "operation-outcome-unexpected", "turn");
  if (outcome === "succeeded")
    requireJourneyCondition(result.status === "completed", "operation-outcome-unexpected", "turn");
  return outcome;
}

/** Independent readback cannot upgrade an acknowledged but unconfirmed native effect. */
export function stepOutcome(turn, options) {
  const operations = operationsOf(options);
  const aliases = new Set(operations.map((operation) => operation.replaceAll(/[.-]/gu, "_")));
  const exchanges = turn.exchanges.filter((exchange) => aliases.has(exchange.call.name));
  requireJourneyCondition(exchanges.length > 0, "operation-outcome-missing", "turn");
  const outcomes = exchanges.map((exchange) => observedOutcome(exchange, options));
  if (options.denied === true) return { status: "denied", outcomes };
  const uncertain = outcomes.some(
    (outcome) => outcome === "succeeded-unconfirmed" || outcome === "unknown",
  );
  return { status: uncertain ? "unverified" : "verified", outcomes };
}

async function cardFindings(card) {
  if (!(await card.isVisible())) return { cards: 0, generic: 0, unavailable: 0, raw: 0 };
  const text = await card.innerText();
  const heading = card.locator(":scope > strong");
  const title = (await heading.isVisible()) ? await heading.innerText() : "";
  const generic = title.trim() === "Jira action" ? 1 : 0;
  const unavailable = [...text.matchAll(/\breadable\s+view\b[^.\n]*\bunavailable\b/giu)].length;
  return { cards: 1, generic, unavailable, raw: await card.locator("pre:visible").count() };
}

async function inspectPresentation(environment, { allowNoCard = false } = {}) {
  try {
    const cards = environment.region.locator(RESULT_CARDS);
    const found = { cards: 0, generic: 0, unavailable: 0, raw: 0 };
    for (let index = 0, count = await cards.count(); index < count; index += 1) {
      const item = await cardFindings(cards.nth(index));
      for (const key of Object.keys(found)) found[key] += item[key];
    }
    const count = found.generic + found.unavailable + found.raw;
    return { ...found, presentationFindings: found.cards === 0 && !allowNoCard ? 1 : count };
  } catch {
    throw new JourneyStepFailure("readable-summary-missing", "presentation", 1);
  }
}

/** Read visible result content only; the normal Jira-action aria-label is never a finding. */
export async function readableResultFindings(environment, options) {
  return (await inspectPresentation(environment, options)).presentationFindings;
}

export async function readableSummary(environment, options) {
  const found = await inspectPresentation(environment, options);
  let code = "readable-summary-missing";
  if (found.raw > 0) code = "raw-result-visible";
  if (found.generic > 0) code = "jira-action-generic";
  if (found.unavailable > 0) code = "readable-view-unavailable";
  requireJourneyCondition(
    found.presentationFindings === 0,
    code,
    "presentation",
    found.presentationFindings,
  );
  return { presentationFindings: 0 };
}

function beforeDecision(state, exchange) {
  const approval = exchange?.approval;
  requireJourneyCondition(
    state.operations.includes(approval?.operation),
    "operation-not-allowed",
    "approval",
  );
  requireJourneyCondition(
    exchange.call?.name === approval.operation.replaceAll(/[.-]/gu, "_"),
    "operation-not-allowed",
    "approval",
  );
  const limit = state.specification.length;
  const wire = state.witness.snapshot();
  requireJourneyCondition(
    wire.blocked === 0 &&
      wire.forwarded === state.decisions.size &&
      state.decisions.size < limit &&
      earlierWritesObserved(state, wire),
    "approval-order-mismatch",
    "approval",
  );
  requireJourneyCondition(
    approval.state === "pending" &&
      typeof approval.approvalId === "string" &&
      !state.decisions.has(approval.approvalId),
    "approval-order-mismatch",
    "approval",
  );
  state.decisions.add(approval.approvalId);
}

function earlierWritesObserved(state, wire) {
  try {
    observedEffects(wire, state.specification.slice(0, state.decisions.size));
    return true;
  } catch {
    return false;
  }
}

function turnOptions(state) {
  const { definition } = state;
  const { persist, witness } = state;
  return {
    operations: state.strict ? state.operations : [definition.operation],
    reviewText: definition.reviewText ?? [],
    allowFailure: definition.denied === true || state.strict,
    persist: (value) => {
      Object.assign(state.group.current, value);
      persist();
    },
    beforeDecision: state.strict
      ? (exchange) => beforeDecision(state, exchange)
      : () => assert.equal(witness.snapshot().forwarded, 0),
  };
}

function sendTurn(state) {
  const { environment, definition } = state;
  const args = [
    environment.page,
    environment.region,
    state.context,
    environment.chat.id,
    definition.prompt,
    turnOptions(state),
  ];
  if (environment.sendTurn !== undefined) return environment.sendTurn(...args);
  return import("./browser-workflow-turn.mjs").then(({ sendBrowserTurn }) =>
    sendBrowserTurn(...args),
  );
}

function stepWire(state, turn) {
  const wire = state.witness.snapshot();
  observedEffects(wire, state.specification);
  requireJourneyCondition(
    turn.decisions === wire.forwarded && turn.decisions === state.decisions.size,
    "approval-count-mismatch",
    "approval",
  );
  return wire;
}

async function finishStep(state, turn, wire) {
  const checkedStages = ["turn", "wire", "approval"];
  const outcome = stepOutcome(turn, {
    operations: state.operations,
    denied: state.definition.denied,
    readOnly: state.specification.length === 0,
  });
  if (state.definition.requireReadableSummary === true || state.definition.readable === true) {
    state.stage = "presentation";
    await readableSummary(state.environment, { allowNoCard: state.specification.length === 0 });
    checkedStages.push("presentation");
  }
  state.stage = "readback";
  const proof = await state.definition.verify(turn);
  if (outcome?.status === "unverified")
    requireJourneyCondition(
      proof?.status === "unverified",
      "unconfirmed-outcome-promoted",
      "readback",
    );
  checkedStages.push("readback");
  state.group.results.push({
    name: state.name,
    clientTurnId: turn.clientTurnId,
    userId: turn.user.id,
    approvals: turn.decisions,
    wire,
    proof,
    presentationFindings: 0,
    checkedStages,
  });
  state.group.current.phase = "independently-observed";
  const { persist } = state;
  persist();
  return proof;
}

function prepareStep(environment, groupOrDefinition, suppliedDefinition) {
  const definition = suppliedDefinition ?? groupOrDefinition;
  const { context, group: defaultGroup, witness, persist } = environment;
  const group = suppliedDefinition === undefined ? defaultGroup : groupOrDefinition;
  group.current = { name: definition.name, phase: "prepared", chatId: environment.chat.id };
  const specification = definition.wire;
  witness.arm(specification);
  const strict = Array.isArray(specification);
  if (strict) group.current.name ??= definition.id;
  persist();
  return {
    environment,
    definition,
    context,
    group,
    witness,
    persist,
    specification,
    strict,
    stage: "turn",
    decisions: new Set(),
    name: group.current.name,
  };
}

function noUnexpectedEffect(snapshot) {
  assert.equal(snapshot.blocked, 0, "A blocked extra dispatch is a failed qualification");
  assert.ok(snapshot.forwarded <= 1);
  assert.ok(snapshot.statuses.every((status) => status === 400 || status === 403));
}

function legacyWire(state, turn) {
  const { definition, witness } = state;
  const wire = witness.snapshot();
  if (definition.denied) noUnexpectedEffect(wire);
  else oneObservedEffect(wire);
  assert.equal(
    turn.decisions,
    wire.forwarded,
    "Every forwarded write requires exactly its visible approval; preflight refusals require none",
  );
  return wire;
}

function recordLegacyResult(state, turn, wire, proof) {
  const { definition, group, persist } = state;
  group.results.push({
    name: definition.name,
    clientTurnId: turn.clientTurnId,
    userId: turn.user.id,
    approvals: turn.decisions,
    wire,
    proof,
  });
  group.current.phase = "independently-observed";
  persist();
  return proof;
}

/** Existing two-argument Journey calls and the explicit Roles group share one bounded turn owner. */
export async function step(environment, groupOrDefinition, suppliedDefinition) {
  let state;
  try {
    state = prepareStep(environment, groupOrDefinition, suppliedDefinition);
    if (state.strict) {
      state.operations = operationsOf(state.definition);
      requireJourneyCondition(
        typeof state.name === "string" && typeof state.definition.verify === "function",
        "definition-invalid",
        "turn",
      );
    }
    const turn = await sendTurn(state);
    if (!state.strict) {
      const wire = legacyWire(state, turn);
      const proof = await state.definition.verify(turn);
      return recordLegacyResult(state, turn, wire, proof);
    }
    state.stage = "wire";
    const wire = stepWire(state, turn);
    return await finishStep(state, turn, wire);
  } catch (error) {
    if (state?.strict !== true) throw error;
    if (error instanceof JourneyStepFailure) throw error;
    const code = state.stage === "readback" ? "readback-failed" : "turn-failed";
    throw new JourneyStepFailure(code, state.stage);
  }
}
