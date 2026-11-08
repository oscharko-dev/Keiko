import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { privateJson, privateText } from "./private-json.mjs";

export const ROLE_LABELS = Object.freeze({
  projectLead: "Projektleitung",
  developer: "Entwicklung",
  techLead: "Technikverantwortung",
});
const FAILED_CHECKS = new Set([
  "wire",
  "approval",
  "readback",
  "answer",
  "presentation",
  "binding",
]);
const FAILURE_CODES = new Set([...FAILED_CHECKS, "turn", "prerequisite", "reload"]);
const OBSERVED_PROOF_STATUSES = new Set(["verified", "unverified", "denied"]);

export function initializeRoleScorecards(group, catalog) {
  group.scorecards = Object.fromEntries(
    Object.keys(ROLE_LABELS).map((role) => [
      role,
      {
        role,
        reload: { status: "unverified", code: "not-run" },
        steps: catalog[role].map((definition, index) => ({
          step: index + 1,
          id: definition.id,
          title: definition.title,
          expectedWrites: definition.expectedWrites,
          wireSignatures: definition.wireSignatures,
          status: "unverified",
          detail: { code: "not-run" },
        })),
      },
    ]),
  );
}

function count(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function wireCounts(snapshot) {
  return {
    attempted: count(snapshot?.attempted),
    forwarded: count(snapshot?.forwarded),
    blocked: count(snapshot?.blocked),
    statuses: (snapshot?.statuses ?? []).filter(
      (status) => Number.isSafeInteger(status) && status >= 100 && status <= 599,
    ),
  };
}

function failureCode(error) {
  if (FAILURE_CODES.has(error?.stage)) return error.stage;
  if (FAILURE_CODES.has(error?.code)) return error.code;
  return "turn";
}

function proofDigest(proof) {
  const serialized = JSON.stringify(proof);
  if (serialized === undefined) return null;
  return createHash("sha256").update(serialized).digest("hex");
}

function proofGrade(proof) {
  if (proof === null || typeof proof !== "object" || !OBSERVED_PROOF_STATUSES.has(proof.status))
    return { status: "unverified", detail: { code: "proof-unavailable" } };
  const status = proof.status === "unverified" ? "unverified" : "green";
  return {
    proofDigest: proofDigest(proof),
    status,
    detail: { code: status === "green" ? "independently-observed" : "product-unconfirmed" },
  };
}

/** Only closed classifications, counts and digests leave the in-memory turn or native readback. */
export function recordRoleStep(group, role, id, { proof, error, turn, wire, findings = 0 }) {
  const row = group.scorecards[role].steps.find((item) => item.id === id);
  assert.ok(row, "Only a declared role step can be graded");
  row.wire = wireCounts(wire);
  row.approvals = count(turn?.decisions);
  row.presentationFindings = count(error?.presentationFindings ?? findings);
  delete row.proofDigest;
  if (error !== undefined) {
    const code = failureCode(error);
    row.status = FAILED_CHECKS.has(code) ? "red" : "unverified";
    row.detail = { code };
    return row;
  }
  Object.assign(row, proofGrade(proof));
  return row;
}

export function roleVerdict(report) {
  if (report.reload.status === "red" || report.steps.some((step) => step.status === "red"))
    return "red";
  if (report.reload.status !== "green" || report.steps.some((step) => step.status !== "green"))
    return "unverified";
  return "green";
}

function wireText(signatures) {
  if (signatures.length === 0) return "0 Writes";
  return signatures.map(({ method, path }) => `${method} ${path}`).join("; ");
}

function roleScorecardMarkdown(report) {
  const lines = [
    `# Jira-Rollen-Journey: ${ROLE_LABELS[report.role]}`,
    "",
    `Ergebnis: **${report.status ?? roleVerdict(report)}**. Reload: **${report.reload.status}**.`,
    "",
    "| Schritt | Ergebnis | Erwarteter Wire | Approvals | Forwarded | Befund |",
    "| --- | --- | --- | --- | --- | --- |",
  ];
  for (const row of report.steps) {
    lines.push(
      `| ${row.step}. ${row.title} | ${row.status} | ${wireText(row.wireSignatures)} | ${row.approvals ?? "—"} | ${row.wire?.forwarded ?? "—"} | ${row.detail.code} |`,
    );
  }
  lines.push("", "Details enthalten ausschließlich Klassifikationen, Zähler und Prüfsummen.", "");
  return lines.join("\n");
}

export function writeRoleScorecards(session, group) {
  assert.match(group.id, /^[0-9a-f-]{36}$/u);
  const complete =
    group.phase === "completed" &&
    group.browserCleanup?.failed === 0 &&
    group.browserCleanup.closed === Object.keys(ROLE_LABELS).length;
  for (const role of Object.keys(ROLE_LABELS)) {
    const report = group.scorecards[role];
    let status = roleVerdict(report);
    if (status === "green" && !complete) status = "unverified";
    const record = {
      schemaVersion: 1,
      kind: "jira-browser-roles-scorecard",
      groupId: group.id,
      ...report,
      status,
      runStatus: group.phase ?? "incomplete",
      browserCleanup: group.browserCleanup ?? { closed: 0, failed: 0 },
    };
    const stem = join(session.directory, `roles-scorecard-${group.id}-${role}`);
    privateJson(`${stem}.json`, record);
    privateText(`${stem}.md`, roleScorecardMarkdown(record));
  }
}
