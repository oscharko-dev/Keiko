import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { analyzeLogText } from "@oscharko-dev/keiko-activity-log/reader";
import { JIRA_ATTACHMENT_MAX_BYTES } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { ChatConnectedScope } from "@oscharko-dev/keiko-contracts/bff-wire";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../../tests/support/activity-log-proof.js";
import { createBufferedServerLogSink } from "../../../../tests/support/buffered-server-log.js";
import { processServerLogSink } from "../process-log-sink.js";
import { createInMemoryUiStore, type UiStore } from "../store/index.js";
import type { ChatToolWriteApprovalView } from "@oscharko-dev/keiko-contracts";
import {
  attachmentReviewFor,
  jiraChatAttachmentSource,
  previewJiraChatAttachment,
  type JiraChatAttachmentDeps,
  type JiraChatAttachmentReview,
} from "./jiraChatAttachment.js";

let root: string;
let outside: string;
let store: UiStore;
let chatId: string;
let logs: ReturnType<typeof createBufferedServerLogSink>;
const BODY = "synthetic report body";
const DIGEST = createHash("sha256").update(BODY).digest("hex");
const CONFIGURED_SECRET = ["configured", "provider", "literal", "0123456789"].join("-");
const LIMIT = JIRA_ATTACHMENT_MAX_BYTES;

