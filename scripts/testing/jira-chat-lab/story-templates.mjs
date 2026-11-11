// The templates a project lead adds for Stories: a Story template, and a Sub-task template that
// also admits a Story as its parent. Both go in through the ordinary Skills dialog, as the other
// four templates of the limit run do (`templates.mjs`); nothing here relaxes a product rule.
import assert from "node:assert/strict";
import { resolveLimitBrowser } from "./limit-run-browser.mjs";
import { withEnglishLimitUi } from "./limit-run-language.mjs";
import { removeBrowserSkill, uploadBrowserSkill } from "./browser-rules-knowledge-setup.mjs";
import { storyTemplateMarkdown, subtaskTemplateMarkdown } from "./requirements/templates.mjs";

/** Parents a Sub-task may hang under once Stories exist. */
export const SUBTASK_PARENT_TYPES = Object.freeze(["Task", "Story"]);
const LEGACY_SUBTASK_PARENT_TYPES = Object.freeze(["Task"]);

function bodyMatches(skill, markdown) {
  return skill.body === markdown;
}

function storyAction(project, epicLinkFieldId, skills) {
  const markdown = storyTemplateMarkdown(project, epicLinkFieldId);
  const formal = { project, issueType: "Story" };
  if (skills.length === 0) return { action: "install", markdown, formal };
  if (skills.length === 1 && bodyMatches(skills[0], markdown)) return { action: "keep" };
  throw new TypeError("story-template-unexpected");
}

function subtaskAction(project, skills) {
  const markdown = subtaskTemplateMarkdown(project, [...SUBTASK_PARENT_TYPES]);
  const formal = { project, issueType: "Sub-task", parentIssueTypes: [...SUBTASK_PARENT_TYPES] };
  if (skills.length === 0) return { action: "install", markdown, formal };
  if (skills.length !== 1) throw new TypeError("subtask-template-unexpected");
  if (bodyMatches(skills[0], markdown)) return { action: "keep" };
  // Only the template the limit run itself installed may be replaced, never a lead's own edit.
  if (bodyMatches(skills[0], subtaskTemplateMarkdown(project, [...LEGACY_SUBTASK_PARENT_TYPES])))
    return { action: "replace", skill: skills[0], markdown, formal };
  throw new TypeError("subtask-template-unexpected");
}

/**
 * What must change in the library: `skills` are the stored templates of the project
 * (`{ issueType, body, ... }`). Unknown content is never overwritten.
 */
export function storyTemplatePlan({ projectKey, epicLinkFieldId, skills }) {
  const of = (issueType) => skills.filter((skill) => skill.issueType === issueType);
  return {
    Story: storyAction(projectKey, epicLinkFieldId, of("Story")),
    "Sub-task": subtaskAction(projectKey, of("Sub-task")),
  };
}

async function storedSkill(ctx, id) {
  const response = await ctx.page.request.get(`/api/skills/${encodeURIComponent(id)}`);
  assert.equal(response.status(), 200);
  return (await response.json()).skill;
}

async function projectSkills(ctx, projectKey) {
  const response = await ctx.page.request.get("/api/skills/jira-templates");
  assert.equal(response.status(), 200);
  const { templates } = await response.json();
  const own = templates.filter(
    (entry) => typeof entry.project === "string" && entry.project.toUpperCase() === projectKey,
  );
  return Promise.all(
    own.map(async (entry) => ({
      ...(await storedSkill(ctx, entry.id)),
      issueType: entry.issueType,
    })),
  );
}

async function apply(ctx, region, projectKey, issueType, action) {
  if (action.action === "keep") return 0;
  if (action.action === "replace") await removeBrowserSkill(ctx.page, region, action.skill);
  await uploadBrowserSkill(
    ctx.page,
    region,
    action.markdown,
    `Limit-${projectKey}-${issueType}.md`,
    action.formal,
  );
  return 1;
}

/** Installs the Story template and widens the Sub-task template's parents, then re-reads the library. */
export async function ensureStoryTemplates(ctx) {
  const projectKey = ctx.projectKey;
  const epicLinkFieldId = ctx.truth.fieldIds.epicLink;
  return withEnglishLimitUi(ctx, async () => {
    const { region } = await resolveLimitBrowser(ctx, ctx.chat);
    const plan = storyTemplatePlan({
      projectKey,
      epicLinkFieldId,
      skills: await projectSkills(ctx, projectKey),
    });
    const installed = await apply(ctx, region, projectKey, "Story", plan.Story);
    const replaced = await apply(ctx, region, projectKey, "Sub-task", plan["Sub-task"]);
    const settled = storyTemplatePlan({
      projectKey,
      epicLinkFieldId,
      skills: await projectSkills(ctx, projectKey),
    });
    assert.ok(Object.values(settled).every((action) => action.action === "keep"));
    return { templatesInstalled: installed, templatesReplaced: replaced };
  });
}
