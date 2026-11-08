import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeCatalogSchemaMismatch } from "@oscharko-dev/keiko-tool-catalog";
import { canonicalise, sha256Hex } from "@oscharko-dev/keiko-security";
import { jiraSessionBindingForInput } from "@oscharko-dev/keiko-connectors";
import { privateJiraCustodyFixture } from "../../tests/support/jira-private-custody-fixture.ts";
import { jiraOperationForTool } from "../../packages/keiko-server/dist/atlassian/jiraManagedProvider.js";
import {
  createJiraPrivateLifetime,
  createJiraPrivatePorts,
} from "../../packages/keiko-server/dist/atlassian/httpPrivateIdentity.js";
import { createJiraChatMutationIntent } from "../../packages/keiko-server/dist/atlassian/jiraChatMutationIntent.js";
import { observeJiraChatMutation } from "../../packages/keiko-server/dist/atlassian/jiraChatToolTurn.js";
import { API_QUALIFICATION_ASSETS_CASES } from "../testing/jira-chat-lab/api-qualification-assets-cases.mjs";
import {
  assetPack,
  observeEmailPack,
  prepareAttachmentSource,
  qualificationEmailZip,
  requireEmailDefault,
} from "../testing/jira-chat-lab/api-qualification-assets-fixtures.mjs";
import {
  dispatchQualification,
  qualificationWitness,
  withQualificationLifetime,
  retainQualificationResult,
} from "../testing/jira-chat-lab/api-qualification-runtime.mjs";
import { createZip } from "../testing/jira-chat-lab/requirements/ooxml-zip.mjs";
import { DEFAULT_LAB_CONNECTION } from "../testing/jira-chat-lab/lab-client.mjs";

const sha = "a".repeat(64);
const selected = (tool) => API_QUALIFICATION_ASSETS_CASES.find((entry) => entry.tool === tool);
function state() {
  return {
    runId: "synthetic-run",
    projectId: "10000",
    issueTypeId: "10001",
    adminActorKey: "admin-key",
    assetIssueKey: "KEIKO-99",
    assetAttachment: { id: "7", filename: "qualification.docx", size: 3 },
    assetAttachmentFile: {
      source: { kind: "connected-file", path: "ac7-assets/qualification.docx" },
      expectedFile: { name: "qualification.docx", sizeBytes: 3, sha256: sha },
    },
    assetArchivePack: { entries: [{ path: "one" }, { path: "two" }] },
    assetDashboard: { id: "9", itemId: "11", name: "Synthetic AC7 dashboard" },
    assetEmailPrior: { manifestSha256: sha },
    assetEmailFile: {
      source: { kind: "connected-file", path: "ac7-assets/email-templates.zip" },
      expectedFile: { name: "email-templates.zip", sizeBytes: 3, sha256: sha },
    },
    assetEmailPack: { manifestSha256: sha },
  };
}
let directory;
let context;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "keiko-ac7-assets-"));
  mkdirSync(join(directory, "secrets"));
  writeFileSync(join(directory, "secrets/admin-password"), "synthetic-admin-password", {
    mode: 0o600,
  });
  context = { actor: "admin", session: { ...DEFAULT_LAB_CONNECTION, directory } };
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(directory, { recursive: true, force: true });
});
function native(reader) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (url, options) => {
    expect(options.method).toBe("GET");
    const value = reader(new globalThis.URL(url).pathname);
    return new globalThis.Response(JSON.stringify(value.body ?? value), {
      status: value.status ?? 200,
    });
  });
}

it("registers exactly the fourteen assigned unique native identities with valid real contracts", () => {
  const identities = new Set();
  const expectedTools = new Set([
    "jira.delete-attachment",
    "jira.attachment",
    "jira.attachment-archive-summary",
    "jira.attachment-archive",
    "jira.dashboard-item-property-keys",
    "jira.delete-dashboard-item-property",
    "jira.dashboard-item-property",
    "jira.set-dashboard-item-property",
    "jira.dashboard",
    "jira.email-template-pack",
    "jira.upload-email-template-pack",
    "jira.apply-email-template-pack",
    "jira.revert-email-template-pack",
    "jira.attach",
  ]);
  for (const entry of API_QUALIFICATION_ASSETS_CASES) {
    expect(expectedTools.delete(entry.tool), entry.tool).toBe(true);
    const operation = jiraOperationForTool(entry.tool);
    expect(operation, entry.tool).toBeDefined();
    expect(identities.has(operation.binding.identity)).toBe(false);
    identities.add(operation.binding.identity);
    expect(
      describeCatalogSchemaMismatch(
        operation.declaration.descriptor.inputSchema,
        entry.arguments(state()),
      ),
      entry.tool,
    ).toBeUndefined();
    expect(entry).toMatchObject({ actor: "admin", administration: true });
    if (entry.mutation) expect(entry.destructiveAdministration).toBe(true);
  }
  expect(expectedTools.size).toBe(0);
  expect(identities.size).toBe(14);
});

