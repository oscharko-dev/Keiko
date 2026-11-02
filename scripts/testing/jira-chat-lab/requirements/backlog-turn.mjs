// S17 of epic #4173 (#4175): a long backlog request completes, an unchanged runtime-catalog refresh
// does not refuse the admitted turn, and a turn that ends early reports exactly the issue keys Jira
// shows as created. The journey has three independently graded parts; a part whose evidence is
// absent is `unverified` and covers nothing, so the scenario stays partial instead of green.
//
//  - backlog:  every "Muss" requirement became one epic, the answer lists every created key, and no
//              generation-changed refusal was logged (the original S17 contract).
//  - refresh:  while that turn ran, the lab triggered the same readiness run that bumped the gateway
//              generation on 2026-10-31 (`POST /api/gateway/readiness`); the run finished before the
//              turn settled, and the turn was neither refused nor failed.
//  - interrupt: a second turn creates the "Soll" epics; once its first write completed the lab
//              changes the Chat's mode, which ends the admitted turn early. The product's own
//              early-ending answer must list exactly the keys Jira shows as created.
import { aggregateParts, countsOf, snapshotBefore } from "./journey-support.mjs";
import { buildCorpus } from "./corpus.mjs";
import { gradeBacklog, turnIssues } from "./oracles.mjs";

const EPIC_QUERY = "project = REQ AND issuetype = Epic";
const ISSUE_KEY = /\bREQ-\d+\b/g;
const BACKLOG_COVERS = [
  "epic-per-must-requirement",
  "answer-lists-created-keys",
  "no-generation-refusal",
];
/** The readiness run of the Settings page: the lab's real trigger of a catalog refresh. */
const REFRESH = { name: "catalog-refresh", path: "/api/gateway/readiness" };

const requirementsOf = (priority) =>
  buildCorpus(1)
    .truth.filter((item) => item.priority === priority)
    .map((item) => item.id);

/**
 * Grades the unchanged-catalog-refresh part. `induced` is what the lab recorded about its mid-turn
 * action: `ok`, and `turnOpen` (the turn had not settled when the refresh finished).
 */
export function gradeCatalogRefresh({ induced, refused, failure }) {
  const covers = ["survives-unchanged-catalog-refresh"];
  if (induced === undefined) {
    return {
      status: "unverified",
      covers,
      detail: "no catalog refresh was induced during the turn",
    };
  }
  if (!induced.ok) {
    return { status: "unverified", covers, detail: `the refresh request failed: ${induced.error}` };
  }
  if (!induced.turnOpen) {
    return {
      status: "unverified",
      covers,
      detail: "the turn had settled before the refresh finished",
    };
  }
  if (refused || failure !== undefined) {
    return { status: "red", covers, detail: "the admitted turn did not survive the refresh" };
  }
  return { status: "green", covers, detail: "the refresh finished mid-turn, the turn completed" };
}

/**
 * Grades the interruption part: the product's early-ending answer names exactly the epics Jira shows
 * as created in the turn. `ended` says the Activity Log recorded an early ending for this turn;
 * `created` are the epics Jira holds that the turn produced.
 */
export function gradeInterruption({ induced, ended, created, answer }) {
  const covers = ["interrupted-turn-reports-created-keys"];
  if (induced === undefined || !induced.ok || !induced.turnOpen) {
    return {
      status: "unverified",
      covers,
      detail: "the Chat's authority was not changed mid-turn",
    };
  }
  if (!ended) {
    return { status: "unverified", covers, detail: "the turn did not end early" };
  }
  if (created.length === 0) {
    return { status: "unverified", covers, detail: "the interrupted turn had written nothing yet" };
  }
  const createdKeys = new Set(created.map((issue) => issue.key));
  const named = new Set(answer.match(ISSUE_KEY));
  const missing = [...createdKeys].filter((key) => !named.has(key));
  const invented = [...named].filter((key) => !createdKeys.has(key));
  const exact = missing.length === 0 && invented.length === 0;
  return {
    status: exact ? "green" : "red",
    covers,
    detail: `${createdKeys.size} epics created, ${missing.length} missing from and ${invented.length} not created but named in the early-ending answer`,
  };
}