function deps(): JiraChatAttachmentDeps {
  return {
    store,
    redactor: (value: unknown) => value,
    managedTaskWorkspaceRoot: undefined,
    env: { KEIKO_DEFAULT_API_KEY: CONFIGURED_SECRET },
    config: undefined,
    gatewayConfig: undefined,
    egress: undefined,
  };
}
function connect(...scopes: readonly Partial<ChatConnectedScope>[]): void {
  store.updateChat(chatId, {
    connectedScopes: scopes.map((scope) => ({
      kind: "workspace-root",
      root,
      relativePaths: [],
      connectedAtMs: 1,
      ...scope,
    })),
  });
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-jira-attach-")));
  outside = realpathSync(mkdtempSync(join(tmpdir(), "keiko-jira-attach-outside-")));
  mkdirSync(join(root, "docs"));
  mkdirSync(join(root, "other"));
  writeFileSync(join(root, "docs", "report.txt"), BODY);
  writeFileSync(join(root, "other", "note.txt"), "other");
  writeFileSync(join(root, ".env"), "TOKEN=synthetic");
  writeFileSync(join(root, "empty.txt"), "");
  writeFileSync(join(outside, "secret.txt"), "outside the root");
  symlinkSync(join(outside, "secret.txt"), join(root, "docs", "link.txt"));
  store = createInMemoryUiStore();
  store.createProject(root);
  chatId = store.createChat(root, "Synthetic", "model").id;
  logs = createBufferedServerLogSink();
  vi.spyOn(processServerLogSink(), "write").mockImplementation(logs.write);
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

const ARGS = (path: string): { issueKey: string; path: string } => ({ issueKey: "SYN-1", path });
const MAX = JIRA_ATTACHMENT_MAX_BYTES;

it("shows the human the name, size and digest of the connected file, never its content", async () => {
  connect({});
  expect(
    await previewJiraChatAttachment(deps(), chatId, ARGS("docs/report.txt"), "corr-1", LIMIT),
  ).toEqual({ name: "report.txt", sizeBytes: BODY.length, sha256: DIGEST });
  const line = formatActivityLogProofLine(logs.events[0] ?? failEmpty());
  expect(expectActivityLogProof("jira.attachment.source.line", line)).toMatchObject({
    op: "jira.attachment.source",
    stage: "review",
    outcome: "read",
    refusal: "none",
    sizeBytes: BODY.length,
  });
  expect(line).not.toMatch(/report|synthetic|docs/u);
  expect(analyzeLogText(line).timelines).toHaveLength(1);
});
function failEmpty(): never {
  throw new Error("Missing activity event");
}

it.each([
  [
    "a path outside every connected selection",
    [{ kind: "directory", relativePaths: ["other"] }],
    "docs/report.txt",
    "outside-connected-scope",
  ],
  [
    "a file the selection does not list",
    [{ kind: "files", relativePaths: ["other/note.txt"] }],
    "docs/report.txt",
    "outside-connected-scope",
  ],
  ["a traversal out of the root", [{}], "../escape.txt", "outside-connected-scope"],
  ["an absolute host path", [{}], "/etc/passwd", "outside-connected-scope"],
  ["a denied sensitive file", [{}], ".env", "denied"],
  ["a symlink that leaves the root", [{}], "docs/link.txt", "denied"],
  ["a directory", [{}], "docs", "not-a-file"],
  ["an absent file", [{}], "docs/missing.txt", "not-found"],
  ["an empty file", [{}], "empty.txt", "empty"],
] as const)("never reads %s", async (_label, scopes, path, refusal) => {
  connect(...scopes);
  expect(
    await previewJiraChatAttachment(deps(), chatId, ARGS(path), "corr-2", LIMIT),
  ).toBeUndefined();
  const line = formatActivityLogProofLine(logs.events[0] ?? failEmpty());
  expect(expectActivityLogProof("jira.attachment.source.line", line)).toMatchObject({
    outcome: "refused",
    refusal,
    level: "warn",
  });
});

it("refuses when no folder is connected to the Chat", async () => {
  expect(
    await previewJiraChatAttachment(deps(), chatId, ARGS("docs/report.txt"), "c", LIMIT),
  ).toBeUndefined();
  expect(logs.events[0]?.extra).toMatchObject({ refusal: "no-connected-folder" });
});

it("admits a file inside a connected directory and one a files selection lists", async () => {
  connect({ kind: "directory", relativePaths: ["docs"] });
  expect(
    await previewJiraChatAttachment(deps(), chatId, ARGS("docs/report.txt"), "c", LIMIT),
  ).toMatchObject({
    sha256: DIGEST,
  });
  connect({ kind: "files", relativePaths: ["docs/report.txt"] });
  expect(
    await previewJiraChatAttachment(deps(), chatId, ARGS("docs/report.txt"), "c", LIMIT),
  ).toMatchObject({
    sha256: DIGEST,
  });
});

it("refuses a name that is not a plain file name", async () => {
  connect({});
  expect(
    await previewJiraChatAttachment(
      deps(),
      chatId,
      { ...ARGS("docs/report.txt"), name: "a/b" },
      "c",
      LIMIT,
    ),
  ).toBeUndefined();
});

it("bounds the read by the limit the connector passes", async () => {
  connect({});
  const read = await jiraChatAttachmentSource(deps(), {
    chatId,
    correlationId: "corr-3",
    review: () => ({ required: false }),
  })({ kind: "connected-file", path: "docs/report.txt", maxBytes: BODY.length - 1 });
  expect(read).toMatchObject({ ok: false, reason: "bounds-exceeded" });
  expect(MAX).toBeGreaterThan(BODY.length);
});

function source(
  review: () => JiraChatAttachmentReview,
): ReturnType<typeof jiraChatAttachmentSource> {
  return jiraChatAttachmentSource(deps(), { chatId, correlationId: "corr-4", review });
}
const REQUEST = { kind: "connected-file", path: "docs/report.txt", maxBytes: MAX } as const;

it("sends the bytes the human reviewed and nothing else", async () => {
  connect({});
  const reviewed = { name: "report.txt", sizeBytes: BODY.length, sha256: DIGEST };
  const read = await source(() => ({ required: true, reviewed }))(REQUEST);
  expect(read).toMatchObject({ ok: true, content: { name: "report.txt", sha256: DIGEST } });
  expect(Buffer.from(read.ok ? read.content.bytes : []).toString()).toBe(BODY);
  expect(logs.events.at(-1)?.extra).toMatchObject({ stage: "send", outcome: "read" });
});

it("refuses a file that changed after it was reviewed, with a message the model can act on", async () => {
  connect({});
  const reviewed = { name: "report.txt", sizeBytes: BODY.length, sha256: DIGEST };
  writeFileSync(join(root, "docs", "report.txt"), "changed after the human looked");
  expect(await source(() => ({ required: true, reviewed }))(REQUEST)).toMatchObject({
    ok: false,
    reason: "conflict",
    detail: {
      fieldId: "source",
      messages: [expect.stringContaining("changed after it was reviewed")],
    },
  });
  expect(logs.events.at(-1)?.extra).toMatchObject({
    stage: "send",
    refusal: "changed-after-review",
  });
});

it("refuses an approval that carries no reviewed file and still reads without a review under Full access", async () => {
  connect({});
  expect(await source(() => ({ required: true, reviewed: undefined }))(REQUEST)).toMatchObject({
    ok: false,
    reason: "conflict",
  });
  expect(logs.events.at(-1)?.extra).toMatchObject({ refusal: "unreviewed" });
  expect(await source(() => ({ required: false }))(REQUEST)).toMatchObject({ ok: true });
});

it("uses an explicit attachment name for the review and the send", async () => {
  connect({});
  const read = await source(() => ({ required: false }))({ ...REQUEST, name: "final.txt" });
  expect(read).toMatchObject({ ok: true, content: { name: "final.txt" } });
});

// Review (#4176): a link inside a selection may lead outside it. The selection is matched on the
// path asked for and again on the place the bytes really came from.
describe("a symbolic link inside a selection", () => {
  beforeEach(() => {
    mkdirSync(join(root, "private"));
    writeFileSync(join(root, "private", "customers.csv"), "id,name\n1,Ada\n");
    symlinkSync(join(root, "private", "customers.csv"), join(root, "docs", "customers.csv"));
    symlinkSync(join(root, "private"), join(root, "docs", "linked-dir"));
  });
  it.each([
    ["a directory selection", { kind: "directory", relativePaths: ["docs"] }, "docs/customers.csv"],
    [
      "a directory selection (linked directory)",
      { kind: "directory", relativePaths: ["docs"] },
      "docs/linked-dir/customers.csv",
    ],
    [
      "a files selection",
      { kind: "files", relativePaths: ["docs/customers.csv"] },
      "docs/customers.csv",
    ],
  ] as const)("cannot attach a file outside %s", async (_label, scope, path) => {
    connect(scope);
    expect(await previewJiraChatAttachment(deps(), chatId, ARGS(path), "c", LIMIT)).toBeUndefined();
    expect(logs.events.at(-1)?.extra).toMatchObject({
      refusal: "outside-connected-scope",
    });
  });
  it("still attaches a link whose real location is inside the selection, under the name asked for", async () => {
    symlinkSync(join(root, "docs", "report.txt"), join(root, "docs", "latest.txt"));
    connect({ kind: "directory", relativePaths: ["docs"] });
    expect(
      await previewJiraChatAttachment(deps(), chatId, ARGS("docs/latest.txt"), "c", LIMIT),
    ).toEqual({ name: "latest.txt", sizeBytes: BODY.length, sha256: DIGEST });
  });
});

// Review (#4176): the bytes skip the redaction every other egress applies, so they are scanned.
describe("the credential floor on attached bytes", () => {
  const PEM =
    "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----\n";
  it.each([
    ["a private key in yml", "config/app.yml", `signing:\n  key: |\n${PEM}`],
    [
      "an Authorization value in properties",
      "config/app.properties",
      "auth.header=Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789\n",
    ],
    [
      "URL credentials in a SQL dump",
      "dump.sql",
      "INSERT INTO t VALUES ('postgres://admin:hunter2hunter2@db.internal/app');\n",
    ],
    ["a configured provider secret", "notes.txt", `the key is ${CONFIGURED_SECRET} here\n`],
  ])("refuses %s at the review and at the send", async (_label, path, text) => {
    mkdirSync(join(root, "config"), { recursive: true });
    writeFileSync(join(root, path), text);
    connect({});
    expect(await previewJiraChatAttachment(deps(), chatId, ARGS(path), "c", LIMIT)).toBeUndefined();
    expect(logs.events.at(-1)?.extra).toMatchObject({
      stage: "review",
      refusal: "contains-credential",
    });
    const read = await source(() => ({ required: false }))({ ...REQUEST, path });
    expect(read).toMatchObject({
      ok: false,
      reason: "permission-denied",
      detail: { messages: [expect.stringContaining("contains a credential")] },
    });
    expect(logs.events.at(-1)?.extra).toMatchObject({
      stage: "send",
      refusal: "contains-credential",
    });
    expect(JSON.stringify(logs.events)).not.toContain(CONFIGURED_SECRET);
  });
  it("refuses a kind of file it cannot scan, at both stages", async () => {
    writeFileSync(
      join(root, "docs", "archive.zip"),
      Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]),
    );
    connect({});
    expect(
      await previewJiraChatAttachment(deps(), chatId, ARGS("docs/archive.zip"), "c", LIMIT),
    ).toBeUndefined();
    expect(logs.events.at(-1)?.extra).toMatchObject({ refusal: "unscannable" });
    expect(
      await source(() => ({ required: false }))({ ...REQUEST, path: "docs/archive.zip" }),
    ).toMatchObject({ ok: false, reason: "field-validation" });
  });
  it("lets clean text and an image through", async () => {
    // A signature, an empty IHDR chunk and IEND: nothing hidden in or behind the image.
    const chunk = (type: string, length: number): Buffer =>
      Buffer.concat([
        Buffer.from([0, 0, 0, length]),
        Buffer.from(type, "latin1"),
        Buffer.alloc(length + 4),
      ]);
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", 13),
      chunk("IEND", 0),
    ]);
    writeFileSync(join(root, "docs", "shot.png"), png);
    connect({});
    expect(
      await previewJiraChatAttachment(deps(), chatId, ARGS("docs/shot.png"), "c", LIMIT),
    ).toMatchObject({
      name: "shot.png",
      sizeBytes: png.length,
    });
    expect(
      await previewJiraChatAttachment(deps(), chatId, ARGS("docs/report.txt"), "c", LIMIT),
    ).toMatchObject({
      sha256: DIGEST,
    });
  });
});

