import assert from "node:assert/strict";
import { resolveLimitBrowser } from "./limit-run-browser.mjs";
import { withEnglishLimitUi } from "./limit-run-language.mjs";
import {
  checkedTemplate,
  closeSkillsIfOpen,
  listedAfter,
  openSkills,
  uploadBrowserSkill,
  watchTemplateReads,
} from "./browser-rules-knowledge-setup.mjs";
import { openLimitStep } from "./limit-run-step.mjs";
import { projectAgileRead } from "./project-agile-oracles.mjs";
import { STRUCTURE_RULES } from "./requirements/corpus.mjs";
import {
  epicTemplateMarkdown,
  gradeTemplateListing,
  runtimeTemplateProjectKey,
  templateMarkdown,
} from "./requirements/templates.mjs";

const TYPES = ["Epic", "Task", "Bug", "Sub-task"];
const STEP = "w12-templates";
const SKILL_ID = /^msk_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

function definitions(project, epicLinkFieldId) {
  return TYPES.map((issueType) => {
    const subtask = issueType === "Sub-task";
    const parentIssueTypes = subtask ? ["Task"] : undefined;
    const markdown =
      issueType === "Epic"
        ? epicTemplateMarkdown(project)
        : templateMarkdown({
            project,
            issueType,
            rule: subtask ? STRUCTURE_RULES.Task : STRUCTURE_RULES[issueType],
            parentField: subtask ? "parent" : epicLinkFieldId,
            parentIssueTypes,
            requiredFields: issueType === "Bug" ? ["priority"] : [],
          });
    return {
      issueType,
      markdown,
      formal: { project, issueType, ...(subtask ? { parentIssueTypes } : {}) },
    };
  });
}

async function nativeMetadata(ctx, projectKey) {
  const project = await projectAgileRead(
    ctx.session,
    `/rest/api/2/project/${encodeURIComponent(projectKey)}`,
  );
  assert.equal(project.key, projectKey);
  assert.match(project.id, /^[1-9][0-9]*$/u);
  for (const name of TYPES) {
    const types = project.issueTypes.filter((type) => type.name === name);
    assert.equal(types.length, 1);
    assert.equal(types[0].subtask, name === "Sub-task");
  }
  const fields = await projectAgileRead(ctx.session, "/rest/api/2/field");
  assert.ok(Array.isArray(fields));
  const epicLinks = fields.filter(
    (field) => field.schema?.custom === "com.pyxis.greenhopper.jira:gh-epic-link",
  );
  assert.equal(epicLinks.length, 1);
  assert.match(epicLinks[0].id, /^customfield_[1-9][0-9]*$/u);
  assert.equal(fields.filter((field) => field.id === "priority").length, 1);
  return { projectId: project.id, epicLinkFieldId: epicLinks[0].id };
}

function skillReference(skill, issueType) {
  assert.match(skill.id, SKILL_ID);
  assert.ok(Number.isSafeInteger(skill.revision) && skill.revision > 0);
  assert.match(skill.digest, /^[0-9a-f]{64}$/u);
  return { id: skill.id, revision: skill.revision, digest: skill.digest, issueType };
}

async function storedTemplates(ctx, templates, expected) {
  assert.equal(templates.length, TYPES.length);
  assert.equal(new Set(templates.map((skill) => skill.id)).size, TYPES.length);
  const stored = [];
  for (const definition of expected) {
    const matches = templates.filter((skill) => skill.issueType === definition.issueType);
    assert.equal(matches.length, 1);
    const reference = matches[0];
    const response = await ctx.page.request.get(`/api/skills/${encodeURIComponent(reference.id)}`);
    assert.equal(response.status(), 200);
    const { skill } = await response.json();
    assert.deepEqual(skillReference(skill, definition.issueType), reference);
    assert.equal(skill.body, definition.markdown);
    stored.push({ ...definition, skill });
  }
  return stored;
}

