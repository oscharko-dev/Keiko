import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as setup from "../testing/jira-chat-lab/browser-rules-knowledge-setup.mjs";

// Exercise the setup's actual UI protocol without starting a browser or an indexer.
vi.mock("@playwright/test", () => ({
  expect: Object.assign(
    (locator) => ({
      toHaveCount: async (count) => expect(await locator.count()).toBe(count),
      toContainText: async (text) => expect(await locator.textContent()).toContain(text),
      toBeEnabled: async () => expect(await locator.isEnabled()).toBe(true),
    }),
    { poll: (read) => ({ toBe: async (value) => expect(await read()).toBe(value) }) },
  ),
}));

const DOCUMENTS = [
  "lastenheft-kundenportal-zahlungsverkehr.md",
  "lastenheft-kundenportal-zahlungsverkehr.docx",
  "lastenheft-kundenportal-zahlungsverkehr.pdf",
];
const FIXTURE_ROOT = resolve(
  fileURLToPath(
    new URL("../../tests/fixtures/requirements/lastenheft-kundenportal/", import.meta.url),
  ),
);
const temporary = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function capsuleDetail(state, options) {
  const sourceCount = options.sourceCount ?? state.scopes.length;
  const documents = state.indexed ? (options.documentCount ?? 3) : 0;
  return {
    capsule: {
      id: "private-capsule-1",
      displayName: state.name,
      lifecycleState: state.indexed ? "ready" : "new",
      sourceIds: Array.from({ length: sourceCount }, (_, index) => `source-${String(index)}`),
    },
    sources: state.scopes.map((scope, index) => ({
      sourceId: `source-${String(index)}`,
      scope,
      indexedCount: documents,
      failedCount: 0,
      skippedCount: 0,
    })),
    health: {
      documentCount: documents,
      vectorCount: state.indexed ? 19 : 0,
      failedDocuments: 0,
      skippedDocuments: 0,
      unsupportedDocuments: 0,
      ...options.health,
    },
    indexingJobs: state.jobStarted
      ? [{ id: "private-job-1", status: options.jobStatus ?? "succeeded" }]
      : [],
  };
}

function uiFixture(options = {}) {
  const state = {
    name: "",
    scopes: [],
    fields: {},
    actions: [],
    responses: [],
    sourceSelectionVisible: false,
    indexed: false,
    jobStarted: false,
    grounding: "",
    failIndex: options.failIndex === true,
  };
  const waiting = [];
  function respond(method, path, body, status, data) {
    const response = {
      request: () => ({ method: () => method, postDataJSON: () => body }),
      url: () => `http://127.0.0.1:1983${path}`,
      status: () => status,
      json: async () => structuredClone(data),
    };
    state.responses.push({ method, path, body });
    const matching = waiting.filter((entry) => entry.predicate(response));
    if (matching.length === 0)
      throw new Error("UI response listener was not installed before the action");
    for (const entry of matching) {
      waiting.splice(waiting.indexOf(entry), 1);
      entry.resolve(response);
    }
  }
  async function click(role, name) {
    state.actions.push({ role, name });
    const capsulePath = "/api/local-knowledge/capsules/private-capsule-1";
    if (
      name === "Create Knowledge Pod" &&
      state.fields["Knowledge Pod display name"] !== undefined
    ) {
      state.name = state.fields["Knowledge Pod display name"];
      respond("POST", "/api/local-knowledge/capsules", { displayName: state.name }, 201, {
        capsule: capsuleDetail(state, options).capsule,
      });
    } else if (name === "Index only specific documents") {
      state.sourceSelectionVisible = true;
    } else if (name === "Connect") {
      const files = state.fields["Relative document paths"];
      const scope = files
        ? { kind: "files", rootPath: state.fields["Source path"], files: files.split("\n") }
        : { kind: "folder", rootPath: state.fields["Source path"], recursive: true };
      state.scopes.push(scope);
      respond("POST", `${capsulePath}/connection`, { scope }, 201, {});
    } else if (name === "Index this Knowledge Pod now") {
      if (state.failIndex) {
        state.failIndex = false;
        throw new Error("Private fixture error must never enter a public step result");
      }
      state.jobStarted = true;
      state.indexed = (options.jobStatus ?? "succeeded") === "succeeded";
      respond("POST", `${capsulePath}/index`, {}, 202, { jobId: "private-job-1" });
    } else if (role === "option") {
      state.grounding = name;
    }
  }
  function locator(role, name, scope = "page") {
    return {
      click: () => click(role, name),
      fill: async (value) => {
        state.fields[name] = value;
      },
      filter: ({ hasText }) => locator("summary", hasText),
      isVisible: async () => state.sourceSelectionVisible,
      isEnabled: async () => true,
      count: async () => (scope === "dialog" && role === "textbox" ? 1 : 0),
      textContent: async () => state.grounding,
      waitFor: async () => {
        if (role === "heading") expect(name).toBe(state.name);
      },
      getByRole: (childRole, { name: childName } = {}) => locator(childRole, childName, "dialog"),
      getByLabel: (childName) => locator("label", childName, "dialog"),
    };
  }
  const page = {
    getByRole: (role, { name } = {}) => locator(role, name),
    getByLabel: (name) => locator("label", name),
    locator: (selector) => locator(selector),
    waitForResponse: (predicate) =>
      new Promise((resolveResponse) => {
        waiting.push({ predicate, resolve: resolveResponse });
      }),
    request: {
      get: vi.fn(async (path) => {
        expect(path).toBe("/api/local-knowledge/capsules/private-capsule-1");
        return {
          status: () => 200,
          json: async () => structuredClone(capsuleDetail(state, options)),
        };
      }),
      post: vi.fn(() => {
        throw new Error("Setup must use visible UI controls");
      }),
    },
  };
  return { page, region: page, state };
}

