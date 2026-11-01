// S18 of epic #4173 (#4178): the three Chat modes and a readable approval. A Jira write is the
// `create-issue` connector action in the `internet` resource scope; the product's own policy
// matrix (CODING_WORKBENCH_MODE_POLICIES, ADR-0129/0138) asks for approval in Ask for approval and
// in Supervised workspace and lets Full access proceed inside the validated Authority Envelope. The
// journey grades what the product does against that promise from three independent facts: the write
// approvals the supervisor met in the turn, the Jira state at the moment of the first approval, and
// the issues Jira holds afterwards.
import { aggregateParts, countsOf, sequentially, snapshotBefore } from "./journey-support.mjs";
import { turnIssues } from "./oracles.mjs";

const EPIC_QUERY = "project = REQ AND issuetype = Epic";

/**
 * The runs of the journey: the mode of the Chat, whether the product must ask a human before a
 * Jira write in that mode, the obligation it demonstrates and the requirements to create. The
 * requirements are neither "Muss" (S17 creates those) nor used by any other scenario, so a
 * reconciled epic of an earlier journey cannot stand in for a write.
 */
export const MODE_RUNS = Object.freeze([
  {
    mode: "governed-assist",
    label: "Ask for approval",
    approval: true,
    obligation: "mode-ask",
    requirements: ["LH-022", "LH-027"],
  },
  {
    mode: "supervised-coding",
    label: "Supervised workspace",
    approval: true,
    obligation: "mode-supervised",
    requirements: ["LH-032", "LH-037"],
  },
  {
    mode: "autonomous-delivery",
    label: "Full access",
    approval: false,
    obligation: "mode-full-access",
    requirements: ["LH-034", "LH-039"],
  },
]);

/**
 * Grades one mode run. `newAtApproval` are the issues Jira held at the moment of the first write
 * approval that did not exist before the turn (`undefined`: the supervisor could not observe Jira).
 *  - an approval mode is green when a write approval was pending while Jira was still unchanged;
 *    a write without any approval is red, and so are issues that already existed at the approval;
 *  - Full access is green when Jira holds new issues of the turn and no write approval was asked;
 *    epics that only reconciled onto issues of an earlier run show no write effect (`unverified`);
 *  - a run that wrote nothing and was asked for nothing proves nothing (`unverified`).
 */
export function gradeModeRun({ approval, writes, created, credited, newAtApproval }) {
  if (!approval) {
    if (writes > 0)
      return { status: "red", detail: `${writes} write approvals asked in Full access` };
    if (created > 0)
      return { status: "green", detail: `${created} issues written without a write approval` };
    return credited === 0
      ? { status: "unverified", detail: "no issue written, the mode was not exercised" }
      : {
          status: "unverified",
          detail: `${credited} epics only reconciled onto existing issues; no new write was observed`,
        };
  }
  if (writes === 0) {
    return created > 0
      ? { status: "red", detail: `${created} issues written without any write approval` }
      : {
          status: "unverified",
          detail: "no write approval asked and no issue written, the gate was not exercised",
        };
  }
  if (newAtApproval === undefined) {
    return {
      status: "unverified",
      detail: `${writes} write approvals but Jira was not observed at the approval`,
    };
  }
  return newAtApproval.length === 0
    ? {
        status: "green",
        detail: `${writes} write approvals pending while Jira was unchanged, ${created} issues written after`,
      }
    : {
        status: "red",
        detail: `${newAtApproval.length} issues existed before the first write approval was decided`,
      };
}

// ---------- readable approval ----------

