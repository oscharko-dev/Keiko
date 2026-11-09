// Port of the Golden Jira oracle: only native reads establish the result, never model prose.
import { readFileSync } from "node:fs";
import { URL, URLSearchParams } from "node:url";
import { REQUIREMENT_DOCUMENT_SCOPE_PATTERN } from "../../../../packages/keiko-quality-intelligence/dist/domain/requirementInventory.js";
import { basicAuth, labRequest } from "../lab-client.mjs";
import { nativePages } from "../project-agile-oracles.mjs";

export const GOLDEN_REQUIREMENT_COUNT = 370;
export const GOLDEN_ACCEPTANCE_COUNT = 1029;
export const GOLDEN_NO_CRITERIA_TEXT = "No acceptance criteria are specified in the source.";
/** The Lastenheft formats one Knowledge Pod stages; every requirement ID occurs in all three. */
export const GOLDEN_LASTENHEFT_FILES = Object.freeze([
  "lastenheft-kundenportal-zahlungsverkehr.md",
  "lastenheft-kundenportal-zahlungsverkehr.docx",
  "lastenheft-kundenportal-zahlungsverkehr.pdf",
]);
/** The one document Epics cite, so each reference is qualified before the first write. */
export const GOLDEN_EPIC_SOURCE_DOCUMENT = GOLDEN_LASTENHEFT_FILES[0];
const PAGE_SIZE = 100;
const REQUIREMENT_ID = /^[A-Z][A-Z0-9_]*(?:-[A-Z0-9_]+)*-[0-9]+(?:\.[0-9]+)*$/u;
const DOCUMENT_SCOPE = new RegExp(REQUIREMENT_DOCUMENT_SCOPE_PATTERN, "u");
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const norm = (value) => value.normalize("NFC").replaceAll(/\s+/gu, " ").trim();

function requireFact(condition, message) {
  if (!condition) throw new TypeError(message);
}

export function goldenProjectKey(value) {
  requireFact(
    typeof value === "string" && value === value.trim() && /^[A-Z][A-Z0-9_]{0,31}$/u.test(value),
    "A native runtime project key is required",
  );
  return value;
}