function stepFixture(options) {
  const f = uiFixture(options);
  const records = [];
  const data = {};
  const intent = {
    path: "/private-session/browser-limit-run.pending.json",
    get state() {
      return structuredClone(data);
    },
    update: vi.fn((patch) => Object.assign(data, structuredClone(patch))),
    record: vi.fn((name, value) => {
      records.push({ name, value });
      data[name] = structuredClone(value);
    }),
  };
  return {
    ...f,
    records,
    ctx: {
      sessionDir: "/private-session",
      session: {},
      page: f.page,
      region: f.region,
      projectKey: "LIM7",
      locale: "en",
      modelId: "synthetic-gateway-model",
      intent,
      signal: new globalThis.AbortController().signal,
    },
  };
}

describe("Lastenheft UI Knowledge setup", () => {
  it("connects exactly the committed MD, DOCX and PDF through one Pod and selects its grounding", async () => {
    const f = uiFixture();
    const capsule = await setup.lastenheftDocuments(f.page, f.region);
    expect(capsule.id).toBe("private-capsule-1");
    expect(f.state.scopes).toEqual([{ kind: "files", rootPath: FIXTURE_ROOT, files: DOCUMENTS }]);
    expect(DOCUMENTS.map((name) => extname(name)).sort()).toEqual([".docx", ".md", ".pdf"]);
    for (const name of DOCUMENTS) expect(statSync(join(FIXTURE_ROOT, name)).isFile()).toBe(true);
    expect(JSON.stringify(f.state.scopes)).not.toContain("manifest.json");
    expect(f.state.responses.filter(({ path }) => path.endsWith("/index"))).toHaveLength(1);
    expect(f.state.grounding).toBe(`Knowledge Pod: ${f.state.name}`);
    expect(f.page.request.post).not.toHaveBeenCalled();
  });

  it("uses the configured fixture root and display name without connecting the containing folder", async () => {
    const f = uiFixture();
    await setup.lastenheftDocuments(f.page, f.region, {
      fixtureRoot: "/fixture-root/customer-portal",
      displayName: "Selected customer portal",
    });
    expect(f.state.name).toBe("Selected customer portal");
    expect(f.state.scopes).toEqual([
      { kind: "files", rootPath: "/fixture-root/customer-portal", files: DOCUMENTS },
    ]);
  });

  it("preserves the existing synthetic two-source and four-document setup contract", async () => {
    const directory = mkdtempSync(join(tmpdir(), "keiko-browser-knowledge-"));
    temporary.push(directory);
    const documents = setup.browserKnowledgeDocuments(directory);
    const f = uiFixture({ documentCount: 4 });
    await setup.createBrowserKnowledgePod(f.page, f.region, documents);
    expect(documents.names).toHaveLength(4);
    expect(f.state.scopes).toEqual([
      { kind: "files", rootPath: documents.root, files: documents.files },
      { kind: "folder", rootPath: documents.folder, recursive: true },
    ]);
    expect(f.state.name).toBe("Browser requirements documents");
  });

  it.each([
    { sourceCount: 2 },
    { documentCount: 4 },
    { health: { vectorCount: 0 } },
    { health: { failedDocuments: 1 } },
    { health: { skippedDocuments: 1 } },
    { health: { unsupportedDocuments: 1 } },
  ])(
    "does not select grounding for an index that violates the W4 contract: %j",
    async (options) => {
      const f = uiFixture(options);
      await expect(setup.lastenheftDocuments(f.page, f.region)).rejects.toThrow();
      expect(f.state.grounding).toBe("");
    },
  );

  it.each(["failed", "cancelled"])("does not retry a %s indexing job", async (jobStatus) => {
    const f = uiFixture({ jobStatus });
    await expect(setup.lastenheftDocuments(f.page, f.region)).rejects.toThrow();
    expect(f.state.responses.filter(({ path }) => path.endsWith("/index"))).toHaveLength(1);
    expect(f.state.grounding).toBe("");
  });
});

