import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withLiveChat, withModelFreeJira } from "../testing/jira-chat-lab/chat-read.mjs";
import { DEFAULT_LAB_CONNECTION } from "../testing/jira-chat-lab/lab-client.mjs";

const observed = vi.hoisted(() => ({ events: [], probe: false }));
const native = vi.hoisted(() => ({
  "/rest/api/2/project": [{ key: "REQ" }, { key: "ZR" }],
  "/rest/api/2/project/REQ/statuses": [{ name: "Epic" }, { name: "Task" }],
  "/rest/api/2/project/ZR/statuses": [{ name: "Sub-task" }],
}));

vi.mock("../testing/jira-chat-lab/run-preflight.mjs", () => ({
  prepareLabRun: async () => () => undefined,
}));
vi.mock("../testing/jira-chat-lab/lab-client.mjs", async (original) => ({
  ...(await original()),
  requireLicense: vi.fn(async () => 9000),
  basicAuth: vi.fn(() => "Basic lab"),
  labRequest: vi.fn(async (_session, _method, path) => {
    observed.events.push(`native-read ${path}`);
    return { status: path in native ? 200 : 404, value: structuredClone(native[path]) };
  }),
}));
vi.mock("../../packages/keiko-server/dist/gateway-tool-calling-probe.js", () => ({
  probeGatewayToolCalling: vi.fn(async () => {
    if (observed.probe) return "verified";
    throw new TypeError("No model probe is permitted");
  }),
}));

// The real product start with the real skill library routes and template parser: only Jira's
// native reads are doubled.
describe("the baseline on a real lab product start", () => {
  let directory;
  const session = () => ({
    ...DEFAULT_LAB_CONNECTION,
    directory,
    project: "keiko-jira-4081-unit",
    schemaVersion: 1,
    syntheticOnly: true,
  });
  const library = (context) =>
    context.deps.store.markdownSkills.jiraTemplates().map(({ skill, template }) => ({
      name: skill.name,
      project: template?.project,
      issueType: template?.issueType,
      activations: template?.activations.map((activation) => activation.kind),
    }));

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "keiko-baseline-product-"));
    vi.stubEnv("KEIKO_OS_KEYCHAIN", "off");
    vi.stubEnv("KEIKO_JIRA_LAB_BASELINE_TEMPLATES", undefined);
    observed.events.length = 0;
    observed.probe = false;
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  });

  it("seeds every project and issue type by default and names them as lab fixtures", async () => {
    let seen;
    await withModelFreeJira({
      session: session(),
      run: async (context) => (seen = library(context)),
    });
    expect(seen.map((entry) => `${entry.project}/${entry.issueType}`).sort()).toEqual([
      "REQ/Epic",
      "REQ/Task",
      "ZR/Sub-task",
    ]);
    for (const entry of seen) {
      expect(entry.name).toMatch(/^Lab baseline /u);
      expect(entry.activations).toEqual(["create", "edit"]);
    }
  });

  it("seeds nothing when the call opts out, although the env leaves it on", async () => {
    let seen;
    await withModelFreeJira({
      session: session(),
      baselineTemplates: false,
      run: async (context) => (seen = library(context)),
    });
    expect(seen).toEqual([]);
  });

  it("seeds nothing under the global env switch, and a per-call option does not override it", async () => {
    vi.stubEnv("KEIKO_JIRA_LAB_BASELINE_TEMPLATES", "off");
    let seen;
    await withModelFreeJira({
      session: session(),
      baselineTemplates: true,
      run: async (context) => (seen = library(context)),
    });
    expect(seen).toEqual([]);
  });

  it("fails the start as a lab error when Jira cannot be read, before the lane's run", async () => {
    delete native["/rest/api/2/project/ZR/statuses"];
    const run = vi.fn();
    try {
      await expect(withModelFreeJira({ session: session(), run })).rejects.toMatchObject({
        code: "jira-read",
      });
      expect(run).not.toHaveBeenCalled();
    } finally {
      native["/rest/api/2/project/ZR/statuses"] = [{ name: "Sub-task" }];
    }
  });

  it("reads Jira and seeds the library before the lane's first run step (model-free start)", async () => {
    let atRun;
    await withModelFreeJira({
      session: session(),
      run: async (context) => {
        observed.events.push("run");
        atRun = library(context).length;
      },
    });
    const first = observed.events.indexOf("run");
    expect(first).toBeGreaterThan(0);
    expect(observed.events.slice(0, first)).toEqual([
      "native-read /rest/api/2/project",
      "native-read /rest/api/2/project/REQ/statuses",
      "native-read /rest/api/2/project/ZR/statuses",
    ]);
    expect(atRun).toBe(3);
  });

  it("does the same on the in-process Chat start, and a per-call opt-out skips the reads", async () => {
    observed.probe = true;
    const seen = [];
    const run = async (context) => {
      observed.events.push("run");
      seen.push(library(context).length);
    };
    await withLiveChat({ session: session(), modelId: "lab-model", run });
    const first = observed.events.indexOf("run");
    expect(first).toBe(3);
    expect(seen).toEqual([3]);
    observed.events.length = 0;
    await withLiveChat({ session: session(), modelId: "lab-model", run, baselineTemplates: false });
    expect(observed.events).toEqual(["run"]);
    expect(seen).toEqual([3, 0]);
  });
});
