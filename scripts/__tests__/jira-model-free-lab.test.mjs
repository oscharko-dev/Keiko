import {
  mkdtempSync,
  readdirSync,
  rmSync,
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { Buffer } from "node:buffer";
import { URL } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { withModelFreeJira, prepareModelFreeChat } from "../testing/jira-chat-lab/chat-read.mjs";
import {
  dispatchQualification,
  qualificationWitness,
} from "../testing/jira-chat-lab/api-qualification-runtime.mjs";
import { DEFAULT_LAB_CONNECTION } from "../testing/jira-chat-lab/lab-client.mjs";
import { runQualificationBatches } from "../testing/jira-chat-lab/api-qualification.mjs";
import { jiraOperationForTool } from "../../packages/keiko-server/dist/atlassian/jiraManagedProvider.js";

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

it("admits all 439 native contracts through the production selected provider", async () => {
  const directory = mkdtempSync(join(tmpdir(), "keiko-model-free-selection-"));
  const session = {
    ...DEFAULT_LAB_CONNECTION,
    directory,
    project: "keiko-jira-4081-unit",
    schemaVersion: 1,
    syntheticOnly: true,
  };
  try {
    await withModelFreeJira({
      session,
      run: async (context) => {
        const ledger = JSON.parse(
          readFileSync(
            new URL(
              "../../docs/local-knowledge/jira-api-coverage/operations.json",
              import.meta.url,
            ),
            "utf8",
          ),
        );
        const failures = [];
        for (const row of ledger.operations) {
          let selected;
          try {
            selected = await context.deps.jiraChatCatalog.select([row.identity]);
          } catch (error) {
            failures.push({ identity: row.identity, reason: error.reason, effect: error.effect });
            continue;
          }
          const operation = jiraOperationForTool(row.currentCapabilityIds[0]);
          expect(
            selected.catalog.descriptors.some(
              (descriptor) =>
                descriptor.toolRef.canonicalId ===
                operation.declaration.descriptor.toolRef.canonicalId,
            ),
          ).toBe(true);
          await selected.close();
        }
        expect(
          failures
            .map((failure) => `${failure.identity}: ${failure.reason}/${failure.effect}`)
            .join("\n"),
        ).toBe("");
      },
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 120000);

function syntheticNativeTransport(request, actor = "api") {
  const path = new URL(request.url).pathname;
  const bodies = {
    "/rest/api/2/serverInfo": {
      version: DEFAULT_LAB_CONNECTION.jiraVersion,
      versionNumbers: [10, 3, 26],
      deploymentType: "Data Center",
    },
    "/rest/api/2/myself": {
      name: `keiko-${actor}`,
      key: actor === "admin" ? "JIRAUSER10001" : "JIRAUSER10000",
      active: true,
    },
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

it.each([
  { actor: "api", administration: false, calls: 65 },
  { actor: "admin", administration: true, calls: 2 },
])(
  "dispatches successive model-free $actor turns through the real provider, authority and budget receipt",
  async ({ actor, administration, calls }) => {
    const directory = mkdtempSync(join(tmpdir(), "keiko-model-free-dispatch-"));
    const session = {
      ...DEFAULT_LAB_CONNECTION,
      directory,
      project: "keiko-jira-4081-unit",
      schemaVersion: 1,
      syntheticOnly: true,
    };
    mkdirSync(join(directory, "secrets"), { mode: 0o700 });
    writeFileSync(join(directory, "secrets", `${actor}-token`), "synthetic-unit-token", {
      mode: 0o600,
    });
    let dispatched = 0;
    try {
      await runQualificationBatches({
        session,
        specifications: Array.from({ length: calls }, (_, index) => index),
        witness: { decorate: () => () => (request) => syntheticNativeTransport(request, actor) },
        run: async (context, specifications) => {
          const chat = await prepareModelFreeChat(context, actor, administration);
          expect(chat.jiraAdministrationEnabled === true).toBe(administration);
          for (const specification of specifications) {
            expect(specification).toBe(dispatched++);
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
          ).toEqual(specifications.map(() => "completed"));
        },
      });
      expect(dispatched).toBe(calls);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

it("settles one model-free native effect in the production mutation journal and receipt", async () => {
  const directory = mkdtempSync(join(tmpdir(), "keiko-model-free-mutation-"));
  const session = {
    ...DEFAULT_LAB_CONNECTION,
    directory,
    project: "keiko-jira-4081-unit",
    schemaVersion: 1,
    syntheticOnly: true,
  };
  mkdirSync(join(directory, "secrets"));
  writeFileSync(join(directory, "secrets/api-token"), "synthetic-unit-token", { mode: 0o600 });
  let watching = false;
  const requests = [];
  const witness = qualificationWitness(session);
  const transport = async (request) => {
    const path = new URL(request.url).pathname;
    requests.push(`${request.method} ${path}`);
    let value;
    let status = 200;
    if (request.method === "GET" && /^\/rest\/api\/2\/issue\/(?:KEIKO-1|10001)$/u.test(path))
      value = {
        id: "10001",
        key: "KEIKO-1",
        fields: {
          summary: "Synthetic issue",
          project: { id: "10000", key: "KEIKO" },
          issuetype: { id: "10002" },
        },
      };
    else if (path === "/rest/api/2/mypermissions")
      value = {
        permissions: Object.fromEntries(
          ["BROWSE_PROJECTS", "EDIT_ISSUES", "MANAGE_WATCHERS"].map((key) => [
            key,
            { key, havePermission: true },
          ]),
        ),
      };
    else if (path === "/rest/api/2/issue/10001/watchers") {
      if (request.method === "POST") {
        watching = true;
        status = 204;
      } else {
        expect(request.method).toBe("GET");
        value = {
          watchCount: watching ? 1 : 0,
          isWatching: watching,
          watchers: watching ? [{ name: "keiko-api", active: true }] : [],
        };
      }
    } else return syntheticNativeTransport(request);
    const bodyText = value === undefined ? "" : JSON.stringify(value);
    return {
      kind: "response",
      status,
      bodyText,
      bodyBytes: Buffer.byteLength(bodyText),
      truncated: false,
    };
  };
  try {
    await withModelFreeJira({
      session,
      decorateAtlassianHttp: () =>
        witness.decorate((_metadata, _correlation, lifecycle) => async (request) => {
          if (lifecycle?.beforeDispatch !== undefined)
            expect(lifecycle.beforeDispatch(request)).toBe(true);
          const response = await transport(request);
          if (lifecycle?.onResponse !== undefined)
            expect(lifecycle.onResponse(request, response.status)).toBe(true);
          return response;
        }),
      run: async (context) => {
        const chat = await prepareModelFreeChat(context);
        witness.arm("POST /rest/api/2/issue/{issueIdOrKey}/watchers", true);
        const result = await dispatchQualification(
          context,
          chat,
          {
            tool: "jira.watch",
            mutation: true,
            identity: "POST /rest/api/2/issue/{issueIdOrKey}/watchers",
          },
          { issueKey: "KEIKO-1" },
        );
        expect(
          result.dispatch.result.status,
          JSON.stringify({
            requests,
            reason: result.dispatch.result.reason,
            data: result.dispatch.result.data,
            phase: result.journal?.phase,
            outcome: result.journal?.outcome,
          }),
        ).toBe("completed");
        expect(result.dispatch).toMatchObject({
          kind: "settled",
          result: { status: "completed", data: { outcome: "succeeded", isWatching: true } },
          receipt: { status: "completed", effectStarted: true, budgetDisposition: "committed" },
        });
        expect(result.journal).toMatchObject({
          phase: "settled",
          outcome: "succeeded",
          httpStatus: 204,
        });
        expect(witness.snapshot()).toMatchObject({
          blocked: 0,
          effects: 1,
          responses: [{ status: 204 }],
        });
        expect(watching).toBe(true);
      },
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