/** The mid-turn action of the refresh part: the Settings readiness run for the Chat's model. */
const refreshDuring = (ctx) => ({
  when: "first-exchange",
  run: () => ctx.http(REFRESH.name, REFRESH.path, { modelId: ctx.modelId }),
});

/** The mid-turn action of the interruption part: the Chat's mode changes while the turn runs. */
const modeChangeDuring = (ctx, chat) => ({
  when: "first-write",
  run: () =>
    ctx.http(
      "mode-change",
      `/api/chats?id=${encodeURIComponent(chat.id)}`,
      { toolMode: "governed-assist", expectedGroundingScopeIdentity: chat.groundingScopeIdentity },
      "PATCH",
    ),
});

async function backlogPart(ctx, chat) {
  const before = await snapshotBefore(ctx, EPIC_QUERY);
  const requested = requirementsOf("Muss");
  const refusalsBefore = ctx.refusals();
  const turn = await ctx.turn(
    chat,
    "Lege im Jira-Projekt REQ für ALLE Anforderungen mit Priorität Muss aus dem Lastenheft je ein Epic nach der Strukturvorgabe an. Melde am Ende alle angelegten Schlüssel.",
    ctx.http === undefined ? undefined : { during: refreshDuring(ctx) },
  );
  const epics = turnIssues({
    before,
    issues: await ctx.search(EPIC_QUERY, "summary,labels"),
    exchanges: turn.toolExchanges,
  });
  // Only this turn's refusals count; earlier journeys share the same live log.
  const refused = ctx.refusals() > refusalsBefore;
  const grade = gradeBacklog({ requested, created: epics.credited, answer: turn.answer });
  const ok =
    !turn.failure && grade.mappingOk && grade.namesOk && !refused && epics.duplicates.length === 0;
  const detail = `${grade.mapped}/${requested.length} requirements mapped to one epic each, ${countsOf(epics, "epics")}, ${grade.stray} unmapped, ${grade.unnamed} reported keys missing from the answer${refused ? ", generation-changed refusal logged" : ""}`;
  const refresh = gradeCatalogRefresh({ induced: turn.induced, refused, failure: turn.failure });
  return {
    turn,
    parts: [
      { label: "backlog", status: ok ? "green" : "red", covers: BACKLOG_COVERS, detail },
      { label: "refresh", ...refresh },
    ],
  };
}

async function interruptionPart(ctx) {
  if (ctx.freshChat === undefined || ctx.turnEnds === undefined) {
    return { parts: [] };
  }
  const chat = await ctx.freshChat("autonomous-delivery");
  const before = await snapshotBefore(ctx, EPIC_QUERY);
  const endsBefore = ctx.turnEnds();
  const turn = await ctx.turn(
    chat,
    "Lege im Jira-Projekt REQ für ALLE Anforderungen mit Priorität Soll aus dem Lastenheft je ein Epic nach der Strukturvorgabe an. Melde am Ende alle angelegten Schlüssel.",
    { during: modeChangeDuring(ctx, chat) },
  );
  const epics = turnIssues({
    before,
    issues: await ctx.search(EPIC_QUERY, "summary,labels"),
    exchanges: turn.toolExchanges,
  });
  const grade = gradeInterruption({
    induced: turn.induced,
    ended: ctx.turnEnds() > endsBefore,
    created: epics.credited,
    answer: turn.answer,
  });
  return { turn, parts: [{ label: "interruption", ...grade }] };
}

export async function backlogJourney(ctx, chat) {
  const backlog = await backlogPart(ctx, chat);
  const interruption =
    backlog.turn.failure === undefined ? await interruptionPart(ctx) : { parts: [] };
  const turns = [backlog.turn, ...(interruption.turn === undefined ? [] : [interruption.turn])];
  return aggregateParts([...backlog.parts, ...interruption.parts], turns);
}