async function revalidateStoredTemplates(ctx, region, stored) {
  const watch = watchTemplateReads(ctx.page);
  const opened = watch.mark();
  const dialog = await openSkills(ctx.page, region);
  try {
    const templates = await listedAfter(watch, opened, (listed) =>
      stored.every(({ skill }) => listed.some((entry) => entry.id === skill.id)),
    );
    for (const { skill, markdown, formal } of stored) {
      assert.deepEqual(gradeTemplateListing(templates, skill, formal), {
        defined: true,
        activated: true,
      });
      assert.equal(templates.find((entry) => entry.id === skill.id).revision, skill.revision);
      await checkedTemplate(dialog, watch, skill, markdown, formal);
    }
  } finally {
    watch.stop();
    await closeSkillsIfOpen(dialog);
  }
}

function countsOf(progress) {
  return {
    templates: TYPES.length,
    installed: progress.installed.length,
    verified: progress.verified,
  };
}

async function installNewTemplates(ctx, journal, plan, region, progress) {
  const { projectKey, metadata, expected } = plan;
  await journal.checkpoint({
    phase: "pending",
    resources: { ...metadata, templates: [] },
    counts: countsOf(progress),
  });
  for (const definition of expected) {
    ctx.signal.throwIfAborted();
    const skill = await uploadBrowserSkill(
      ctx.page,
      region,
      definition.markdown,
      `Limit-${projectKey}-${definition.issueType}.md`,
      definition.formal,
    );
    progress.installed = [...progress.installed, skillReference(skill, definition.issueType)];
    progress.verified += 1;
    await journal.checkpoint({
      resources: { ...metadata, templates: progress.installed },
      counts: countsOf(progress),
    });
  }
  await storedTemplates(ctx, progress.installed, expected);
  assert.deepEqual(await nativeMetadata(ctx, projectKey), metadata);
  ctx.signal.throwIfAborted();
  await journal.checkpoint({
    phase: "completed",
    resources: { ...metadata, templates: progress.installed },
    counts: countsOf(progress),
  });
  return "templates-installed";
}

async function installOrVerify(ctx, journal, plan, progress) {
  const { metadata, expected, projectKey } = plan;
  const { region } = await resolveLimitBrowser(ctx, ctx.chat);
  if (journal.state.phase !== "completed")
    return installNewTemplates(ctx, journal, plan, region, progress);
  assert.equal(journal.state.resources.projectId, metadata.projectId);
  assert.equal(journal.state.resources.epicLinkFieldId, metadata.epicLinkFieldId);
  await revalidateStoredTemplates(
    ctx,
    region,
    await storedTemplates(ctx, progress.installed, expected),
  );
  assert.deepEqual(await nativeMetadata(ctx, projectKey), metadata);
  progress.verified = TYPES.length;
  return "templates-reverified";
}

/** Four formal templates installed through the ordinary Skills UI, with native metadata proof. */
export async function installTemplates(ctx) {
  const projectKey = runtimeTemplateProjectKey(ctx.projectKey);
  const journal = await openLimitStep(ctx, STEP);
  if (journal.state.phase === "pending")
    return journal.result("unverified", "templates-pending-unverified", journal.state.counts);
  const progress = { installed: journal.state.resources.templates ?? [], verified: 0 };
  let metadataAvailable = false;
  try {
    ctx.signal.throwIfAborted();
    assert.ok(ctx.chat?.id && typeof ctx.chat.projectPath === "string");
    const metadata = await nativeMetadata(ctx, projectKey);
    metadataAvailable = true;
    const plan = {
      projectKey,
      metadata,
      expected: definitions(projectKey, metadata.epicLinkFieldId),
    };
    const detail = await withEnglishLimitUi(ctx, () =>
      installOrVerify(ctx, journal, plan, progress),
    );
    return journal.result("green", detail, countsOf(progress));
  } catch {
    if (ctx.signal.aborted)
      return journal.result("unverified", "templates-aborted", countsOf(progress));
    return journal.result(
      metadataAvailable ? "red" : "unverified",
      metadataAvailable ? "templates-verification-failed" : "templates-native-metadata-unavailable",
      countsOf(progress),
    );
  }
}
