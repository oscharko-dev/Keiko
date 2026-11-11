import { describe, expect, it } from "vitest";
import {
  SUBTASK_PARENT_TYPES,
  storyTemplatePlan,
} from "../testing/jira-chat-lab/story-templates.mjs";
import {
  limitTemplateDefinitions,
  storyTemplateMarkdown,
  subtaskTemplateMarkdown,
} from "../testing/jira-chat-lab/requirements/templates.mjs";

const PROJECT = "LIM9";
const EPIC_LINK = "customfield_10014";

// The Sub-task template the limit run itself installs is the one `ac1-templates` produces.
const installed = limitTemplateDefinitions(PROJECT, EPIC_LINK).find(
  (definition) => definition.issueType === "Sub-task",
).markdown;
const skill = (issueType, body) => ({ id: `msk_${issueType}`, issueType, body });

describe("the Story template plan", () => {
  it("installs the Story template and replaces the limit run's Sub-task template", () => {
    const plan = storyTemplatePlan({
      projectKey: PROJECT,
      epicLinkFieldId: EPIC_LINK,
      skills: [skill("Sub-task", installed), skill("Task", "any")],
    });
    expect(plan.Story).toMatchObject({
      action: "install",
      markdown: storyTemplateMarkdown(PROJECT, EPIC_LINK),
      formal: { project: PROJECT, issueType: "Story" },
    });
    expect(plan["Sub-task"]).toMatchObject({
      action: "replace",
      markdown: subtaskTemplateMarkdown(PROJECT, [...SUBTASK_PARENT_TYPES]),
      formal: { parentIssueTypes: ["Task", "Story"] },
    });
    expect(plan["Sub-task"].skill.id).toBe("msk_Sub-task");
  });

  it("keeps both templates once they are current, so a rerun changes nothing", () => {
    const plan = storyTemplatePlan({
      projectKey: PROJECT,
      epicLinkFieldId: EPIC_LINK,
      skills: [
        skill("Story", storyTemplateMarkdown(PROJECT, EPIC_LINK)),
        skill("Sub-task", subtaskTemplateMarkdown(PROJECT, [...SUBTASK_PARENT_TYPES])),
      ],
    });
    expect(plan.Story.action).toBe("keep");
    expect(plan["Sub-task"].action).toBe("keep");
  });

  it("installs a Sub-task template that an interrupted replacement left missing", () => {
    const plan = storyTemplatePlan({
      projectKey: PROJECT,
      epicLinkFieldId: EPIC_LINK,
      skills: [],
    });
    expect(plan["Sub-task"].action).toBe("install");
  });

  it("never overwrites a template a lead edited or defined twice", () => {
    const edited = `${installed}\nExtra rule\n`;
    const input = { projectKey: PROJECT, epicLinkFieldId: EPIC_LINK };
    expect(() => storyTemplatePlan({ ...input, skills: [skill("Sub-task", edited)] })).toThrow(
      "subtask-template-unexpected",
    );
    expect(() =>
      storyTemplatePlan({
        ...input,
        skills: [skill("Sub-task", installed), skill("Sub-task", installed)],
      }),
    ).toThrow("subtask-template-unexpected");
    expect(() =>
      storyTemplatePlan({ ...input, skills: [skill("Story", "another Story template")] }),
    ).toThrow("story-template-unexpected");
  });
});
