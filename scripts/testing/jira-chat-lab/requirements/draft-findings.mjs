// S15 of epic #4173 (#4179): the requirement-quality findings reach the epics a backlog draft
// creates. ADR-0128 ("Quality"): the closed finding codes of the existing requirement-quality checks
// are written into the trace footer of every derived issue (`Quality findings: <codes>`). The lab
// credits the obligation only from the issues Jira holds, never from the answer: for one seeded
// requirement with vague wording and one without acceptance criteria, the footer of the epic that
// traces it carries exactly the finding codes the production checks derive for that requirement.
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { buildCorpus } from "./corpus.mjs";
import { claimedRequirement, turnIssues } from "./oracles.mjs";
import { snapshotBefore } from "./journey-support.mjs";

const EPIC_QUERY = "project = REQ AND issuetype = Epic";
const REPO = join(import.meta.dirname, "..", "..", "..", "..");
const FOOTER_START = "Keiko traceability";
const FOOTER_END = "End of Keiko traceability";

/** The seeded requirements the journey drafts epics for: one vague, one without criteria. */
export function seededDefects(truth = buildCorpus(1).truth) {
  const vague = truth.find((item) => item.vague && item.acceptanceCount > 0);
  const unsupported = truth.find((item) => !item.vague && item.acceptanceCount === 0);
  if (vague === undefined || unsupported === undefined) {
    throw new TypeError("The corpus seeds no vague requirement or no requirement without criteria");
  }
  return { vague: vague.id, withoutCriteria: unsupported.id };
}

/**
 * The finding codes the production requirement-quality checks derive per requirement id of the lab
 * corpus: the same functions the write path uses for the footer, so the lab restates no code.
 */
export async function expectedFindings(ids, markdown = buildCorpus(1).markdown) {
  const quality = await import(
    pathToFileURL(join(REPO, "packages/keiko-quality-intelligence/dist/index.js")).href
  );
  const inventory = quality.deriveRequirementInventory({ text: markdown, documentKey: "lab" });
  const findings = quality.assessRequirementInventoryQuality(inventory.entries);
  const expected = new Map(ids.map((id) => [id, [...(findings.get(id) ?? [])].sort()]));
  for (const [id, codes] of expected) {
    // A seeded defect the production checks do not see would make the footer "none" correct.
    if (codes.length === 0) throw new TypeError(`The production checks find nothing for ${id}`);
  }
  return expected;
}

/** Per requirement id, the finding codes the description's trace footer states, or nothing. */
export function footerFindings(description) {
  const text = String(description ?? "").replaceAll("\r\n", "\n");
  const start = text.indexOf(FOOTER_START);
  const end = text.indexOf(FOOTER_END, start + FOOTER_START.length);
  const found = new Map();
  if (start < 0 || end < 0) return found;
  for (const group of text.slice(start + FOOTER_START.length, end).split(/\n\s*\n/u)) {
    const id = /^Requirement: (LH-\d{3})\b/mu.exec(group)?.[1];
    const line = /^Quality findings: (.+)$/mu.exec(group)?.[1];
    if (id === undefined || line === undefined) continue;
    const codes = line.trim() === "none" ? [] : line.split(",").map((code) => code.trim());
    found.set(id, codes.sort());
  }
  return found;
}

const sameCodes = (left, right) =>
  left.length === right.length && left.every((code, index) => code === right[index]);

/** What one requirement's epics show: a problem, absent evidence, or nothing wrong. */
function judgeEpics(id, own, codes) {
  if (own.length === 0) return { absent: `${id}: no epic in Jira` };
  if (own.length > 1) return { problem: `${id}: ${own.length} epics` };
  const stated = footerFindings(own[0].fields.description).get(id);
  if (stated === undefined) return { absent: `${id}: no findings in the trace footer` };
  return sameCodes(stated, codes)
    ? {}
    : { problem: `${id}: footer states ${stated.join(", ") || "none"}` };
}

/**
 * Grades the epics of the draft turn against the expected codes. Absent evidence (no epic for a
 * requirement, an epic without a trace footer for it) is `unverified`; a footer that states other
 * codes, a stray epic or a duplicate is `red`; every requirement with exactly one epic whose footer
 * states exactly its codes is `green`.
 */
export function gradeDraftFindings({ epics, expected }) {
  const stray = epics.credited.filter((epic) => !expected.has(claimedRequirement(epic)));
  const judged = [...expected].map(([id, codes]) =>
    judgeEpics(
      id,
      epics.credited.filter((epic) => claimedRequirement(epic) === id),
      codes,
    ),
  );
  const problems = [
    ...(stray.length > 0 ? [`${stray.length} epics for other requirements`] : []),
    ...(epics.duplicates.length > 0 ? [`${epics.duplicates.length} duplicates`] : []),
    ...judged.flatMap((entry) => entry.problem ?? []),
  ];
  const absent = judged.flatMap((entry) => entry.absent ?? []);
  const status = problems.length > 0 ? "red" : absent.length > 0 ? "unverified" : "green";
  const detail =
    [...problems, ...absent].join("; ") || `${expected.size} epic footers state the codes`;
  return { status, detail };
}

/** The second turn of S15: draft epics for the seeded defects and read the footers from Jira. */
export async function draftFindingsPart(ctx, chat) {
  const { vague, withoutCriteria } = seededDefects();
  const expected = await expectedFindings([vague, withoutCriteria]);
  const before = await snapshotBefore(ctx, EPIC_QUERY);
  const turn = await ctx.turn(
    chat,
    `Lege im Jira-Projekt REQ für die Anforderungen ${vague} und ${withoutCriteria} aus dem Lastenheft je ein Epic nach der Strukturvorgabe an. Melde die Vorgangsschlüssel.`,
  );
  const epics = turnIssues({
    before,
    issues: await ctx.search(EPIC_QUERY, "summary,description,labels"),
    exchanges: turn.toolExchanges,
  });
  return {
    turn,
    part: {
      label: "epic draft findings",
      covers: ["findings-attached-to-epic-draft"],
      ...gradeDraftFindings({ epics, expected }),
    },
  };
}
