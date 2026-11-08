import { mkdtempSync, readdirSync, rmSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { Buffer } from "node:buffer";
import { URL } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { withModelFreeJira, prepareModelFreeChat } from "../testing/jira-chat-lab/chat-read.mjs";
import { dispatchQualification } from "../testing/jira-chat-lab/api-qualification-runtime.mjs";
import { DEFAULT_LAB_CONNECTION } from "../testing/jira-chat-lab/lab-client.mjs";

vi.mock("../testing/jira-chat-lab/lab-client.mjs", async (original) => ({
  ...(await original()),
  requireLicense: vi.fn(async () => 9000),
}));
vi.mock("../../packages/keiko-server/dist/gateway-tool-calling-probe.js", () => ({
  probeGatewayToolCalling: vi.fn(async () => {
    throw new TypeError("No model probe is permitted");
  }),
}));

it("uses the paired product server with an empty provider catalog and no model probe", async () => {
  const directory = mkdtempSync(join(tmpdir(), "keiko-model-free-lab-"));
  const session = {
    ...DEFAULT_LAB_CONNECTION,
    directory,
    project: "keiko-jira-4081-unit",
    schemaVersion: 1,
    syntheticOnly: true,
  };
  const paths = [];
  try {
    await withModelFreeJira({
      session,
      stateReady: (root) => paths.push(root),
      run: async (context) => {
        expect(context.cookie.length).toBeGreaterThan(0);
        expect(
          context.deps.store.listProjects().some((project) => project.path === context.projectPath),
        ).toBe(true);
        expect(context.deps.gatewayConfig.current()).toBeUndefined();
        expect(existsSync(join(context.root, "keiko.config.json"))).toBe(false);
      },
    });
    expect(paths).toHaveLength(1);
    expect(readdirSync(directory)).toContain("chat-read-logs");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

function syntheticNativeTransport(request) {
  const path = new URL(request.url).pathname;
  const bodies = {
    "/rest/api/2/serverInfo": {
      version: DEFAULT_LAB_CONNECTION.jiraVersion,
      versionNumbers: [10, 3, 26],
      deploymentType: "Data Center",
    },
    "/rest/api/2/myself": { name: "keiko-api", key: "JIRAUSER10000", active: true },
    "/rest/api/2/project": [{ id: "10000", key: "KEIKO", name: "Synthetic project" }],
  };
  expect(Object.hasOwn(bodies, path)).toBe(true);
  expect(request.method).toBe("GET");
  const bodyText = JSON.stringify(bodies[path]);
  return Promise.resolve({
    kind: "response",
    status: 200,
    bodyText,
    bodyBytes: Buffer.byteLength(bodyText),
    truncated: false,
  });
}

it("dispatches successive model-free turns through the real provider, authority and budget receipt", async () => {
  const directory = mkdtempSync(join(tmpdir(), "keiko-model-free-dispatch-"));
  const session = {
    ...DEFAULT_LAB_CONNECTION,
    directory,
    project: "keiko-jira-4081-unit",
    schemaVersion: 1,
    syntheticOnly: true,
  };
  mkdirSync(join(directory, "secrets"), { mode: 0o700 });
  writeFileSync(join(directory, "secrets", "api-token"), "synthetic-unit-token", { mode: 0o600 });
  try {
    await withModelFreeJira({
      session,
      decorateAtlassianHttp: () => () => syntheticNativeTransport,
      run: async (context) => {
        const chat = await prepareModelFreeChat(context, "api");
        for (let call = 0; call < 2; call += 1) {
          const result = await dispatchQualification(
            context,
            chat,
            { tool: "jira.projects", identity: "GET /rest/api/2/project" },
            {},
          );
          expect(result.dispatch.kind).toBe("settled");
          expect(result.dispatch.result).toMatchObject({
            status: "completed",
            data: {
              outcome: "succeeded",
              items: [{ id: "10000", key: "KEIKO", name: "Synthetic project" }],
            },
          });
          expect(result.dispatch.receipt).toMatchObject({
            effectStarted: true,
            budgetDisposition: "committed",
          });
          expect(result.mutation).toBe(false);
          expect(result.journal).toBeUndefined();
        }
        expect(
          context.deps.store
            .listMessages(chat.id)
            .filter((message) => message.role === "user")
            .map((message) => message.turnState),
        ).toEqual(["completed", "completed"]);
      },
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