export function loadGoldenManifest() {
  return JSON.parse(
    readFileSync(
      new URL(
        "../../../../tests/fixtures/requirements/lastenheft-kundenportal/manifest.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
}

export function validateGoldenManifest(manifest) {
  requireFact(
    record(manifest) && Array.isArray(manifest.requirements),
    "Malformed Golden manifest",
  );
  requireFact(
    manifest.requirements.length > 0 && manifest.requirementCount === manifest.requirements.length,
    "Golden requirement count does not match the manifest",
  );
  const ids = new Set();
  for (const requirement of manifest.requirements) {
    requireFact(record(requirement), "Malformed Golden requirement");
    requireFact(
      typeof requirement.id === "string" &&
        requirement.id === requirement.id.trim() &&
        REQUIREMENT_ID.test(requirement.id),
      "Malformed Golden requirement identity",
    );
    requireFact(!ids.has(requirement.id), "Duplicate Golden requirement identity");
    ids.add(requirement.id);
    validateRequirementContent(requirement);
  }
  return manifest.requirements;
}

function validateRequirementContent(requirement) {
  requireFact(
    typeof requirement.title === "string" && norm(requirement.title).length > 0,
    "Golden title is unavailable",
  );
  for (const field of ["acceptanceCriteria", "sectionPath"]) {
    const values = requirement[field];
    requireFact(Array.isArray(values), "Golden content is incomplete");
    if (field === "sectionPath")
      requireFact(values.length > 0, "Golden section path is incomplete");
    requireFact(
      values.every((value) => typeof value === "string" && norm(value).length > 0),
      "Golden content is malformed",
    );
    requireFact(new Set(values.map(norm)).size === values.length, "Golden content is duplicated");
  }
}

/** A deliberately narrow GET adapter. It cannot dispatch issue writes or follow remote URLs. */
export function goldenJiraReadAdapter(session, options = {}) {
  const request = options.request ?? labRequest;
  const authorization = options.auth ?? session.oracleAuthorization ?? basicAuth(session, "admin");
  return async (path) => {
    requireFact(
      typeof path === "string" &&
        /^\/rest\/(?:api\/2\/search\?|agile\/1\.0\/board\/[1-9][0-9]*\/(?:epic|backlog)\?)/u.test(
          path,
        ),
      "Unexpected Golden read path",
    );
    const result = await request(session, "GET", path, authorization);
    requireFact(
      result?.status === 200 && record(result.value),
      "Native Golden read is unavailable",
    );
    return result.value;
  };
}

function nativeIssueId(issue) {
  if (!record(issue)) return undefined;
  const id =
    typeof issue.id === "number" && Number.isSafeInteger(issue.id) && issue.id > 0
      ? String(issue.id)
      : issue.id;
  return typeof id === "string" && id === id.trim() && /^[1-9][0-9]{0,18}$/u.test(id)
    ? id
    : undefined;
}

function nativeIdentity(issue, projectKey) {
  const id = nativeIssueId(issue);
  if (id === undefined) return undefined;
  if (
    typeof issue.key !== "string" ||
    issue.key !== issue.key.trim() ||
    !new RegExp(`^${projectKey}-[1-9][0-9]*$`, "u").test(issue.key)
  )
    return undefined;
  return { id, key: issue.key };
}

function readableIssue(issue) {
  return (
    record(issue.fields) &&
    record(issue.fields.issuetype) &&
    typeof issue.fields.issuetype.name === "string" &&
    typeof issue.fields.summary === "string" &&
    (issue.fields.description === null || typeof issue.fields.description === "string")
  );
}

function searchPage(body, startAt, total) {
  requireFact(record(body), "Native Golden search page is malformed");
  requireFact(body.startAt === startAt, "Native Golden search cursor changed");
  requireFact(
    Number.isSafeInteger(body.total) && body.total >= 0 && body.total <= 10000,
    "Native Golden search total is unavailable",
  );
  requireFact(
    Number.isSafeInteger(body.maxResults) && body.maxResults > 0 && body.maxResults <= PAGE_SIZE,
    "Native Golden search page bound is malformed",
  );
  requireFact(Array.isArray(body.issues), "Native Golden search issues are unavailable");
  if (total !== undefined) requireFact(body.total === total, "Native Golden search total changed");
  requireFact(startAt <= body.total, "Native Golden search cursor exceeds total");
  requireFact(
    body.issues.length === Math.min(body.maxResults, body.total - startAt),
    "Native Golden search page is partial",
  );
  if (body.isLast !== undefined)
    requireFact(
      body.isLast === (startAt + body.issues.length === body.total),
      "Native Golden search completion contradicts total",
    );
  return body;
}

function appendSearchIssues(state, rows, projectKey) {
  for (const issue of rows) {
    const identity = nativeIdentity(issue, projectKey);
    requireFact(
      identity !== undefined && readableIssue(issue) && issue.fields.project?.key === projectKey,
      "Native Golden search contains a malformed or foreign issue",
    );
    requireFact(
      !state.ids.has(identity.id) && !state.keys.has(identity.key),
      "Native Golden search repeated an issue identity",
    );
    state.ids.add(identity.id);
    state.keys.add(identity.key);
    state.issues.push(issue);
  }
}

/** Golden's JQL-specific 100-row oracle. An absent/malformed/partial page is never an empty result. */
export async function readGoldenIssues(read, projectKey, options = {}) {
  goldenProjectKey(projectKey);
  requireFact(typeof read === "function", "A native Golden read adapter is required");
  const requestedFields = options.fields ?? "*all";
  requireFact(
    typeof requestedFields === "string" && /^[A-Za-z0-9_*.,-]{1,4096}$/u.test(requestedFields),
    "Malformed Golden field selection",
  );
  const fields = requestedFields.includes("*all")
    ? requestedFields
    : [
        ...new Set([
          ...requestedFields.split(","),
          "summary",
          "description",
          "issuetype",
          "project",
        ]),
      ].join(",");
  const state = { issues: [], ids: new Set(), keys: new Set() };
  let total;
  for (let page = 0; page < 100; page += 1) {
    options.signal?.throwIfAborted();
    const query = new URLSearchParams({
      jql: `project = "${projectKey}" ORDER BY key ASC`,
      startAt: String(state.issues.length),
      maxResults: String(PAGE_SIZE),
      fields,
    });
    const body = searchPage(await read(`/rest/api/2/search?${query}`), state.issues.length, total);
    total = body.total;
    appendSearchIssues(state, body.issues, projectKey);
    if (state.issues.length === total) return state.issues;
  }
  throw new TypeError("Native Golden search page budget exhausted");
}

function traceBlocks(description) {
  const lines = description.replaceAll("\r\n", "\n").split("\n");
  const starts = lines.flatMap((line, index) =>
    line.trim() === "Keiko traceability" ? [index] : [],
  );
  const ends = lines.flatMap((line, index) =>
    line.trim() === "End of Keiko traceability" ? [index] : [],
  );
  if (starts.length !== 1 || ends.length !== 1 || ends[0] <= starts[0]) return undefined;
  return { lines: lines.slice(starts[0] + 1, ends[0]), body: lines.slice(0, starts[0]).join("\n") };
}

function pageTrace(source, requirement) {
  const pdf = requirement.layout?.pdf;
  if (!record(pdf) || !Number.isSafeInteger(pdf.firstPage) || !Number.isSafeInteger(pdf.lastPage))
    return false;
  const match = /(?:^| · )page ([1-9][0-9]*)(?:\s*[-–]\s*([1-9][0-9]*))?$/u.exec(source);
  return (
    match !== null &&
    Number(match[1]) === pdf.firstPage &&
    Number(match[2] ?? match[1]) === pdf.lastPage
  );
}

function sectionTrace(source, requirement) {
  const parts = source.split(" · ").map(norm);
  const wanted = requirement.sectionPath.map(norm);
  if (/^page [1-9][0-9]*(?:\s*[-–]\s*[1-9][0-9]*)?$/u.test(parts.at(-1))) parts.pop();
  const path = parts.slice(1);
  return (
    parts[0].length > 0 &&
    path.length === wanted.length &&
    wanted.every((section, index) => path[index] === section)
  );
}

function ownedTraceReference(group, requirementId) {
  const references = group.split("\n").filter((line) => line.startsWith("Reference: "));
  if (references.length !== 1) return undefined;
  const reference = references[0].slice("Reference: ".length);
  const parts = reference.split(":");
  if (parts.length !== 2 || !DOCUMENT_SCOPE.test(parts[0]) || parts[1] !== requirementId)
    return undefined;
  return reference;
}

/** The identity and source a requirement's own Keiko traceability group carries, and the body before it. */
export function requirementTrace(description, requirement) {
  const block = traceBlocks(description);
  if (block === undefined) return { id: false, source: false, body: description };
  const groups = block.lines.join("\n").split(/\n\s*\n/u);
  const owned = groups.filter((group) => {
    const claims = group.split("\n").filter((line) => line.startsWith("Requirement: "));
    return (
      claims.length === 1 &&
      claims[0].slice("Requirement: ".length).split(" · ")[0] === requirement.id
    );
  });
  if (owned.length !== 1) return { id: false, source: false, body: block.body };
  const sources = owned[0].split("\n").filter((line) => line.startsWith("Source: "));
  const source = sources.length === 1 ? norm(sources[0].slice("Source: ".length)) : "";
  return {
    id: true,
    source: sectionTrace(source, requirement) || pageTrace(source, requirement),
    body: block.body,
    reference: ownedTraceReference(owned[0], requirement.id),
  };
}

/** Return only the exact native reference owned by this requirement and its observed source. */
export function goldenRequirementTraceReference(description, requirement) {
  const trace = requirementTrace(description, requirement);
  return trace.id && trace.source ? trace.reference : undefined;
}

function acceptanceRegion(body) {
  const lines = body.split(/\r?\n/u);
  const start = lines.findIndex((line) => {
    const heading = /^(?:#{1,6}\s+|h[1-6]\.\s+)(.+)$/u.exec(line);
    return (
      heading !== null &&
      new Set(["acceptance criteria", "akzeptanzkriterien"]).has(norm(heading[1]).toLowerCase())
    );
  });
  if (start < 0) return "";
  const remaining = lines.slice(start + 1);
  const end = remaining.findIndex((line) => /^(?:#{1,6} |h[1-6]\. |----)/u.test(line));
  return remaining.slice(0, end < 0 ? undefined : end).join("\n");
}

function criterionBlocks(body) {
  const blocks = [];
  let current = [];
  for (const line of body.split(/\r?\n/u)) {
    const bullet = /^\s*(?:[-*#]|[0-9]+[.)])\s+/u.test(line);
    const boundary = line.trim() === "" || /^(?:#{1,6} |h[1-6]\. |----)/u.test(line);
    if (bullet || boundary) {
      if (current.length > 0) blocks.push(norm(current.join(" ")));
      current = [];
    }
    if (!boundary) current.push(line.replace(/^\s*(?:[-*#]|[0-9]+[.)])\s+/u, ""));
  }
  if (current.length > 0) blocks.push(norm(current.join(" ")));
  return blocks;
}

/** Counts the criteria of `requirement` present, duplicated and unexpected in the acceptance region of `body`. */
export function gradeCriteria(body, requirement, counts) {
  const expected = new Set(requirement.acceptanceCriteria.map(norm));
  const blocks = criterionBlocks(acceptanceRegion(body)).filter(
    (block) => expected.size > 0 || block !== GOLDEN_NO_CRITERIA_TEXT,
  );
  counts.acUnexpected += blocks.filter((block) => !expected.has(block)).length;
  for (const criterion of expected) {
    const occurrences = blocks.filter((block) => block === criterion).length;
    if (occurrences > 0) counts.acPresent += 1;
    if (occurrences > 1) counts.acDuplicated += 1;
  }
}

function gradeContent(issue, requirement, counts) {
  if (norm(issue.fields.summary) === `[${requirement.id}] ${norm(requirement.title)}`)
    counts.titleHit += 1;
  const trace = requirementTrace(issue.fields.description, requirement);
  if (trace.id) counts.idHit += 1;
  if (trace.source) counts.traceHit += 1;
  gradeCriteria(trace.body, requirement, counts);
}

function requestedRequirements(manifest, requirementIds) {
  const all = validateGoldenManifest(manifest);
  if (requirementIds === undefined) return all;
  requireFact(
    Array.isArray(requirementIds) && new Set(requirementIds).size === requirementIds.length,
    "Malformed Golden requirement selection",
  );
  const wanted = new Set(requirementIds);
  const selected = all.filter((requirement) => wanted.has(requirement.id));
  requireFact(selected.length === wanted.size, "Unknown Golden requirement selection");
  return selected;
}

function appendEpic(issue, expected, grouped, counts) {
  if (issue.fields.issuetype.name !== "Epic") return;
  counts.epicCount += 1;
  const match = /^\[([^\]]+)\] /u.exec(issue.fields.summary);
  if (match === null || !expected.has(match[1])) {
    counts.unexpectedEpicCount += 1;
    return;
  }
  const group = grouped.get(match[1]) ?? [];
  group.push(issue);
  grouped.set(match[1], group);
}

function collectEpics(issues, projectKey, requirements, counts) {
  const expected = new Set(requirements.map((requirement) => requirement.id));
  const grouped = new Map();
  const nativeIds = new Set();
  const keys = new Set();
  for (const issue of issues) {
    const identity = nativeIdentity(issue, projectKey);
    if (identity === undefined || !readableIssue(issue)) {
      counts.malformedIssueCount += 1;
      continue;
    }
    if (nativeIds.has(identity.id) || keys.has(identity.key)) counts.duplicateNativeCount += 1;
    nativeIds.add(identity.id);
    keys.add(identity.key);
    if (issue.fields.project?.key !== projectKey) {
      counts.foreignIssueCount += 1;
      continue;
    }
    appendEpic(issue, expected, grouped, counts);
  }
  return grouped;
}

function goldenCounts(requirements, issueCount) {
  return {
    issueCount,
    epicCount: 0,
    truthCount: requirements.length,
    matched: 0,
    missingCount: 0,
    duplicateRequirementCount: 0,
    unexpectedEpicCount: 0,
    titleHit: 0,
    idHit: 0,
    traceHit: 0,
    acTotal: requirements.reduce((sum, item) => sum + item.acceptanceCriteria.length, 0),
    acPresent: 0,
    acDuplicated: 0,
    acUnexpected: 0,
    malformedIssueCount: 0,
    duplicateNativeCount: 0,
    foreignIssueCount: 0,
  };
}

function gradeMappings(requirements, grouped, counts) {
  const privateMappings = [];
  for (const requirement of requirements) {
    const group = grouped.get(requirement.id) ?? [];
    if (group.length === 0) {
      counts.missingCount += 1;
      continue;
    }
    if (group.length !== 1) {
      counts.duplicateRequirementCount += 1;
      continue;
    }
    const issue = group[0];
    if (typeof issue.fields.description !== "string") {
      counts.malformedIssueCount += 1;
      continue;
    }
    counts.matched += 1;
    gradeContent(issue, requirement, counts);
    privateMappings.push({ requirementId: requirement.id, id: String(issue.id), key: issue.key });
  }
  return privateMappings;
}

function completeGoldenCounts(counts) {
  return (
    counts.matched === counts.truthCount &&
    counts.titleHit === counts.truthCount &&
    counts.idHit === counts.truthCount &&
    counts.traceHit === counts.truthCount &&
    counts.acPresent === counts.acTotal &&
    counts.acDuplicated === 0 &&
    [
      counts.duplicateRequirementCount,
      counts.acUnexpected,
      counts.unexpectedEpicCount,
      counts.malformedIssueCount,
      counts.duplicateNativeCount,
      counts.foreignIssueCount,
    ].every((count) => count === 0)
  );
}

/** Independent exact identities replace Golden's old title/description fuzzy-find fallback. */
export function gradeGoldenEpics({ manifest, issues, projectKey, requirementIds }) {
  goldenProjectKey(projectKey);
  requireFact(Array.isArray(issues), "Native Golden issues are unavailable");
  const requirements = requestedRequirements(manifest, requirementIds);
  const counts = goldenCounts(requirements, issues.length);
  const grouped = collectEpics(issues, projectKey, requirements, counts);
  const privateMappings = gradeMappings(requirements, grouped, counts);
  const ok = completeGoldenCounts(counts);
  return { ok, counts, privateMappings };
}

export async function readGoldenBoardViews(read, boardId) {
  requireFact(
    typeof boardId === "string" &&
      boardId === boardId.trim() &&
      /^[1-9][0-9]{0,18}$/u.test(boardId),
    "A native board identity is required",
  );
  const boardEpics = await nativePages(read, `/rest/agile/1.0/board/${boardId}/epic`, "values");
  const backlog = await nativePages(read, `/rest/agile/1.0/board/${boardId}/backlog`, "issues");
  return { boardEpics, backlog };
}

/** Epics belong to the Epic view; their absence from the ordinary backlog is reported separately. */
export function gradeGoldenEpicViews({ epics, boardEpics, backlog }) {
  requireFact(
    [epics, boardEpics, backlog].every(Array.isArray),
    "Native board views are unavailable",
  );
  requireFact(
    [epics, boardEpics, backlog].every((rows) =>
      rows.every((issue) => nativeIssueId(issue) !== undefined),
    ),
    "Native board view identities are malformed",
  );
  const wanted = new Set(epics.map(nativeIssueId));
  const visible = new Set(boardEpics.map(nativeIssueId));
  const missing = [...wanted].filter((id) => !visible.has(id)).length;
  const unexpected = [...visible].filter((id) => !wanted.has(id)).length;
  const queued = backlog.filter(
    (issue) => wanted.has(String(issue.id)) || issue.fields?.issuetype?.name === "Epic",
  ).length;
  const epicView = {
    ok: missing === 0 && unexpected === 0 && visible.size === boardEpics.length,
    expectedCount: wanted.size,
    visibleCount: visible.size,
    missingCount: missing,
    unexpectedCount: unexpected,
  };
  const backlogView = { ok: queued === 0, issueCount: backlog.length, queuedEpicCount: queued };
  return {
    ok: wanted.size > 0 && epicView.ok && backlogView.ok,
    epics: epicView,
    backlog: backlogView,
  };
}
