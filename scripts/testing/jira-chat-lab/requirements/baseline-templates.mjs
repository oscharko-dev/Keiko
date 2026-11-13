// Laboratory baseline templates (#4369, #4354). The product refuses a Jira write that no stored
// template governs, so every lab lane that writes without a template of its own needs a governing
// one. This module is the single place that provides it: for every lab project and every issue
// type the project has, a rule-free fixture template is imported through the product's own skill
// library routes (the same path `withTemplate` uses), read back from the library listing, and
// left in place for the product instance's lifetime.
//
// Why it is harmless: the product ANDs every governing template, so a template whose only rule is
// one no Jira summary can break never narrows another template. A journey that installs its own
// template keeps its own rules in full; a lane that proves "no template governs" opts out of the
// baseline at product start (`baselineTemplates: false` or `KEIKO_JIRA_LAB_BASELINE_TEMPLATES=off`).
import { Buffer } from "node:buffer";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute } from "node:path";
import { basicAuth, labRequest } from "../lab-client.mjs";

/** Name prefix by which every listing and report recognises a laboratory fixture. */
export const BASELINE_NAME_PREFIX = "Lab baseline";
/** The environment switch that turns the baseline off for one run (any other value keeps it on). */
export const BASELINE_OFF_ENV = "KEIKO_JIRA_LAB_BASELINE_TEMPLATES";

const PROJECTS_MAX = 100;
const ISSUE_TYPES_MAX = 50;
/**
 * The product's skill library holds at most 128 skills, and journeys install their own templates
 * beside the baseline. A lab whose projects and issue types need more than this fails as a lab
 * error instead of crowding the library out.
 */
const PAIRS_MAX = 96;
const PROJECT_KEY = /^[A-Z][A-Z0-9_]{1,31}$/u;
/** Jira itself caps a summary at 255 characters, so this one rule can never be violated. */
const SUMMARY_MAX_LENGTH = 255;

/**
 * A plain activation (`create`, `edit`) governs every write of the project and type under the
 * current and the planned contract; `transition:<target>` would only add rules for one status.
 */
const ACTIVATIONS = Object.freeze(["create", "edit"]);

/** A failure of the baseline itself: a lab error, never a product verdict. */
export class BaselineTemplateError extends TypeError {
  constructor(code) {
    super(`Laboratory baseline templates unavailable: ${code}`);
    this.name = "BaselineTemplateError";
    this.code = code;
  }
}

const quoted = (value) => JSON.stringify(value);

function validProject(key) {
  if (typeof key !== "string" || !PROJECT_KEY.test(key)) throw new BaselineTemplateError("project");
  return key;
}

function validIssueType(name) {
  if (typeof name !== "string" || name.trim() !== name || name.length === 0 || name.length > 120)
    throw new BaselineTemplateError("issue-type");
  return name;
}

/** The fixture's display name; it is also the H1 of the template and the listing's `name` stem. */
export const baselineTemplateTitle = (project, issueType) =>
  `${BASELINE_NAME_PREFIX} ${validProject(project)} ${validIssueType(issueType)}`;

/** The rule-free template a lab project and issue type are governed by. */
export function baselineTemplateMarkdown(project, issueType) {
  return (
    [
      "---",
      "keiko: jira-issue-template",
      "version: 1",
      `project: ${validProject(project)}`,
      `issueType: ${quoted(validIssueType(issueType))}`,
      `activateOn: [${ACTIVATIONS.join(", ")}]`,
      `summaryMaxLength: ${String(SUMMARY_MAX_LENGTH)}`,
      "---",
      `# ${baselineTemplateTitle(project, issueType)}`,
      "",
      "Laboratory fixture. It governs every write of this project and issue type and adds no rule",
      "beyond Jira's own summary length.",
    ].join("\n") + "\n"
  );
}

const fileNameOf = (project, issueType) =>
  `${BASELINE_NAME_PREFIX.replaceAll(" ", "-")}-${project}-${issueType.replaceAll(/[^A-Za-z0-9]+/gu, "-")}.md`;

const isBaselineName = (name) => typeof name === "string" && name.startsWith(BASELINE_NAME_PREFIX);

/** The name the lab gives every fresh product state directory (`liveStateDirectory`). */
const LAB_STATE_PREFIX = "keiko-jira-live-chat-";

/**
 * The product instance must be a laboratory one: the OS keychain is off and the state directory is
 * one the lab itself created (its fixed name prefix), under the lab session (retained state) or
 * the OS temporary directory (disposable state). A fixture is never written into a real state dir.
 */
export function assertLabInstance({ root, session, env = process.env }) {
  const refuse = () => {
    throw new BaselineTemplateError("not-a-lab-instance");
  };
  if (env.KEIKO_OS_KEYCHAIN !== "off" || typeof root !== "string" || !isAbsolute(root)) refuse();
  if (typeof session?.directory !== "string" || !basename(root).startsWith(LAB_STATE_PREFIX))
    refuse();
  const parent = realpathSync(dirname(root));
  const labParents = [realpathSync(session.directory), realpathSync(tmpdir())];
  if (!labParents.includes(parent)) refuse();
}

/** Whether this run keeps the baseline: default on, off by option or by the exact env value. */
export function baselineEnabled(option, env = process.env) {
  return option !== false && env[BASELINE_OFF_ENV] !== "off";
}