it("requires the returned attachment ID to belong to its same readable issue and exact source", async () => {
  const f = state();
  let rows = [{ id: "7" }];
  let size = 3;
  native((path) =>
    path.includes("/issue/")
      ? { key: f.assetIssueKey, fields: { attachment: rows } }
      : { id: "7", filename: "qualification.docx", size },
  );
  const recipe = selected("jira.attach");
  await expect(recipe.readback(context, { attachmentId: "7" }, f)).resolves.toEqual({
    matched: true,
    assertionCount: 7,
  });
  rows = [];
  await expect(recipe.readback(context, { attachmentId: "7" }, f)).rejects.toThrow();
  rows = [{ id: "7" }];
  size = 4;
  await expect(recipe.readback(context, { attachmentId: "7" }, f)).rejects.toThrow();
});

it("refuses an attachment deletion when the independently readable issue still lists the ID", async () => {
  const f = state();
  let rows = [{ id: "7" }];
  native(() => ({ key: f.assetIssueKey, fields: { attachment: rows } }));
  const recipe = selected("jira.delete-attachment");
  await expect(recipe.readback(context, { attachmentId: "7" }, f)).rejects.toThrow();
  rows = [];
  await expect(recipe.readback(context, { attachmentId: "7" }, f)).resolves.toMatchObject({
    matched: true,
  });
  expect(f.assetAttachment).toBeUndefined();
});

it("rejects an empty archive preview and requires the complete known nonempty fixture count", async () => {
  const f = state();
  let entries = [
    { entryIndex: 0, name: "one" },
    { entryIndex: 1, name: "two" },
  ];
  let totalEntryCount = 2;
  native(() => ({ entries, totalEntryCount }));
  const recipe = selected("jira.attachment-archive");
  const data = () => ({
    attachmentId: "7",
    items: entries,
    totalEntryCount,
    entriesComplete: true,
  });
  await expect(recipe.readback(context, data(), f)).resolves.toMatchObject({ matched: true });
  entries = [];
  totalEntryCount = 0;
  await expect(recipe.readback(context, data(), f)).rejects.toThrow();
});

it("compares the actual native human archive identity and source entry count", async () => {
  const f = state();
  let totalEntryCount = 2;
  native(() => ({
    id: 7,
    name: "qualification.docx",
    mediaType: "application/zip",
    totalEntryCount,
  }));
  const data = {
    attachmentId: "7",
    name: "qualification.docx",
    mediaType: "application/zip",
    totalEntryCount: 2,
  };
  const recipe = selected("jira.attachment-archive-summary");
  await expect(recipe.readback(context, data, f)).resolves.toMatchObject({ matched: true });
  totalEntryCount = 1;
  await expect(recipe.readback(context, data, f)).rejects.toThrow();
});

it("requires a real dashboard/item fixture before issuing a property effect", async () => {
  native(() => ({ key: "admin-key", name: "keiko-admin" }));
  await expect(
    selected("jira.set-dashboard-item-property").prepare(context, { runId: "synthetic-run" }),
  ).rejects.toThrow("actual disposable dashboard/item");
});

it("checks same-dashboard/item property presence, exact value and projected typed nodes", async () => {
  const f = state();
  const key = "keiko-ac7-assets-synthetic-run";
  let value = "Synthetic AC7 dashboard synthetic-run";
  native((path) => {
    if (path === "/rest/api/2/myself") return { key: "admin-key", name: "keiko-admin" };
    if (path.endsWith("/properties")) return { keys: [{ key }] };
    if (path.endsWith(`/properties/${key}`)) return { key, value };
    return { id: "9", name: f.assetDashboard.name };
  });
  const data = {
    dashboardId: "9",
    selectedItemId: "11",
    propertyKey: key,
    items: [{ path: "", kind: "string", textValue: value }],
  };
  const recipe = selected("jira.dashboard-item-property");
  await expect(recipe.readback(context, data, f)).resolves.toMatchObject({ matched: true });
  value = "foreign property";
  await expect(recipe.readback(context, data, f)).rejects.toThrow();
});

