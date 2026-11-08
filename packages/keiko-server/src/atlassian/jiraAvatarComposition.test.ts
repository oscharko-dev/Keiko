import { Buffer } from "node:buffer";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { JIRA_ATTACHMENT_MAX_BYTES } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { createBufferedServerLogSink } from "../../../../tests/support/buffered-server-log.js";
import { createInMemoryUiStore } from "../store/index.js";
import { processServerLogSink } from "../process-log-sink.js";
import {
  previewJiraAvatarImage,
  type JiraChatAttachmentDeps,
  type JiraChatAttachmentReview,
} from "./jiraChatAttachment.js";
import { jiraAvatarInspection, jiraChatAvatarComposition } from "./jiraAvatarComposition.js";

const IMAGE = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jE0sAAAAASUVORK5CYII=",
  "base64",
);
const REQUEST = {
  kind: "connected-file",
  path: "images/avatar.png",
  maxBytes: JIRA_ATTACHMENT_MAX_BYTES,
  purpose: "jira-avatar-image",
} as const;
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(review: () => JiraChatAttachmentReview) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-avatar-composition-")));
  roots.push(root);
  mkdirSync(join(root, "images"));
  const path = join(root, REQUEST.path);
  writeFileSync(path, IMAGE);
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
  const options = {
    chatId: chat.id,
    correlationId: "avatar-composition",
    signal: new AbortController().signal,
    review,
  };
  const logs = createBufferedServerLogSink();
  vi.spyOn(processServerLogSink(), "write").mockImplementation(logs.write);
  const composition = jiraChatAvatarComposition(deps, options);
  function source(check: boolean) {
    const value = composition.sourceFor?.(check);
    if (value === undefined) throw new TypeError("Missing composed source");
    return value;
  }
  return { deps, options, composition, source, path, logs };
}
it("allows readonly preview before a required approval, but never its send", async () => {
  const f = fixture(() => ({ required: true, reviewed: undefined }));
  expect(await f.source(true)(REQUEST)).toMatchObject({
    ok: true,
    content: { name: "avatar.png" },
  });
  expect(await f.source(false)(REQUEST)).toMatchObject({ ok: false, reason: "conflict" });
  expect(
    f.logs.events
      .filter((event) => event.op === "jira.attachment.source")
      .map((event) => event.extra?.stage),
  ).toContain("review");
});
it("server-mints exact image integrity in allowed mode without adding approval", async () => {
  const review = vi.fn((): JiraChatAttachmentReview => ({ required: false }));
  const f = fixture(review);
  expect(await f.source(false)(REQUEST)).toMatchObject({
    ok: true,
    content: { name: "avatar.png", bytes: IMAGE },
  });
  expect(
    review.mock.results.every(
      (result) => result.type === "return" && result.value.required === false,
    ),
  ).toBe(true);
  expect(
    f.logs.events
      .filter((event) => event.op === "jira.attachment.source")
      .map((event) => event.extra?.stage),
  ).toEqual(["review", "send"]);
});
it("uses the approved image snapshot and refuses changed actual bytes", async () => {
  let review: JiraChatAttachmentReview = { required: true, reviewed: undefined };
  const f = fixture(() => review);
  const snapshot = await previewJiraAvatarImage(
    f.deps,
    f.options.chatId,
    REQUEST.path,
    f.options.correlationId,
    f.options.signal,
  );
  review = { required: true, reviewed: snapshot };
  expect(await f.source(false)(REQUEST)).toMatchObject({ ok: true });
  writeFileSync(f.path, new Uint8Array([255, 216, 255, 224, 0, 2, 255, 217]));
  expect(await f.source(false)(REQUEST)).toMatchObject({ ok: false, reason: "conflict" });
});
it("does not let a policy change reuse the earlier allowed-mode snapshot", async () => {
  let calls = 0;
  const f = fixture(() =>
    ++calls === 1 ? { required: false } : { required: true, reviewed: undefined },
  );
  expect(await f.source(false)(REQUEST)).toMatchObject({ ok: false, reason: "conflict" });
});
it("never converts inspection or an arbitrary caller path into Coding file authority", async () => {
  const f = fixture(() => ({ required: false }));
  const inspection = jiraAvatarInspection(f.deps, f.options.signal);
  expect(Object.keys(inspection)).toEqual(["inspectImage"]);
  expect(await inspection.inspectImage?.(IMAGE)).toMatchObject({
    ok: true,
    value: { mimeType: "image/png" },
  });
  expect(await f.source(false)({ ...REQUEST, path: "../../outside.png" })).toMatchObject({
    ok: false,
  });
  expect(await f.source(false)({ ...REQUEST, purpose: "jira-email-template-pack" })).toMatchObject({
    ok: false,
    reason: "field-validation",
  });
});
