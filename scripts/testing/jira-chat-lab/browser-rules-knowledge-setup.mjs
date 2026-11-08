import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { basename, join, resolve } from "node:path";
import { copyFileSync, mkdirSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { expect } from "@playwright/test";
import { writeCorpusDocuments } from "./requirements/corpus-documents.mjs";
import { gradeTemplateListing, gradeTemplateValidation } from "./requirements/templates.mjs";

/** The response an action causes; a failed action never leaves the response wait unobserved. */
export async function responseAfter(page, method, path, action) {
  const pending = page.waitForResponse(
    (response) =>
      response.request().method() === method && new URL(response.url()).pathname === path,
  );
  const [response] = await Promise.all([pending, action()]);
  return response;
}

/**
 * Every Jira template list read and automatic template check the Skills dialog makes while it is
 * watched. Each read keeps the request sequence it was issued at, so a read can be told apart from
 * one that predates a store change.
 */
export function watchTemplateReads(page) {
  let sequence = 0;
  const issued = new WeakMap();
  const lists = [];
  const checks = [];
  const onRequest = (request) => issued.set(request, ++sequence);
  const onResponse = (response) => {
    const request = response.request();
    const path = new URL(response.url()).pathname;
    const read = {
      response,
      issuedAt: issued.get(request) ?? 0,
      body: response.json().catch(() => undefined),
    };
    if (request.method() === "GET" && path === "/api/skills/jira-templates") lists.push(read);
    if (request.method() === "POST" && path === "/api/skills/jira-templates/validate")
      checks.push(read);
  };
  page.on("request", onRequest);
  page.on("response", onResponse);
  return {
    mark: () => sequence,
    lists,
    checks,
    stop: () => {
      page.off("request", onRequest);
      page.off("response", onResponse);
    },
  };
}

/** The newest watched read that satisfies the predicate, once the dialog has made one. */
async function awaitRead(reads, accept) {
  let found;
  await expect
    .poll(
      async () => {
        for (const read of reads) if (await accept(read)) found = read;
        return found !== undefined;
      },
      { timeout: 60_000 },
    )
    .toBe(true);
  return found;
}

/** The newest template list issued after the store changed at `mark`. */
export async function listedAfter(watch, mark, accept = () => true) {
  const read = await awaitRead(
    watch.lists,
    async (entry) => entry.issuedAt > mark && accept((await entry.body)?.templates ?? []),
  );
  assert.equal(read.response.status(), 200);
  return (await read.body).templates;
}

/**
 * The automatic check of one stored template: the dialog validates each listed template against
 * the selected Jira Pod by itself and shows the outcome in the template's row.
 */
export async function checkedTemplate(dialog, watch, skill, markdown, formal) {
  const check = await awaitRead(
    watch.checks,
    async (entry) => entry.response.request().postDataJSON()?.markdown === markdown,
  );
  assert.equal(check.response.status(), 200);
  if (formal.parentIssueTypes !== undefined)
    assert.ok(
      markdown.includes(
        `parentIssueTypes: [${formal.parentIssueTypes.map((type) => JSON.stringify(type)).join(", ")}]`,
      ),
      "Validation must use the stored uploaded parent-type clause",
    );
  assert.equal(gradeTemplateValidation(await check.body).ok, true);
  await skillRow(dialog, skill)
    .getByText(`${formal.project} · ${formal.issueType} — Matches Jira.`, { exact: true })
    .waitFor();
}

function skillRow(dialog, skill) {
  return dialog.getByRole("listitem").filter({ hasText: skill.name });
}

/** Closes the Skills dialog when a step left it open, so a failure never blocks the window. */
export async function closeSkillsIfOpen(dialog) {
  if (await dialog.isVisible())
    await dialog.getByRole("button", { name: "Close skills", exact: true }).click();
}

export async function openSkills(page, region) {
  await region.getByRole("button", { name: "Skills", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Skills", exact: true });
  await dialog.waitFor();
  return dialog;
}

export async function uploadBrowserSkill(page, region, markdown, fileName, formal) {
  const watch = watchTemplateReads(page);
  const dialog = await openSkills(page, region);
  try {
    const uploaded = await responseAfter(page, "POST", "/api/skills", () =>
      // The import control names its accepted files in its tooltip; its label reads "Import".
      dialog.getByLabel("Import", { exact: true }).setInputFiles({
        name: fileName,
        mimeType: "text/markdown",
        buffer: Buffer.from(markdown),
      }),
    );
    assert.equal(uploaded.status(), 201);
    const stored = watch.mark();
    const { skill } = await uploaded.json();
    if (formal) await installedTemplate(dialog, watch, stored, { skill, markdown, formal });
    else await selectedProseSkill(dialog, watch, stored, skill);
    return skill;
  } finally {
    watch.stop();
    await closeSkillsIfOpen(dialog);
  }
}

async function installedTemplate(dialog, watch, stored, { skill, markdown, formal }) {
  const templates = await listedAfter(watch, stored, (listed) =>
    listed.some((entry) => entry.id === skill.id),
  );
  assert.deepEqual(gradeTemplateListing(templates, skill, formal), {
    defined: true,
    activated: true,
  });
  await checkedTemplate(dialog, watch, skill, markdown, formal);
}

async function selectedProseSkill(dialog, watch, stored, skill) {
  const row = skillRow(dialog, skill);
  await row.getByRole("button", { name: "Use in this chat", exact: true }).click();
  await row.getByRole("button", { name: "Active in this chat", exact: true }).waitFor();
  const templates = await listedAfter(watch, stored);
  assert.equal(
    templates.some((entry) => entry.id === skill.id),
    false,
    "The active prose skill must not appear as a formal template",
  );
}

export async function removeBrowserSkill(page, region, skill) {
  const dialog = await openSkills(page, region);
  try {
    const row = skillRow(dialog, skill);
    await row.getByRole("button").first().click();
    await dialog.getByRole("button", { name: "Delete", exact: true }).click();
    const deleted = await responseAfter(
      page,
      "DELETE",
      `/api/skills/${encodeURIComponent(skill.id)}`,
      () => dialog.getByRole("button", { name: "Delete skill", exact: true }).click(),
    );
    assert.ok(deleted.ok());
    await expect(row).toHaveCount(0);
  } finally {
    await closeSkillsIfOpen(dialog);
  }
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
  return {
    root: join(root, "rendered"),
    files,
    folder,
    names: rendered.map((path) => basename(path)),
  };
}

async function connectBrowserSource(page, capsuleId, scope) {
  const files = scope.kind === "files" ? scope.files : undefined;
  await page.getByLabel("Source path", { exact: true }).fill(scope.rootPath);
  const disclosure = page.locator("summary").filter({ hasText: "Index only specific documents" });
  if (files !== undefined) {
    if (!(await page.getByLabel("Relative document paths", { exact: true }).isVisible()))
      await disclosure.click();
    await page.getByLabel("Relative document paths", { exact: true }).fill(files.join("\n"));
  } else if (await page.getByLabel("Relative document paths", { exact: true }).isVisible()) {
    await page.getByLabel("Relative document paths", { exact: true }).fill("");
  }
  const response = await responseAfter(
    page,
    "POST",
    `/api/local-knowledge/capsules/${capsuleId}/connection`,
    () => page.getByRole("button", { name: "Connect", exact: true }).click(),
  );
  assert.equal(response.status(), 201);
  assert.deepEqual(response.request().postDataJSON().scope, scope);
}

function verifyBrowserPod(detail, expected, capsuleId) {
  assert.equal(detail.capsule.id, capsuleId);
  assert.equal(detail.capsule.lifecycleState, "ready");
  assert.equal(detail.capsule.sourceIds.length, expected.sourceCount);
  assert.equal(detail.sources.length, expected.sourceCount);
  for (const scope of expected.scopes)
    assert.equal(
      detail.sources.filter((source) => isDeepStrictEqual(source.scope, scope)).length,
      1,
    );
  assert.equal(detail.health.documentCount, expected.documentCount);
  assert.ok(Number.isSafeInteger(detail.health.vectorCount) && detail.health.vectorCount > 0);
  for (const key of ["failedDocuments", "skippedDocuments", "unsupportedDocuments"])
    assert.equal(detail.health[key], 0);
}

async function indexedBrowserPod(page, capsuleId, expected, previous) {
  const path = `/api/local-knowledge/capsules/${capsuleId}`;
  if (previous?.capsule.lifecycleState === "ready") {
    verifyBrowserPod(previous, expected, capsuleId);
    return previous;
  }
  let jobId = previous?.indexingJobs.find((job) => ["queued", "running"].includes(job.status))?.id;
  if (jobId === undefined) {
    expected.signal?.throwIfAborted();
    const admitted = await responseAfter(page, "POST", `${path}/index`, () =>
      page.getByRole("button", { name: "Index this Knowledge Pod now", exact: true }).click(),
    );
    assert.equal(admitted.status(), 202);
    ({ jobId } = await admitted.json());
  }
  assert.equal(typeof jobId, "string");
  let detail;
  await expect
    .poll(
      async () => {
        expected.signal?.throwIfAborted();
        const response = await page.request.get(path);
        assert.equal(response.status(), 200);
        detail = await response.json();
        const status = detail.indexingJobs.find((job) => job.id === jobId)?.status;
        assert.ok(status !== "failed" && status !== "cancelled", "Actual indexing must succeed");
        return status;
      },
      { timeout: 600000 },
    )
    .toBe("succeeded");
  verifyBrowserPod(detail, expected, capsuleId);
  await expect(
    page.getByRole("button", { name: "Index this Knowledge Pod now", exact: true }),
  ).toBeEnabled();
  return detail;
}

async function openedBrowserKnowledgePod(page, name, capsuleId, checkpoint) {
  await page.getByRole("button", { name: "Local Knowledge", exact: true }).click();
  if (capsuleId !== undefined) {
    const response = await page.request.get(`/api/local-knowledge/capsules/${capsuleId}`);
    assert.equal(response.status(), 200);
    const detail = await response.json();
    assert.equal(detail.capsule.id, capsuleId);
    assert.equal(detail.capsule.displayName, name);
    checkpoint?.(detail.capsule);
    await page
      .getByRole("button", { name: `Actions for Knowledge Pod ${name}`, exact: true })
      .click();
    await page
      .getByRole("menuitem", { name: `Open details for Knowledge Pod ${name}`, exact: true })
      .click();
    await page.getByRole("heading", { name, exact: true }).waitFor();
    return { capsule: detail.capsule, detail };
  }
  await page.getByRole("button", { name: "Create Knowledge Pod", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Create Knowledge Pod", exact: true });
  await expect(dialog.getByRole("textbox")).toHaveCount(1);
  for (const role of ["radio", "checkbox", "combobox"])
    await expect(dialog.getByRole(role)).toHaveCount(0);
  await dialog.getByLabel("Knowledge Pod display name", { exact: true }).fill(name);
  const created = await responseAfter(page, "POST", "/api/local-knowledge/capsules", () =>
    dialog.getByRole("button", { name: "Create Knowledge Pod", exact: true }).click(),
  );
  assert.equal(created.status(), 201);
  assert.deepEqual(created.request().postDataJSON(), { displayName: name });
  const { capsule } = await created.json();
  assert.equal(typeof capsule.id, "string");
  assert.equal(capsule.displayName, name);
  checkpoint?.(capsule);
  await page.getByRole("heading", { name, exact: true }).waitFor();
  return { capsule };
}

async function connectBrowserSources(page, capsuleId, scopes, previous, signal) {
  assert.ok(
    previous.every((source) => scopes.some((scope) => isDeepStrictEqual(scope, source.scope))),
  );
  for (const scope of scopes) {
    signal?.throwIfAborted();
    const matches = previous.filter((source) => isDeepStrictEqual(source.scope, scope));
    assert.ok(matches.length <= 1);
    if (matches.length === 0) await connectBrowserSource(page, capsuleId, scope);
  }
}

/** No API mutations or native-dialog stubs: these are the product's visible manual source inputs. */
export async function createBrowserKnowledgePod(page, region, documents, options = {}) {
  const name = options.displayName ?? "Browser requirements documents";
  const scopes = [
    {
      rootPath: documents.root,
      ...(documents.files === undefined
        ? { kind: "folder", recursive: true }
        : { kind: "files", files: documents.files }),
    },
  ];
  if (documents.folder !== undefined)
    scopes.push({ kind: "folder", rootPath: documents.folder, recursive: true });
  const expected = { sourceCount: 2, documentCount: 4, ...options, scopes };
  assert.equal(scopes.length, expected.sourceCount);
  options.signal?.throwIfAborted();
  const { capsule, detail } = await openedBrowserKnowledgePod(
    page,
    name,
    options.capsuleId,
    options.checkpoint,
  );
  await connectBrowserSources(page, capsule.id, scopes, detail?.sources ?? [], options.signal);
  const indexed = await indexedBrowserPod(page, capsule.id, expected, detail);
  options.onIndexed?.(indexed);
  options.signal?.throwIfAborted();
  await page.getByRole("button", { name: "Local Knowledge", exact: true }).click();
  await region.getByLabel("Grounding mode", { exact: true }).click();
  await page.getByRole("option", { name: `Knowledge Pod: ${name}`, exact: true }).click();
  await expect(region.getByLabel("Grounding mode", { exact: true })).toContainText(name);
  return capsule;
}

const LASTENHEFT_FILES = Object.freeze([
  "lastenheft-kundenportal-zahlungsverkehr.md",
  "lastenheft-kundenportal-zahlungsverkehr.docx",
  "lastenheft-kundenportal-zahlungsverkehr.pdf",
]);

function lastenheftSetup(options) {
  const fixtureRoot =
    options.fixtureRoot ??
    fileURLToPath(
      new URL("../../../tests/fixtures/requirements/lastenheft-kundenportal/", import.meta.url),
    );
  const displayName = options.displayName ?? "Customer portal requirements";
  assert.equal(typeof fixtureRoot, "string");
  assert.ok(fixtureRoot.trim().length > 0);
  assert.equal(typeof displayName, "string");
  assert.ok(displayName.trim().length > 0);
  return { fixtureRoot: resolve(fixtureRoot), displayName };
}

/** The existing customer-portal documents, explicitly selected without the fixture manifest. */
export async function lastenheftDocuments(page, region, options = {}) {
  const setup = lastenheftSetup(options);
  return createBrowserKnowledgePod(
    page,
    region,
    { root: setup.fixtureRoot, files: LASTENHEFT_FILES },
    {
      ...options,
      displayName: setup.displayName,
      sourceCount: 1,
      documentCount: 3,
    },
  );
}

function hasLastenheftBrowser(ctx) {
  return (
    ctx?.page &&
    ctx.region &&
    ctx.intent &&
    ctx.signal &&
    typeof ctx.intent.update === "function" &&
    typeof ctx.intent.record === "function"
  );
}

function lastenheftRunOptions(ctx, options, counts) {
  const setup = lastenheftSetup(options);
  const previous = ctx.intent.state.lastenheft;
  if (previous !== undefined) {
    assert.equal(previous.fixtureRoot, setup.fixtureRoot);
    assert.equal(previous.displayName, setup.displayName);
    assert.deepEqual(previous.files, LASTENHEFT_FILES);
    assert.equal(typeof previous.capsuleId, "string");
  }
  return {
    ...setup,
    capsuleId: previous?.capsuleId,
    signal: ctx.signal,
    checkpoint: (capsule) => {
      ctx.intent.update({
        lastenheft: { ...setup, files: [...LASTENHEFT_FILES], capsuleId: capsule.id },
      });
      counts.podCount = 1;
    },
    onIndexed: (detail) =>
      Object.assign(counts, {
        sourceCount: detail.capsule.sourceIds.length,
        documentCount: detail.health.documentCount,
        vectorCount: detail.health.vectorCount,
        failedDocuments: detail.health.failedDocuments,
        skippedDocuments: detail.health.skippedDocuments,
        unsupportedDocuments: detail.health.unsupportedDocuments,
      }),
  };
}

/**
 * @param {import("./limit-run-types.mjs").LimitBrowserContext} ctx
 * @returns {Promise<import("./limit-run-types.mjs").StepResult>}
 */
export async function stageLastenheft(ctx, options = {}) {
  const step = "ac2-lastenheft";
  const counts = {
    podCount: 0,
    sourceCount: 0,
    documentCount: 0,
    vectorCount: 0,
    failedDocuments: 0,
    skippedDocuments: 0,
    unsupportedDocuments: 0,
  };
  if (!hasLastenheftBrowser(ctx))
    return { step, status: "unverified", detail: "Knowledge browser context unavailable", counts };
  try {
    ctx.signal.throwIfAborted();
    await lastenheftDocuments(ctx.page, ctx.region, lastenheftRunOptions(ctx, options, counts));
    ctx.intent.record("lastenheft", { ...ctx.intent.state.lastenheft, counts: { ...counts } });
    return {
      step,
      status: "green",
      detail: "One Knowledge Pod; three indexed document formats",
      counts,
      ...(typeof ctx.intent.path === "string" ? { evidenceFile: ctx.intent.path } : {}),
    };
  } catch {
    return { step, status: "red", detail: "Lastenheft Knowledge setup failed", counts };
  }
}
