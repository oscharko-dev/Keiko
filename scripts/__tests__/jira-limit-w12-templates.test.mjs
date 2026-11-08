import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { memoryLimitIntent } from "./helpers/limit-run-intent.mjs";

const ports = vi.hoisted(() => ({
  upload: vi.fn(),
  read: vi.fn(),
  browser: vi.fn(),
  english: vi.fn(),
}));
vi.mock("../testing/jira-chat-lab/browser-rules-knowledge-setup.mjs", () => ({
  uploadBrowserSkill: ports.upload,
}));
vi.mock("../testing/jira-chat-lab/project-agile-oracles.mjs", () => ({
  projectAgileRead: ports.read,
}));

vi.mock("../testing/jira-chat-lab/limit-run-browser.mjs", () => ({
  resolveLimitBrowser: ports.browser,
}));
vi.mock("../testing/jira-chat-lab/limit-run-language.mjs", () => ({
  withEnglishLimitUi: ports.english,
}));

import { installTemplates } from "../testing/jira-chat-lab/templates.mjs";

import {
  runtimeTemplateProjectKey,
  templateMarkdown,
} from "../testing/jira-chat-lab/requirements/templates.mjs";
import { STRUCTURE_RULES } from "../testing/jira-chat-lab/requirements/corpus.mjs";

const roots = [];
const TYPES = ["Epic", "Task", "Bug", "Sub-task"];
const nativeProject = () => ({
  id: "912",
  key: "LIM7",
  issueTypes: TYPES.map((name) => ({ name, subtask: name === "Sub-task" })),
});
const nativeFields = () => [
  { id: "priority" },
  { id: "customfield_19472", schema: { custom: "com.pyxis.greenhopper.jira:gh-epic-link" } },
];

function fixture() {
  const sessionDir = mkdtempSync(join(tmpdir(), "keiko-w12-templates-"));
  roots.push(sessionDir);
  const controller = new globalThis.AbortController();
  const skills = new Map();
  const uploads = [];
  const region = { count: vi.fn().mockResolvedValue(1), getByRole: vi.fn() };
  const windows = { filter: vi.fn(() => region) };
  const page = {
    locator: vi.fn((selector) => (selector === '.window[data-top="true"]' ? windows : {})),
    request: { get: vi.fn() },
  };
  const ctx = {
    sessionDir,
    session: { fixture: true },
    page,
    projectKey: "LIM7",
    locale: "en",
    modelId: "fixture-model",
    chat: { id: "11111111-1111-4111-8111-111111111111", projectPath: "/synthetic/workspace" },
    signal: controller.signal,
    intent: memoryLimitIntent(),
  };
  ports.browser.mockResolvedValue({ page, region });
  ports.english.mockImplementation(async (_ctx, run) => run());
  ports.read.mockImplementation(async (_session, path) => {
    if (path === "/rest/api/2/project/LIM7") return nativeProject();
    if (path === "/rest/api/2/field") return nativeFields();
    throw new TypeError("Unexpected native read");
  });
  ports.upload.mockImplementation(async (actualPage, actualRegion, markdown, fileName, formal) => {
    expect(actualPage).toBe(page);
    expect(actualRegion).toBe(region);
    expect(ctx.intent.state["w12-templates"].phase).toBe("pending");
    const skill = {
      id: `msk_00000000-0000-4000-8000-${String(uploads.length + 1).padStart(12, "0")}`,
      revision: 1,
      digest: createHash("sha256").update(markdown).digest("hex"),
      body: markdown,
      name: fileName,
    };
    skills.set(skill.id, skill);
    uploads.push({ markdown, fileName, formal, skill });
    return skill;
  });
  page.request.get.mockImplementation(async (path) => ({
    status: () => 200,
    json: async () => ({ skill: skills.get(path.split("/").at(-1)) }),
  }));
  return { ctx, controller, skills, uploads, region, page };
}