describe("what policy and the approval registry say about an attachment", () => {
  const preview = { name: "report.txt", sizeBytes: 21, sha256: DIGEST };
  const approval = (extra: object): ChatToolWriteApprovalView =>
    ({
      kind: "jira-chat-write",
      operation: "jira.attach",
      ...extra,
    }) as ChatToolWriteApprovalView;
  it("needs no review only where policy allows the write outright", () => {
    expect(attachmentReviewFor("allowed", undefined)).toEqual({ required: false });
  });
  it.each(["review-required", "denied", "anything-else"])(
    "requires a review under %s and finds nothing reviewed when the approval is missing",
    (policy) => {
      expect(attachmentReviewFor(policy, undefined)).toEqual({
        required: true,
        reviewed: undefined,
      });
    },
  );
  it("carries the reviewed file of a matching approval, and nothing from any other", () => {
    expect(attachmentReviewFor("review-required", approval({ attachment: preview }))).toEqual({
      required: true,
      reviewed: preview,
    });
    expect(
      attachmentReviewFor(
        "review-required",
        approval({ operation: "jira.edit", attachment: preview }),
      ),
    ).toEqual({ required: true, reviewed: undefined });
  });
});

// Review (#4176): where policy requires a review, a missing approval is a refusal, never a pass.
it("refuses a send that policy required to be reviewed when no approval is found", async () => {
  connect({});
  expect(
    await jiraChatAttachmentSource(deps(), {
      chatId,
      correlationId: "corr-5",
      review: () => ({ required: true, reviewed: undefined }),
    })(REQUEST),
  ).toMatchObject({ ok: false, reason: "conflict" });
  expect(logs.events.at(-1)?.extra).toMatchObject({ stage: "send", refusal: "unreviewed" });
});

// Review (#4176): the review is held to the bound the send will use.
it("refuses at the review a file the instance's limit would refuse at the send", async () => {
  connect({});
  expect(
    await previewJiraChatAttachment(deps(), chatId, ARGS("docs/report.txt"), "c", BODY.length - 1),
  ).toBeUndefined();
  expect(logs.events.at(-1)?.extra).toMatchObject({ stage: "review", refusal: "too-large" });
  expect(
    await previewJiraChatAttachment(deps(), chatId, ARGS("docs/report.txt"), "c", undefined),
  ).toBeUndefined();
  expect(logs.events.at(-1)?.extra).toMatchObject({ refusal: "limit-unavailable" });
});