it("independently inspects the complete raw email ZIP and rejects a forged projected manifest", async () => {
  const zip = createZip([{ name: "templates/issue.vm", data: "Synthetic notification" }]);
  const pack = await assetPack(zip);
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, options) => {
    expect(options.method).toBe("GET");
    return new globalThis.Response(zip, { status: 200 });
  });
  const data = {
    ...pack,
    items: pack.entries,
    entryCount: pack.entries.length,
    selectionScope: "complete-exported-email-template-pack",
  };
  const recipe = selected("jira.email-template-pack");
  await expect(recipe.readback(context, data)).resolves.toMatchObject({ matched: true });
  await expect(recipe.readback(context, { ...data, manifestSha256: sha })).rejects.toThrow();
  expect(fetch).toHaveBeenCalledTimes(2);
});

it("refuses malformed or empty native email exports instead of proving a bare 200", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new globalThis.Response("not a ZIP", { status: 200 }),
  );
  await expect(observeEmailPack(context)).rejects.toThrow();
  await expect(assetPack(createZip([]))).rejects.toThrow();
});

it("binds exact generated document paths through the real Files API for each current Chat", async () => {
  const f = state();
  context.projectPath = join(directory, "workspace");
  mkdirSync(context.projectPath);
  context.origin = "http://127.0.0.1:1983";
  context.cookie = "synthetic-paired-cookie";
  context.qualificationChat = { id: "first-chat" };
  context.deps = { store: { findChatById: () => ({ connectedScopes: [] }) } };
  const chats = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, options) => {
    expect(options.method).toBe("PATCH");
    expect(options.headers["X-Keiko-CSRF"]).toBe("1");
    chats.push(new globalThis.URL(url).searchParams.get("id"));
    const body = JSON.parse(options.body);
    expect(body.connectedScopes[0].kind).toBe("files");
    expect(body.connectedScopes[0].relativePaths).toHaveLength(1);
    return new globalThis.Response(JSON.stringify({ chat: body }), { status: 200 });
  });
  await prepareAttachmentSource(context, f);
  expect(f.assetAttachmentFile.source.path).toMatch(/\.docx$/u);
  expect(
    readFileSync(join(context.projectPath, f.assetAttachmentFile.source.path)).byteLength,
  ).toBe(f.assetAttachmentFile.expectedFile.sizeBytes);
  expect(f.assetArchivePack.entries.length).toBeGreaterThan(0);
  context.qualificationChat = { id: "second-chat" };
  await prepareAttachmentSource(context, f);
  expect(chats).toEqual(["first-chat", "second-chat"]);
});

it("rejects duplicate, self-referential and over-budget auxiliaries before minting turn authority", async () => {
  const operation = jiraOperationForTool("jira.dashboard");
  const base = { tool: "jira.dashboard", identity: operation.definition.identity };
  for (const prerequisiteTools of [
    ["jira.login", "jira.login"],
    ["jira.dashboard"],
    Array.from({ length: 1000 }, (_, index) => `jira.synthetic-${index}`),
  ])
    await expect(
      dispatchQualification({}, {}, { ...base, prerequisiteTools }, {}),
    ).rejects.toThrow();
});

it("preserves the primary witness while admitting only the canonical fixed logout during cleanup", async () => {
  const witness = qualificationWitness(context.session);
  const transport = vi.fn().mockResolvedValue({
    kind: "response",
    status: 204,
    truncated: false,
    bodyBytes: 0,
    bodyText: "",
  });
  const port = witness.decorate(() => transport)({}, "correlation", {});
  const base = "https://127.0.0.1:18443";
  witness.arm("DELETE /rest/api/2/attachment/{id}", true);
  await port({ method: "DELETE", url: `${base}/rest/api/2/attachment/7` });
  const frozen = witness.snapshot();
  const cleanup = witness.decorate(() => transport)({}, "correlation", {
    canonicalPrivateFinalizer: true,
  });
  await cleanup({ method: "DELETE", url: `${base}/rest/auth/1/session` });
  expect(witness.snapshot()).toEqual(frozen);
  await expect(cleanup({ method: "DELETE", url: `${base}/rest/auth/1/session` })).rejects.toThrow(
    "single use",
  );
  await expect(port({ method: "POST", url: `${base}/rest/auth/1/session` })).rejects.toThrow(
    "unexpected or repeated native effect",
  );
  expect(transport).toHaveBeenCalledTimes(2);
});

