import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  checkJiraManagedMutation,
  createJiraManagedProvider,
  type AtlassianHttpBodyPort,
  type JiraManagedConnection,
} from "@oscharko-dev/keiko-connectors";
import type { JiraMutationAttempt } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { emailTemplateFixture } from "../../../../tests/support/jira-email-template-fixture.js";
import {
  EMAIL_TEMPLATE_NATIVE_CASES,
  emailTemplateTransportController,
} from "../../../../tests/support/jira-email-template-transport-fixture.js";
import { zipTextEntries } from "../../../../tests/support/zip-fixture.js";
import { createBufferedServerLogSink } from "../../../../tests/support/buffered-server-log.js";
import { createInMemoryUiStore } from "../store/index.js";
import { processServerLogSink } from "../process-log-sink.js";
import {
  previewJiraEmailTemplatePack,
  type JiraChatAttachmentDeps,
  type JiraChatAttachmentReview,
} from "./jiraChatAttachment.js";
import {
  jiraChatEmailTemplateComposition,
  jiraEmailTemplateInspection,
} from "./jiraEmailTemplateComposition.js";
import { jiraEmailTemplateDeclarationForTool } from "./jiraEmailTemplateDescriptors.js";
import { jiraAttemptToolResult } from "./jiraMutationResult.js";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(review: () => JiraChatAttachmentReview) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-email-composition-")));
  roots.push(root);
  mkdirSync(join(root, "docs"));
  const path = join(root, "docs", "templates.zip");
  writeFileSync(path, emailTemplateFixture().bytes);
  const store = createInMemoryUiStore();
  store.createProject(root);
  const chat = store.createChat(root, "Synthetic", "model");
  store.updateChat(chat.id, {
    connectedScopes: [{ kind: "workspace-root", root, relativePaths: [], connectedAtMs: 1 }],
  });
  const deps: JiraChatAttachmentDeps = {
    store,
    redactor: (value) => value,
    managedTaskWorkspaceRoot: undefined,
    env: {},
    config: undefined,
    gatewayConfig: undefined,
    egress: undefined,
  };
  const context = {
    invocationId: "email-composition",
    correlationId: "email-composition",
    signal: new AbortController().signal,
    beforeEffect: () => true,
  };
  const logs = createBufferedServerLogSink();
  vi.spyOn(processServerLogSink(), "write").mockImplementation(logs.write);
  const native = emailTemplateTransportController("jira.upload-email-template-pack");
  if (native === undefined) throw new TypeError("Missing independent email native fixture");
  let acknowledged = false;
  const http = vi.fn<AtlassianHttpBodyPort>(async (request) => {
    const result = await (request.method === "GET" ? native.read(request) : native.write(request));
    if (result === undefined) throw new TypeError("Unexpected email fixture request");
    if (
      request.method === "POST" &&
      result.kind === "response" &&
      result.status >= 200 &&
      result.status < 300
    )
      acknowledged = true;
    return result;
  });
  const options = {
    chatId: chat.id,
    correlationId: context.correlationId,
    signal: context.signal,
    review,
  };
  const connection: JiraManagedConnection = {
    baseUrl: "https://jira.example.invalid/context",
    deployment: "data-center",
    http,
    emailTemplates: jiraChatEmailTemplateComposition(deps, options),
  };
  const execute = async (selected = connection): Promise<JiraMutationAttempt> => {
    const declaration = jiraEmailTemplateDeclarationForTool(upload.tool);
    if (declaration === undefined) throw new TypeError("Missing email upload declaration");
    const observed: { attempt?: JiraMutationAttempt } = {};
    const provider = createJiraManagedProvider({
      connection: () => selected,
      declarations: [declaration],
      executeMutation: async (_operation, _args, _context, run) => {
        const attempt = await run(selected.http);
        observed.attempt = attempt;
        if (attempt.ok) return jiraAttemptToolResult("succeeded", attempt);
        return jiraAttemptToolResult(acknowledged ? "succeeded-unconfirmed" : "rejected", attempt);
      },
    });
    const tool = provider.tools().find((entry) => entry.name === upload.tool);
    if (tool === undefined) throw new TypeError("Missing email upload provider tool");
    const result = await tool.execute(upload.args, context);
    const attempt = observed.attempt;
    if (attempt === undefined)
      throw new TypeError("Provider did not execute the real mutation callback");
    if (!attempt.ok)
      expect(result).toMatchObject({
        isError: true,
        data: {
          outcome: acknowledged ? "succeeded-unconfirmed" : "rejected",
          reason: attempt.reason,
          ...attempt.receipt,
        },
      });
    return attempt;
  };
  return { deps, options, context, connection, http, native, path, logs, execute };
}
const upload = EMAIL_TEMPLATE_NATIVE_CASES[1];
it("checks the connected ZIP before the approval card without authorizing its later send", async () => {
  const f = fixture(() => ({ required: true, reviewed: undefined }));
  expect(
    await checkJiraManagedMutation(upload.tool, upload.args, f.context, f.connection),
  ).toMatchObject({ ok: true });
  expect(f.native.snapshot()).toEqual({ writes: 0, action: null });
  expect(await f.execute()).toMatchObject({ ok: false });
  expect(f.native.snapshot()).toEqual({ writes: 0, action: null });
  expect(
    f.logs.events
      .filter((event) => event.op === "jira.attachment.source")
      .map((event) => event.extra?.stage),
  ).toContain("review");
});
it("mints the already-allowed source snapshot without adding an approval and uploads once", async () => {
  const f = fixture(() => ({ required: false }));
  expect(await f.execute()).toMatchObject({
    ok: false,
    reason: "unavailable",
    receipt: upload.receipt,
  });
  expect(f.native.snapshot()).toEqual({ writes: 1, action: "upload" });
  expect(f.http.mock.calls.filter(([request]) => request.method === "POST")).toHaveLength(1);
});
it("uses the existing approved snapshot and refuses changed bytes before any upload", async () => {
  let review: JiraChatAttachmentReview = { required: true, reviewed: undefined };
  const f = fixture(() => review);
  const preview = await previewJiraEmailTemplatePack(
    f.deps,
    f.options.chatId,
    "docs/templates.zip",
    f.context.correlationId,
    f.context.signal,
  );
  expect(preview).toBeDefined();
  review = { required: true, reviewed: preview };
  writeFileSync(
    f.path,
    zipTextEntries([{ name: "templates/issue.vm", content: "Changed template" }]),
  );
  expect(await f.execute()).toMatchObject({ ok: false });
  expect(f.native.snapshot()).toEqual({ writes: 0, action: null });
});
it("sends the exact existing reviewed snapshot once without replacing it with a new review", async () => {
  let review: JiraChatAttachmentReview = { required: true, reviewed: undefined };
  const f = fixture(() => review);
  const preview = await previewJiraEmailTemplatePack(
    f.deps,
    f.options.chatId,
    "docs/templates.zip",
    f.context.correlationId,
    f.context.signal,
  );
  expect(preview).toBeDefined();
  review = { required: true, reviewed: preview };
  expect(await f.execute()).toMatchObject({
    ok: false,
    reason: "unavailable",
    receipt: upload.receipt,
  });
  expect(f.native.snapshot()).toEqual({ writes: 1, action: "upload" });
});
it("keeps Coding inspection separate from a missing governed file source", async () => {
  const f = fixture(() => ({ required: false }));
  const connection = {
    ...f.connection,
    emailTemplates: jiraEmailTemplateInspection(f.deps, f.context.signal),
  };
  expect(await f.execute(connection)).toMatchObject({
    ok: false,
    reason: "unavailable",
    detail: { messages: [expect.stringContaining("Chat with a connected file")] },
  });
  expect(f.http).not.toHaveBeenCalled();
});