describe("stageLastenheft integrator contract", () => {
  it("returns actual public counts and keeps capsule identity in the existing private intent and evidence", async () => {
    const f = stepFixture();
    const result = await setup.stageLastenheft(f.ctx);
    expect(result).toEqual({
      step: "ac2-lastenheft",
      status: "green",
      detail: expect.any(String),
      counts: {
        podCount: 1,
        sourceCount: 1,
        documentCount: 3,
        vectorCount: 19,
        failedDocuments: 0,
        skippedDocuments: 0,
        unsupportedDocuments: 0,
      },
      evidenceFile: "/private-session/browser-limit-run.pending.json",
    });
    expect(JSON.stringify(result)).not.toContain("private-capsule-1");
    expect(JSON.stringify(result)).not.toContain(FIXTURE_ROOT);
    expect(f.ctx.intent.state.lastenheft.capsuleId).toBe("private-capsule-1");
    expect(
      f.records.some(
        ({ name, value }) => name === "lastenheft" && value.capsuleId === "private-capsule-1",
      ),
    ).toBe(true);
  });

  it("resumes the same ready Pod through the UI without recreating sources or repeating indexing", async () => {
    const f = stepFixture();
    expect((await setup.stageLastenheft(f.ctx)).status).toBe("green");
    f.state.grounding = "";
    expect((await setup.stageLastenheft(f.ctx)).status).toBe("green");
    expect(
      f.state.responses.filter(({ path }) => path === "/api/local-knowledge/capsules"),
    ).toHaveLength(1);
    expect(f.state.responses.filter(({ path }) => path.endsWith("/connection"))).toHaveLength(1);
    expect(f.state.responses.filter(({ path }) => path.endsWith("/index"))).toHaveLength(1);
    expect(f.state.grounding).toBe(`Knowledge Pod: ${f.state.name}`);
  });

  it("continues a recorded Pod after interrupted setup without creating another Pod or source", async () => {
    const f = stepFixture({ failIndex: true });
    const refused = await setup.stageLastenheft(f.ctx);
    expect(refused.status).toBe("red");
    expect(JSON.stringify(refused)).not.toContain("Private fixture error");
    expect(f.ctx.intent.state.lastenheft.capsuleId).toBe("private-capsule-1");
    expect((await setup.stageLastenheft(f.ctx)).status).toBe("green");
    expect(
      f.state.responses.filter(({ path }) => path === "/api/local-knowledge/capsules"),
    ).toHaveLength(1);
    expect(f.state.responses.filter(({ path }) => path.endsWith("/connection"))).toHaveLength(1);
  });

  it("refuses a resumed source that widened to the manifest before any further UI mutation", async () => {
    const f = stepFixture();
    await setup.stageLastenheft(f.ctx);
    f.state.scopes[0].files.push("manifest.json");
    const responses = f.state.responses.length;
    expect((await setup.stageLastenheft(f.ctx)).status).toBe("red");
    expect(f.state.responses).toHaveLength(responses);
  });

  it("reports missing browser context as unverified without claiming an indexed Pod", async () => {
    const f = stepFixture();
    const result = await setup.stageLastenheft({ ...f.ctx, region: undefined });
    expect(result.status).toBe("unverified");
    expect(Object.values(result.counts).every((count) => count === 0)).toBe(true);
    expect(f.state.responses).toHaveLength(0);
  });
});