it("always drains the real private lifetime exactly once and closes the catalog after hook failure", async () => {
  const order = [];
  const lifetime = createJiraPrivateLifetime(
    new globalThis.AbortController().signal,
    "qualification-test",
  );
  lifetime.register(async () => {
    order.push("session-finalizer");
  });
  const finish = vi.fn(() => lifetime.finish());
  const prepared = {
    humanInput: {
      finish: vi.fn(() => {
        order.push("input-finalizer");
      }),
    },
    privateLifetime: { finish },
  };
  const managed = {
    close: vi.fn(async () => {
      order.push("catalog-close");
    }),
  };
  await expect(
    withQualificationLifetime(prepared, undefined, managed, async () => {
      throw new TypeError("held hook failed");
    }),
  ).rejects.toThrow("held hook failed");
  expect(order).toEqual(["input-finalizer", "session-finalizer", "catalog-close"]);
  expect(finish).toHaveBeenCalledOnce();
  await lifetime.finish();
  expect(order.filter((entry) => entry === "session-finalizer")).toHaveLength(1);
});

it("changes each staged synthetic email pack when the same run continues across batches", async () => {
  const prior = await assetPack(
    createZip([{ name: "templates/issue.vm", data: "Native default" }]),
  );
  const f = state();
  const first = await assetPack(qualificationEmailZip(prior, f));
  const second = await assetPack(qualificationEmailZip(first, f));
  expect(first.manifestSha256).not.toBe(prior.manifestSha256);
  expect(second.manifestSha256).not.toBe(first.manifestSha256);
  expect(f.assetEmailSequence).toBe(2);
});

it("refuses to infer default templates and binds the explicit baseline to the native image", async () => {
  await expect(requireEmailDefault(context, state())).rejects.toThrow(
    "verified default email pack",
  );
  const zip = createZip([{ name: "templates/issue.vm", data: "Native default" }]);
  const pack = await assetPack(zip);
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => new globalThis.Response(zip));
  context.qualificationEmailDefaultOracle = async () => ({ ...pack, manifestSha256: sha });
  await expect(requireEmailDefault(context, state())).rejects.toThrow();
  context.qualificationEmailDefaultOracle = async () => pack;
  const f = state();
  await requireEmailDefault(context, f);
  expect(f.assetEmailDefault.manifestSha256).toBe(pack.manifestSha256);
  context.session = { ...context.session, jiraVersion: "10.4.0" };
  await expect(requireEmailDefault(context, f)).rejects.toThrow();
});

it("requires revert to change a distinct synthetic pack back to the complete verified default", async () => {
  const zip = createZip([{ name: "templates/issue.vm", data: "Native default" }]);
  const defaults = await assetPack(zip);
  const f = state();
  f.assetEmailDefault = defaults;
  f.assetEmailPrior = await assetPack(qualificationEmailZip(defaults, f));
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url) =>
    String(url).endsWith("/email-templates")
      ? new globalThis.Response(zip)
      : globalThis.Response.json({ key: f.adminActorKey }),
  );
  const data = {
    userKey: f.adminActorKey,
    emailTemplateAction: "revert",
    priorManifestSha256: f.assetEmailPrior.manifestSha256,
    observedManifestSha256: defaults.manifestSha256,
  };
  const recipe = selected("jira.revert-email-template-pack");
  await expect(recipe.readback(context, data, f)).resolves.toMatchObject({ matched: true });
  f.assetEmailPrior = defaults;
  await expect(
    recipe.readback(context, { ...data, priorManifestSha256: defaults.manifestSha256 }, f),
  ).rejects.toThrow();
});

