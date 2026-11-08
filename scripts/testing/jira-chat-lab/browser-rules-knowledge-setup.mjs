import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { basename, join } from "node:path";
import { copyFileSync, mkdirSync } from "node:fs";
import { URL } from "node:url";
import { expect } from "@playwright/test";
import { writeCorpusDocuments } from "./requirements/corpus-documents.mjs";
import { gradeTemplateListing, gradeTemplateValidation } from "./requirements/templates.mjs";

function responseAfter(page, method, path, action) {
  const pending = page.waitForResponse((response) => response.request().method() === method &&
    new URL(response.url()).pathname === path);
  return action().then(() => pending);
}

async function skills(page, region) {
  await region.getByRole("button", { name: "Skills", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Skills", exact: true });
  await dialog.waitFor();
  return dialog;
}

export async function uploadBrowserSkill(page, region, markdown, fileName, formal) {
  const dialog = await skills(page, region);
  const uploaded = await responseAfter(page, "POST", "/api/skills", () =>
    dialog.getByLabel("Upload Markdown (.md, up to 128 KiB)", { exact: true }).setInputFiles({
      name: fileName, mimeType: "text/markdown", buffer: Buffer.from(markdown),
    }));
  assert.equal(uploaded.status(), 201);
  const { skill } = await uploaded.json();
  if (formal) await inspectBrowserTemplate(page, dialog, skill, formal);
  else {
    const row = dialog.getByRole("listitem").filter({
      has: dialog.getByRole("button", { name: skill.name, exact: true }),
    });
    await row.getByRole("button", { name: "Select", exact: true }).click();
    await row.getByRole("button", { name: "Active in this chat", exact: true }).waitFor();
    const templates = await listedBrowserTemplates(page, dialog);
    assert.equal(templates.some((entry) => entry.id === skill.id), false,
      "The active prose skill must not appear as a formal template");
  }
  await dialog.getByRole("button", { name: "Close skills", exact: true }).click();
  return skill;
}

async function listedBrowserTemplates(page, dialog) {
  const listed = await responseAfter(page, "GET", "/api/skills/jira-templates", () =>
    dialog.getByRole("button", { name: "Jira issue templates", exact: true }).click());
  assert.equal(listed.status(), 200);
  return (await listed.json()).templates;
}

async function inspectBrowserTemplate(page, dialog, skill, formal) {
  assert.deepEqual(gradeTemplateListing(await listedBrowserTemplates(page, dialog), skill, formal),
    { defined: true, activated: true });
  const row = dialog.getByRole("listitem").filter({ hasText: skill.name }).filter({
    has: dialog.getByRole("button", { name: "Validate against Jira", exact: true }),
  });
  await row.getByText(`${formal.project} · ${formal.issueType} · create`, { exact: true }).waitFor();
  const validated = await responseAfter(page, "POST", "/api/skills/jira-templates/validate", () =>
    row.getByRole("button", { name: "Validate against Jira", exact: true }).click());
  assert.equal(validated.status(), 200);
  if (formal.parentIssueTypes !== undefined) {
    const markdown = validated.request().postDataJSON().markdown;
    assert.equal(typeof markdown, "string");
    assert.ok(markdown.includes(`parentIssueTypes: [${formal.parentIssueTypes.map((type) => JSON.stringify(type)).join(", ")}]`),
      "Validation must use the stored uploaded parent-type clause");
  }
  assert.equal(gradeTemplateValidation(await validated.json()).ok, true);
  await row.getByText("The template matches the Jira instance.", { exact: true }).waitFor();
}

export async function removeBrowserSkill(page, region, skill) {
  const dialog = await skills(page, region);
  await dialog.getByRole("button", { name: skill.name, exact: true }).click();
  const preview = dialog.getByRole("region", { name: "Skill preview", exact: true });
  await preview.getByRole("button", { name: "Delete", exact: true }).click();
  const deleted = await responseAfter(page, "DELETE", `/api/skills/${encodeURIComponent(skill.id)}`, () =>
    preview.getByRole("button", { name: "Delete skill", exact: true }).click());
  assert.ok(deleted.ok());
  await expect(dialog.getByRole("button", { name: skill.name, exact: true })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Close skills", exact: true }).click();
}

/** Existing synthetic document writer, split across explicitly selected files and a folder. */
export function browserKnowledgeDocuments(workspace) {
  const root = join(workspace, "browser-requirements");
  const rendered = writeCorpusDocuments(join(root, "rendered"));
  const folder = join(root, "folder");
  mkdirSync(folder, { recursive: true });
  const files = [];
  for (const path of rendered) {
    if (/\.(xlsx|pptx)$/u.test(path)) copyFileSync(path, join(folder, basename(path)));
    else files.push(basename(path));
  }
  return { root: join(root, "rendered"), files, folder, names: rendered.map((path) => basename(path)) };
}

async function connectBrowserSource(page, capsuleId, rootPath, files) {
  await page.getByLabel("Source path", { exact: true }).fill(rootPath);
  const disclosure = page.locator("summary").filter({ hasText: "Index only specific documents" });
  if (files !== undefined) {
    if (!(await page.getByLabel("Relative document paths", { exact: true }).isVisible())) await disclosure.click();
    await page.getByLabel("Relative document paths", { exact: true }).fill(files.join("\n"));
  } else if (await page.getByLabel("Relative document paths", { exact: true }).isVisible()) {
    await page.getByLabel("Relative document paths", { exact: true }).fill("");
  }
  const response = await responseAfter(page, "POST", `/api/local-knowledge/capsules/${capsuleId}/connection`, () =>
    page.getByRole("button", { name: "Connect", exact: true }).click());
  assert.equal(response.status(), 201);
  assert.deepEqual(response.request().postDataJSON().scope, files === undefined
    ? { kind: "folder", rootPath, recursive: true }
    : { kind: "files", rootPath, files });
}

async function indexedBrowserPod(page, capsuleId) {
  const path = `/api/local-knowledge/capsules/${capsuleId}`;
  const admitted = await responseAfter(page, "POST", `${path}/index`, () =>
    page.getByRole("button", { name: "Index this Knowledge Pod now", exact: true }).click());
  assert.equal(admitted.status(), 202);
  const { jobId } = await admitted.json();
  assert.equal(typeof jobId, "string");
  let detail;
  await expect.poll(async () => {
    const response = await page.request.get(path);
    assert.equal(response.status(), 200);
    detail = await response.json();
    const status = detail.indexingJobs.find((job) => job.id === jobId)?.status;
    assert.ok(status !== "failed" && status !== "cancelled", "Actual indexing must succeed");
    return status;
  }, { timeout: 600000 }).toBe("succeeded");
  assert.equal(detail.capsule.lifecycleState, "ready");
  assert.equal(detail.capsule.sourceIds.length, 2);
  assert.equal(detail.health.documentCount, 4);
  assert.ok(detail.health.vectorCount > 0);
  for (const key of ["failedDocuments", "skippedDocuments", "unsupportedDocuments"])
    assert.equal(detail.health[key], 0);
  await expect(page.getByRole("button", { name: "Index this Knowledge Pod now", exact: true })).toBeEnabled();
}

/** No API mutations or native-dialog stubs: these are the product's visible manual source inputs. */
export async function createBrowserKnowledgePod(page, region, documents) {
  const name = "Browser requirements documents";
  await page.getByRole("button", { name: "Local Knowledge", exact: true }).click();
  await page.getByRole("button", { name: "Create Knowledge Pod", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Create Knowledge Pod", exact: true });
  await expect(dialog.getByRole("textbox")).toHaveCount(1);
  for (const role of ["radio", "checkbox", "combobox"]) await expect(dialog.getByRole(role)).toHaveCount(0);
  await dialog.getByLabel("Knowledge Pod display name", { exact: true }).fill(name);
  const created = await responseAfter(page, "POST", "/api/local-knowledge/capsules", () =>
    dialog.getByRole("button", { name: "Create Knowledge Pod", exact: true }).click());
  assert.equal(created.status(), 201);
  assert.deepEqual(created.request().postDataJSON(), { displayName: name });
  const { capsule } = await created.json();
  await page.getByRole("heading", { name, exact: true }).waitFor();
  await connectBrowserSource(page, capsule.id, documents.root, documents.files);
  await connectBrowserSource(page, capsule.id, documents.folder);
  await indexedBrowserPod(page, capsule.id);
  await page.getByRole("button", { name: "Local Knowledge", exact: true }).click();
  await region.getByLabel("Grounding mode", { exact: true }).click();
  await page.getByRole("option", { name: `Knowledge Pod: ${name}`, exact: true }).click();
  await expect(region.getByLabel("Grounding mode", { exact: true })).toContainText(name);
  return capsule;
}