function resumeUi(f, { valid = true } = {}) {
  let current;
  let listed = false;
  const row = {
    filter: () => row,
    count: async () => 1,
    getByRole: () => ({ click: async () => undefined }),
    getByText: () => ({ waitFor: async () => undefined }),
  };
  const dialog = {
    waitFor: async () => undefined,
    getByRole: vi.fn((role, options) => {
      if (role === "listitem")
        return {
          filter: ({ hasText }) => {
            current = [...f.skills.values()].find((skill) => skill.name === hasText);
            return row;
          },
        };
      if (options.name === "Jira issue templates")
        return {
          click: async () => {
            listed = true;
          },
        };
      return { click: async () => undefined };
    }),
  };
  f.region.getByRole.mockReturnValue({ click: async () => undefined });
  f.page.getByRole = vi.fn(() => dialog);
  f.page.waitForResponse = vi.fn(async (accept) => {
    const validation = listed;
    const path = validation ? "/api/skills/jira-templates/validate" : "/api/skills/jira-templates";
    const response = {
      status: () => 200,
      url: () => "http://127.0.0.1" + path,
      request: () => ({
        method: () => (validation ? "POST" : "GET"),
        postDataJSON: () => ({ markdown: current.body }),
      }),
      json: async () =>
        validation
          ? { valid, findings: [], checked: { project: true } }
          : {
              templates: f.uploads.map(({ formal, skill }) => ({
                id: skill.id,
                revision: skill.revision,
                valid: true,
                project: formal.project,
                issueType: formal.issueType,
                activations: ["create"],
              })),
            },
    };
    expect(accept(response)).toBe(true);
    return response;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("W12 runtime-bound template installation", () => {
  it("exports only the required async building block", async () => {
    expect(Object.keys(await import("../testing/jira-chat-lab/templates.mjs"))).toEqual([
      "installTemplates",
    ]);
  });

  it("installs exactly four templates using fresh project and native Epic Link metadata", async () => {
    const f = fixture();
    expect(await installTemplates(f.ctx)).toMatchObject({
      step: "w12-templates",
      status: "green",
      detail: "templates-installed",
      counts: { templates: 4, installed: 4, verified: 4 },
    });
    expect(f.uploads.map((entry) => entry.formal.issueType)).toEqual(TYPES);
    for (const upload of f.uploads) {
      expect(upload.markdown).toContain("project: LIM7\n");
      expect(upload.markdown).not.toContain("project: REQ");
    }
    for (const index of [1, 2])
      expect(f.uploads[index].markdown).toContain('parentField: "customfield_19472"');
    expect(f.uploads[2].markdown).toContain('requiredFields: ["priority"]');
    expect(f.uploads[3].markdown).toContain('parentField: "parent"');
    expect(f.uploads[3].markdown).toContain('parentIssueTypes: ["Task"]');
    expect(ports.read.mock.calls.map((args) => args[1])).toEqual([
      "/rest/api/2/project/LIM7",
      "/rest/api/2/field",
      "/rest/api/2/project/LIM7",
      "/rest/api/2/field",
    ]);
    expect(f.page.request.get).toHaveBeenCalledTimes(4);
    expect(f.ctx.intent.state["w12-templates"].phase).toBe("completed");
    expect(f.ctx.intent.records.some((record) => record.value.phase === "pending")).toBe(true);
    const evidence = JSON.stringify(f.ctx.intent.state["w12-templates"]);
    expect(evidence).not.toContain("## ");
    expect(evidence).not.toContain("fixture-model");
  });

  it.each([
    undefined,
    null,
    "",
    "REQ\nproject: OTHER",
    "../../REQ",
    "lim7",
    "LIM-7",
    "A".repeat(33),
  ])("refuses invalid runtime keys before UI or native ports: %j", async (projectKey) => {
    const f = fixture();
    await expect(installTemplates({ ...f.ctx, projectKey })).rejects.toThrow(
      "Invalid runtime template project key",
    );
    expect(ports.read).not.toHaveBeenCalled();
    expect(ports.upload).not.toHaveBeenCalled();
  });

  it("delegates German UI switching and restoration to the shared owner", async () => {
    const f = fixture();
    f.ctx.locale = "de";
    expect(await installTemplates(f.ctx)).toMatchObject({ status: "green" });
    expect(ports.english).toHaveBeenCalledWith(f.ctx, expect.any(Function));
    expect(ports.browser).toHaveBeenCalledWith(f.ctx, f.ctx.chat);
  });

  it("does not adopt an unprovided Chat or write a second intent file", async () => {
    const f = fixture();
    delete f.ctx.chat;
    expect(await installTemplates(f.ctx)).toMatchObject({ status: "unverified" });
    expect(ports.upload).not.toHaveBeenCalled();
    expect(f.ctx.intent).not.toHaveProperty("steps");
  });

  it("keeps existing lowercase builder inputs compatible", () => {
    expect(
      templateMarkdown({ project: "rpt", issueType: "Task", rule: STRUCTURE_RULES.Task }),
    ).toContain("project: rpt\n");
    expect(runtimeTemplateProjectKey("LIM7")).toBe("LIM7");
  });

  it.each(["missing-link", "duplicate-link", "missing-type", "wrong-project", "missing-priority"])(
    "fails closed before upload on unavailable native metadata: %s",
    async (fault) => {
      const f = fixture();
      ports.read.mockImplementation(async (_session, path) => {
        const project = nativeProject();
        const fields = nativeFields();
        if (fault === "missing-type") project.issueTypes.pop();
        if (fault === "wrong-project") project.key = "OTHER";
        if (path.includes("/project/")) return project;
        if (fault === "missing-link") return fields.slice(0, 1);
        if (fault === "duplicate-link") return [...fields, { ...fields[1], id: "customfield_2" }];
        if (fault === "missing-priority") return fields.slice(1);
        return fields;
      });
      expect(await installTemplates(f.ctx)).toMatchObject({
        status: "unverified",
        detail: "templates-native-metadata-unavailable",
      });
      expect(ports.upload).not.toHaveBeenCalled();
    },
  );

  it("does not replay an upload whose UI outcome is uncertain", async () => {
    const f = fixture();
    ports.upload.mockRejectedValueOnce(
      new TypeError("synthetic credential content must never be copied"),
    );
    const result = await installTemplates(f.ctx);
    expect(result).toMatchObject({ status: "red", detail: "templates-verification-failed" });
    expect(JSON.stringify(result)).not.toContain("credential");
    f.ctx.intent = memoryLimitIntent(f.ctx.intent.state);
    expect(await installTemplates(f.ctx)).toMatchObject({
      status: "unverified",
      detail: "templates-pending-unverified",
    });
    expect(ports.upload).toHaveBeenCalledTimes(1);
  });

  it("requires the final independent native readback to retain the same project and Epic field", async () => {
    const f = fixture();
    let projectReads = 0;
    ports.read.mockImplementation(async (_session, path) => {
      if (!path.includes("/project/")) return nativeFields();
      projectReads += 1;
      return { ...nativeProject(), id: projectReads === 1 ? "912" : "913" };
    });
    expect(await installTemplates(f.ctx)).toMatchObject({
      status: "red",
      detail: "templates-verification-failed",
    });
    expect(f.ctx.intent.state["w12-templates"].phase).toBe("pending");
    expect(ports.upload).toHaveBeenCalledTimes(4);
  });

  it("retains partial installation and stops after abort without replay", async () => {
    const f = fixture();
    const upload = ports.upload.getMockImplementation();
    ports.upload.mockImplementationOnce(async (...args) => {
      const value = await upload(...args);
      f.controller.abort();
      return value;
    });
    expect(await installTemplates(f.ctx)).toMatchObject({
      status: "unverified",
      detail: "templates-aborted",
      counts: { installed: 1 },
    });
    expect(ports.upload).toHaveBeenCalledTimes(1);
  });

  it("reverifies completed state through native reads and visible listing/validation, without upload", async () => {
    const f = fixture();
    await installTemplates(f.ctx);
    ports.upload.mockClear();
    ports.read.mockClear();
    f.ctx.intent = memoryLimitIntent(f.ctx.intent.state);
    resumeUi(f);
    expect(await installTemplates(f.ctx)).toMatchObject({
      status: "green",
      detail: "templates-reverified",
      counts: { installed: 4, verified: 4 },
    });
    expect(ports.upload).not.toHaveBeenCalled();
    expect(f.page.waitForResponse).toHaveBeenCalledTimes(5);
    expect(ports.read).toHaveBeenCalledTimes(4);
  });

  it("refuses stale completed proof when stored Markdown or current native validation changes", async () => {
    const f = fixture();
    await installTemplates(f.ctx);
    const first = f.skills.values().next().value;
    first.body += "\nchanged";
    expect(await installTemplates(f.ctx)).toMatchObject({
      status: "red",
      detail: "templates-verification-failed",
    });
    first.body = f.uploads[0].markdown;
    resumeUi(f, { valid: false });
    expect(await installTemplates(f.ctx)).toMatchObject({
      status: "red",
      detail: "templates-verification-failed",
    });
    expect(ports.upload).toHaveBeenCalledTimes(4);
  });
});