it("preserves protected-input journal outcomes using the same revision as the product consumer", () => {
  const operation = jiraOperationForTool("jira.login");
  const revision = "2c33b462-e2ac-4d5c-9cef-23f8256b6775";
  const message = { id: "message-1", chatId: "chat-1", canonicalTurnRef: "turn-1" };
  const call = { id: "call-1", name: "jira_login", arguments: { expectedActorKey: "admin-key" } };
  const actionId = sha256Hex(canonicalise({ messageId: message.id, callId: call.id }));
  const authority = {
    reference: { runId: "run-1", envelopeDigest: sha },
    envelope: {
      subject: {
        chatId: message.chatId,
        actorDigest: "actor-1",
        podId: "pod-1",
        bindingGeneration: 1,
        authenticationGeneration: 1,
      },
    },
  };
  const intent = createJiraChatMutationIntent(
    message,
    authority.envelope.subject,
    authority.reference,
    {
      tool: "jira.login",
      actionId,
      idempotencyKey: actionId,
      argumentsDigest: sha256Hex(canonicalise(call.arguments)),
      operationBinding: operation.binding,
      humanInputRevision: revision,
    },
    "correlation-1",
  );
  const record = { ...intent, phase: "settled", outcome: "succeeded", httpStatus: 200 };
  const updateChatToolTranscript = vi.fn();
  const deps = { store: { chatToolMutations: { find: () => record }, updateChatToolTranscript } };
  const options = {
    message,
    authority,
    deps,
    correlationId: "correlation-1",
    managed: { projection: { projectionDigest: sha } },
  };
  const result = {
    toolRef: operation.declaration.descriptor.toolRef,
    status: "completed",
    effectStarted: true,
    data: { outcome: "succeeded", operationBinding: operation.binding },
  };
  // Negative control: the old missing-revision observation loses the real durable outcome.
  expect(observeJiraChatMutation(options, call, actionId, result)).toBeUndefined();
  const review = {
    sourcePreparation: { sourceDigestFor: () => undefined },
    humanInput: { revisionFor: () => revision },
  };
  retainQualificationResult(
    { deps },
    { options, call, actionId, review, operation },
    { kind: "settled", result, receipt: {} },
    { acceptReceipt: vi.fn() },
  );
  expect(updateChatToolTranscript.mock.calls[0][1].mutationOutcome).toBe("succeeded");
});

async function cleanupFixture(failedLogin) {
  const baseUrl = "https://127.0.0.1:18443";
  const custody = privateJiraCustodyFixture("jira.login", sha, {
    baseUrl,
    actorKey: "admin-key",
    actorUsername: "keiko-admin",
  });
  const scope = jiraSessionBindingForInput(custody.binding);
  const cookie = { name: "JSESSIONID", value: "synthetic-private-cookie" };
  const controller = new globalThis.AbortController();
  const witness = qualificationWitness(context.session);
  const fetchImpl = vi.fn(async (url, init) => {
    const path = new globalThis.URL(url).pathname;
    if (init.method === "DELETE") return new globalThis.Response(null, { status: 204 });
    if (init.method === "POST") return globalThis.Response.json({ session: cookie });
    if (path.endsWith("/myself")) {
      const key =
        failedLogin && new globalThis.Headers(init.headers).has("cookie")
          ? "foreign-key"
          : "admin-key";
      return globalThis.Response.json({ key, name: "keiko-admin" });
    }
    return globalThis.Response.json({ name: "keiko-admin" });
  });
  const options = {
    baseUrl,
    authRef: custody.binding.authRef,
    credentials: custody.executionResolver,
    fetchImpl,
    targetAdmission: async () => ({ baseUrl, addressClass: "loopback" }),
  };
  let selection;
  if (failedLogin) {
    const pending = custody.inputs.prepare(custody.binding);
    const ready = custody.inputs.submit(pending.requestId, custody.binding, pending.revision, {
      password: "synthetic-human-password",
    });
    selection = { requestId: ready.requestId, revision: ready.revision, binding: custody.binding };
  } else
    await custody.sessions.withLease(scope, async (session) => {
      session.establish(cookie);
    });
  const ports = createJiraPrivatePorts(
    options,
    options,
    {
      invocationId: "call-1",
      correlationId: "correlation-1",
      signal: controller.signal,
      beforeEffect: () => true,
    },
    {
      selection,
      sessionScope: scope,
      decorateHttpBodyPort: (port, observation) =>
        witness.decorate(() => port)({}, "correlation-1", {
          canonicalPrivateFinalizer: observation.kind === "session-finalizer",
        }),
    },
  );
  return { ports, witness, controller, fetchImpl };
}

it.each([false, true])(
  "admits only real canonical private cleanup before outer finally, failed login=%s",
  async (failedLogin) => {
    const f = await cleanupFixture(failedLogin);
    f.witness.arm("POST /rest/auth/1/session", true);
    if (failedLogin) {
      expect(await f.ports.identity.perform("login", {})).toMatchObject({ ok: false });
    } else {
      await f.ports.withAvatarSession("admin-key", async () => ({
        ok: false,
        reason: "unavailable",
      }));
      f.controller.abort();
    }
    await f.ports.finish();
    expect(f.fetchImpl.mock.calls.filter(([, init]) => init.method === "DELETE")).toHaveLength(1);
    expect(f.witness.snapshot().blocked).toBe(0);
    expect(f.witness.snapshot().effects).toBe(failedLogin ? 1 : 0);
  },
);