const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value) => (typeof value === "string" && value.length > 0 ? value : undefined);
/** Whether text is itself a JSON object or array (a model pasting its request as a value). */
function isJsonText(value) {
  const trimmed = value.trim();
  if (!/^[[{]/.test(trimmed)) return false;
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

/**
 * Dotted paths of every string leaf that is JSON text. The card lays nested values out as
 * dotted-path rows and never prints JSON itself (#4178), so only a value the model wrote as JSON
 * text still reaches the human as JSON. Iterative, so a hostile depth cannot overflow the stack.
 */
function jsonTextPaths(root) {
  const found = [];
  const pending = [["", root]];
  while (pending.length > 0) {
    const [path, value] = pending.pop();
    if (typeof value === "string") {
      if (isJsonText(value)) found.push(path);
    } else if (Array.isArray(value)) {
      value.forEach((entry, index) => pending.push([`${path}.${index + 1}`, entry]));
    } else if (isRecord(value)) {
      for (const [key, entry] of Object.entries(value))
        pending.push([path === "" ? key : `${path}.${key}`, entry]);
    }
  }
  return found;
}

function linksReadable(value) {
  if (value === undefined) return true;
  return (
    Array.isArray(value) &&
    value.every(
      (link) =>
        isRecord(link) &&
        text(link.type) !== undefined &&
        ["inward", "outward"].includes(link.direction) &&
        (text(link.ref) ?? text(link.issueKey)) !== undefined,
    )
  );
}

function parentReadable(value) {
  if (value === undefined) return true;
  return (
    isRecord(value) &&
    text(value.fieldId) !== undefined &&
    (text(value.ref) === undefined) !== (text(value.issueKey) === undefined)
  );
}

/** One draft item the way the approval card's tree needs it: identity, summary, relations. */
function itemReadable(item) {
  const fields = isRecord(item) ? item.fields : undefined;
  return (
    isRecord(item) &&
    isRecord(fields) &&
    [item.ref, item.projectId, item.issueTypeId, fields.summary].every(
      (value) => text(value) !== undefined,
    ) &&
    linksReadable(item.links) &&
    parentReadable(item.parent)
  );
}

/** The draft items when the card can show them as a tree: non-empty, readable, unique refs. */
function draftItems(call) {
  const items = isRecord(call?.arguments) ? call.arguments.items : undefined;
  if (!Array.isArray(items) || items.length === 0) return undefined;
  if (!items.every((entry) => itemReadable(entry))) return undefined;
  return new Set(items.map((item) => item.ref)).size === items.length ? items : undefined;
}

/**
 * Whether the approval of one stored tool call reaches the human as a readable preview. The card
 * never shows a request as JSON (#4178): a `jira.draft` whose items form a tree is shown as that
 * tree, and every other request, an untreeable draft included, as named facts with nested values
 * laid out as dotted paths. The rule mirrors `JiraWriteApproval`, `jiraActionFacts` and
 * `jiraDraftTree` of the UI (packages/keiko-ui/src/app/components/desktop/): the UI is not
 * importable here, so a drift is caught by the card tests that own the rule
 * (`JiraWriteApproval.readable.test.tsx`), not by this copy. A value the model wrote as JSON text
 * is still shown as that text, so it stays unreadable here.
 */
export function gradeApprovalReadable(approval, call) {
  const operation = approval?.operation ?? "unknown operation";
  if (!isRecord(call?.arguments)) {
    return { readable: false, reason: `${operation} has no stored request to show` };
  }
  const raw = jsonTextPaths(call.arguments);
  if (raw.length > 0) {
    return {
      readable: false,
      reason: `${raw.length} values are JSON text the card shows verbatim (${[...new Set(raw)].slice(0, 4).join(", ")})`,
    };
  }
  if (operation !== "jira.draft") {
    return { readable: true, reason: `${operation} shown as named facts` };
  }
  const items = draftItems(call);
  return items === undefined
    ? { readable: true, reason: "the draft is shown field by field under a note" }
    : { readable: true, reason: `${items.length} draft items shown as a tree` };
}

/** All approvals the supervisor met: readable only when none of them shows raw JSON. */
export function gradeApprovals(records) {
  if (records.length === 0) {
    return { status: "unverified", detail: "no write approval was shown in any mode" };
  }
  const grades = records.map((record) => gradeApprovalReadable(record.approval, record.call));
  const unreadable = grades.filter((grade) => !grade.readable);
  return unreadable.length === 0
    ? { status: "green", detail: `${grades.length} approvals readable: ${grades[0].reason}` }
    : {
        status: "red",
        detail: `${unreadable.length} of ${grades.length} approvals unreadable: ${unreadable[0].reason}`,
      };
}

// ---------- journey ----------

const modePrompt = (requirements) =>
  `Lege im Jira-Projekt REQ für die Anforderungen ${requirements.join(" und ")} aus dem Lastenheft je ein Epic nach der Strukturvorgabe an. Melde die Vorgangsschlüssel oder den genauen Fehler.`;

async function modeRun(ctx, entry) {
  const chat = await ctx.freshChat(entry.mode);
  const before = await snapshotBefore(ctx, EPIC_QUERY);
  const turn = await ctx.turn(chat, modePrompt(entry.requirements), {
    observeBeforeApproval: () => ctx.search(EPIC_QUERY, "summary,labels"),
  });
  const epics = turnIssues({
    before,
    issues: await ctx.search(EPIC_QUERY, "summary,labels"),
    exchanges: turn.toolExchanges,
  });
  const [first] = turn.approvals.records ?? [];
  const newAtApproval = Array.isArray(first?.observed)
    ? first.observed.filter((issue) => !before.keys.has(issue.key))
    : undefined;
  const grade = gradeModeRun({
    approval: entry.approval,
    writes: turn.approvals.writes,
    created: epics.created.length,
    credited: epics.credited.length,
    newAtApproval,
  });
  return {
    turn,
    records: turn.approvals.records ?? [],
    part: {
      ...grade,
      label: entry.label,
      covers: [entry.obligation],
      detail: `${grade.detail}; ${countsOf(epics, "epics")}`,
    },
  };
}

/** S18: one fresh Chat per mode, then the readability of every approval the modes asked for. */
export async function modesAndReadableApproval(ctx) {
  const runs = await sequentially(MODE_RUNS, (entry) => modeRun(ctx, entry));
  const readable = gradeApprovals(runs.flatMap((run) => run.records));
  return aggregateParts(
    [
      ...runs.map((run) => run.part),
      { ...readable, label: "Approval preview", covers: ["approval-readable"] },
    ],
    runs.map((run) => run.turn),
  );
}