// ---------- the lab's projects and issue types, read natively ----------

async function nativeRead(session, path) {
  const result = await labRequest(session, "GET", path, basicAuth(session, "admin"));
  if (result.status !== 200) throw new BaselineTemplateError("jira-read");
  return result.value;
}

/**
 * Every project the lab administrator sees and every issue type name that project has, read
 * natively and bounded. A listing that cannot be read, is not an array, or exceeds the bounds is a
 * lab error: a partial baseline would silently leave a project ungoverned.
 */
export async function readLabProjects(session, read = nativeRead) {
  const projects = await read(session, "/rest/api/2/project");
  if (!Array.isArray(projects) || projects.length > PROJECTS_MAX)
    throw new BaselineTemplateError("project-listing");
  const found = [];
  for (const project of projects) {
    const key = validProject(project?.key);
    const statuses = await read(session, `/rest/api/2/project/${encodeURIComponent(key)}/statuses`);
    if (!Array.isArray(statuses) || statuses.length > ISSUE_TYPES_MAX)
      throw new BaselineTemplateError("issue-type-listing");
    const names = [...new Set(statuses.map((entry) => validIssueType(entry?.name)))];
    found.push({ key, issueTypes: names });
  }
  return found;
}

// ---------- the product's skill-library routes ----------

const listTemplates = async (request) =>
  (await request("baseline-template-list", "/api/skills/jira-templates", undefined, "GET"))
    .templates;

async function importTemplate(request, project, issueType) {
  const markdown = baselineTemplateMarkdown(project, issueType);
  const { skill } = await request("baseline-template-import", "/api/skills", {
    fileName: fileNameOf(project, issueType),
    contentBase64: Buffer.from(markdown).toString("base64"),
  });
  return skill;
}

const governs = (entry, project, issueType) =>
  entry?.valid === true &&
  isBaselineName(entry.name) &&
  entry.project?.toUpperCase() === project &&
  entry.issueType?.toLowerCase() === issueType.toLowerCase() &&
  ACTIVATIONS.every((activation) => entry.activations?.includes(activation));

const wanted = (projects) =>
  projects.flatMap((project) =>
    project.issueTypes.map((issueType) => ({ project: project.key, issueType })),
  );

/**
 * Seeds one baseline template per project and issue type that does not have one, then reads the
 * library back and requires every pair to be listed, valid and governing. Idempotent: a retained
 * state that already holds a pair is left untouched, so a restart never duplicates a template.
 */
export async function seedBaselineTemplates(request, projects) {
  const pairs = wanted(projects);
  if (pairs.length > PAIRS_MAX) throw new BaselineTemplateError("library-capacity");
  const existing = await listTemplates(request);
  const imported = [];
  for (const { project, issueType } of pairs) {
    if (existing.some((entry) => governs(entry, project, issueType))) continue;
    imported.push(await importTemplate(request, project, issueType));
  }
  const verified = await listTemplates(request);
  const missing = pairs.filter(
    ({ project, issueType }) => !verified.some((entry) => governs(entry, project, issueType)),
  );
  if (missing.length > 0) throw new BaselineTemplateError("verification");
  console.log(
    JSON.stringify({
      operation: "jira-lab-baseline-templates",
      projects: projects.length,
      templates: pairs.length,
      imported: imported.length,
    }),
  );
  return { templates: pairs.length, imported: imported.length };
}

/**
 * The one call the lab's product start makes. Disabled runs seed nothing; an enabled run proves it
 * is a lab instance first, reads the lab's projects natively and seeds them.
 */
export async function seedLabBaseline({
  session,
  root,
  request,
  enabled = true,
  env = process.env,
  read = nativeRead,
}) {
  if (!baselineEnabled(enabled, env)) {
    console.log(JSON.stringify({ operation: "jira-lab-baseline-templates", skipped: true }));
    return undefined;
  }
  assertLabInstance({ root, session, env });
  return seedBaselineTemplates(request, await readLabProjects(session, read));
}

/**
 * The hook of the lab's product start: binds the paired product's JSON routes (`jsonRequest` is
 * injected by the caller, which owns the transport) and seeds unless this run opted out.
 */
export function seedProductBaseline({
  origin,
  cookie,
  root,
  session,
  baselineTemplates,
  jsonRequest,
}) {
  return seedLabBaseline({
    session,
    root,
    enabled: baselineTemplates,
    request: (name, path, body, method) => jsonRequest(origin, cookie, name, path, body, method),
  });
}

/**
 * For a journey that must prove "no template governs" inside one product instance: removes the
 * baseline templates for the duration of `body` and seeds them again, verified, afterwards. Prefer
 * the product-start opt-out; this exists for a journey that has to switch within one instance.
 */
export async function withBaselineSuspended(request, projects, body) {
  const removed = (await listTemplates(request)).filter((entry) => isBaselineName(entry.name));
  for (const entry of removed)
    await request(
      "baseline-template-delete",
      `/api/skills/${encodeURIComponent(entry.id)}`,
      { expectedRevision: entry.revision },
      "DELETE",
    );
  try {
    return await body();
  } finally {
    await seedBaselineTemplates(request, projects);
  }
}
