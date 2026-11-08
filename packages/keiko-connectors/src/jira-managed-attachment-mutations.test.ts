import { describe, expect, it, vi } from "vitest";
import {
  TOOL_CATALOG_LIMITS,
  type CatalogJsonObject,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { ATLASSIAN_WRITE_RESPONSE_MAX_BYTES } from "./atlassian-write-http.js";
import type { AtlassianWriteHttpOutcome } from "./atlassian-write-http.js";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import {
  executeJiraAttachmentMutation,
  isJiraAttachmentMutation,
} from "./jira-managed-attachment-mutations.js";
import { JiraAcknowledgedMutationError } from "./jira-mutation-failure.js";

const ID = "9007199254740993";
const INPUT = { issueKey: "SYN-7", attachmentId: ID, filename: "Review.pdf", size: 42 };
const FILE = {
  id: ID,
  filename: INPUT.filename,
  size: INPUT.size,
  content: "https://untrusted.invalid/content",
  self: "https://untrusted.invalid/self",
};
const OTHER = { id: "17", filename: "Retained.txt", size: 0 };
const ISSUE = { id: "10007", key: INPUT.issueKey, fields: { attachment: [FILE, OTHER] } };
const RECEIPT = { issueKey: INPUT.issueKey, issueId: ISSUE.id, attachmentId: ID };
const response = (body: Record<string, unknown>): AtlassianWriteHttpOutcome => ({
  ok: true,
  status: 200,
  body,
});
interface Options {
  readonly before?: Record<string, unknown>;
  readonly metadata?: Record<string, unknown>;
  readonly after?: Record<string, unknown>;
  readonly write?: AtlassianWriteHttpOutcome;
  readonly readFailure?: AtlassianWriteHttpOutcome;
  readonly metadataFailure?: AtlassianWriteHttpOutcome;
  readonly throwAfter?: boolean;
}
function fixture(options: Options = {}): ReturnType<typeof vi.fn<JiraMutationRequest>> {
  let deleted = false;
  function parent(): AtlassianWriteHttpOutcome {
    if (!deleted) return response(options.before ?? ISSUE);
    if (options.throwAfter) throw new TypeError("Parent read interrupted");
    return (
      options.readFailure ??
      response(options.after ?? { ...ISSUE, fields: { attachment: [OTHER] } })
    );
  }
  return vi.fn<JiraMutationRequest>((path, method = "GET", _body, expect) => {
    if (method === "DELETE") {
      expectDelete(path, expect);
      deleted = true;
      return Promise.resolve(options.write ?? { ok: true, status: 204, body: undefined });
    }
    if (path === `attachment/${ID}`)
      return Promise.resolve(options.metadataFailure ?? response(options.metadata ?? FILE));
    return Promise.resolve(parent());
  });
}
function expectDelete(path: string, codec: unknown): void {
  expect(path).toBe(`attachment/${ID}`);
  expect(codec).toBe("none");
}
const remove = (
  request: JiraMutationRequest,
  args: CatalogJsonObject = INPUT,
  check = false,
): ReturnType<typeof executeJiraAttachmentMutation> =>
  executeJiraAttachmentMutation("jira.delete-attachment", args, request, check);

describe("reviewed native attachment deletion", () => {
  it("binds issue membership and reviewed metadata, deletes once and confirms from the parent list", async () => {
    const request = fixture();
    expect(await remove(request)).toEqual({ ok: true, receipt: RECEIPT });
    expect(request.mock.calls).toEqual([
      ["issue/SYN-7?fields=attachment"],
      [`attachment/${ID}`],
      [`attachment/${ID}`, "DELETE", undefined, "none"],
      ["issue/10007?fields=attachment"],
    ]);
  });
  it.each(["syn-7", "10007"])(
    "retains canonical issue identity when input is %s",
    async (issueKey) => {
      expect(await remove(fixture(), { ...INPUT, issueKey })).toEqual({
        ok: true,
        receipt: RECEIPT,
      });
    },
  );
  it("validates preflight without an effect or removal claim", async () => {
    const request = fixture();
    expect(await remove(request, INPUT, true)).toEqual({ ok: true, receipt: {} });
    expect(request).toHaveBeenCalledTimes(2);
  });
  it("retains a canonical platform issue key beyond the Agile project-key bound", async () => {
    const issueKey = `${"S".repeat(40)}-7`;
    const before = { ...ISSUE, key: issueKey };
    const after = { ...before, fields: { attachment: [OTHER] } };
    expect(await remove(fixture({ before, after }), { ...INPUT, issueKey })).toEqual({
      ok: true,
      receipt: { ...RECEIPT, issueKey },
    });
  });
  it("preserves zero-byte native attachment metadata", async () => {
    const file = { ...FILE, size: 0 };
    expect(
      await remove(
        fixture({ before: { ...ISSUE, fields: { attachment: [file] } }, metadata: file }),
        { ...INPUT, size: 0 },
      ),
    ).toEqual({ ok: true, receipt: RECEIPT });
  });
  it.each([
    { ...INPUT, issueKey: "../7" },
    { ...INPUT, attachmentId: "01" },
    { ...INPUT, attachmentId: "9223372036854775808" },
    { ...INPUT, filename: "" },
    { ...INPUT, filename: "x".repeat(1025) },
    { ...INPUT, filename: "bad\u0000name" },
    { ...INPUT, size: -1 },
    { ...INPUT, size: 1.5 },
    { ...INPUT, size: Number.MAX_SAFE_INTEGER + 1 },
    { ...INPUT, source: { path: "secret.txt" } },
    { ...INPUT, content: "https://other.invalid/file" },
  ])("refuses invalid or widened deletion inputs before any HTTP", async (args) => {
    const request = fixture();
    expect(await remove(request, args)).toMatchObject({ ok: false, reason: "field-validation" });
    expect(request).not.toHaveBeenCalled();
  });
  it.each(
    [[], [OTHER], [{ ...FILE, filename: "Different.pdf" }], [{ ...FILE, size: 43 }]].map(
      (attachment) => ({ attachment }),
    ),
  )(
    "refuses absent or changed issue attachment membership before DELETE",
    async ({ attachment }) => {
      const request = fixture({ before: { ...ISSUE, fields: { attachment } } });
      expect(await remove(request)).toMatchObject({ ok: false, reason: "conflict" });
      expect(request).toHaveBeenCalledTimes(1);
    },
  );
  it.each(
    [
      undefined,
      null,
      {},
      [FILE, FILE],
      [{ ...FILE, id: 9007199254740992 }],
      [FILE, { id: "19" }],
    ].map((attachment) => ({ attachment })),
  )("refuses incomplete or malformed parent attachment lists", async ({ attachment }) => {
    const request = fixture({ before: { ...ISSUE, fields: { attachment } } });
    expect(await remove(request)).toMatchObject({ ok: false, reason: "malformed-payload" });
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("refuses a complete-list claim exceeding the actual transport byte budget before mutation", async () => {
    const attachment = Array.from(
      { length: TOOL_CATALOG_LIMITS.maxArrayItems + 1 },
      (_, index) => ({ ...FILE, id: String(index + 1), filename: "x".repeat(1024) }),
    );
    expect(new TextEncoder().encode(JSON.stringify(attachment)).byteLength).toBeGreaterThan(
      ATLASSIAN_WRITE_RESPONSE_MAX_BYTES,
    );
    const request = fixture({ before: { ...ISSUE, fields: { attachment } } });
    expect(await remove(request)).toEqual({ ok: false, reason: "bounds-exceeded" });
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("retains the acknowledged receipt with a bounds refusal for an oversized confirmation list", async () => {
    const attachment = Array.from(
      { length: TOOL_CATALOG_LIMITS.maxArrayItems + 1 },
      (_, index) => ({ ...OTHER, id: String(index + 1), filename: "x".repeat(1024) }),
    );
    const request = fixture({ after: { ...ISSUE, fields: { attachment } } });
    expect(await remove(request)).toEqual({
      ok: false,
      reason: "bounds-exceeded",
      receipt: RECEIPT,
    });
    expect(request.mock.calls.filter(([, method]) => method === "DELETE")).toHaveLength(1);
    expect(request).toHaveBeenCalledTimes(4);
  });
  it("retains structural-malformation classification after acknowledgement", async () => {
    const request = fixture({ after: { ...ISSUE, fields: { attachment: [OTHER, OTHER] } } });
    expect(await remove(request)).toEqual({
      ok: false,
      reason: "malformed-payload",
      receipt: RECEIPT,
    });
    expect(request.mock.calls.filter(([, method]) => method === "DELETE")).toHaveLength(1);
  });
  it.each([
    { ...FILE, id: "99" },
    { ...FILE, size: 41 },
    { ...FILE, filename: "Different.pdf" },
  ])("rechecks exact approved attachment metadata immediately before effect", async (metadata) => {
    const request = fixture({ metadata });
    expect(await remove(request)).toMatchObject({ ok: false, reason: "conflict" });
    expect(request).toHaveBeenCalledTimes(2);
  });
  it.each(["not-found", "permission-denied"] as const)(
    "does not treat metadata %s as removal permission or proof",
    async (reason) => {
      const request = fixture({ metadataFailure: { ok: false, reason } });
      expect(await remove(request)).toEqual({ ok: false, reason });
      expect(request).toHaveBeenCalledTimes(2);
    },
  );
  it.each([200, 202, 204])("independently verifies acknowledged %s removal", async (status) => {
    expect(await remove(fixture({ write: { ok: true, status, body: undefined } }))).toEqual({
      ok: true,
      receipt: RECEIPT,
    });
  });
  it.each(["not-found", "permission-denied", "timeout", "conflict"] as const)(
    "never upgrades or retries a %s DELETE outcome",
    async (reason) => {
      const request = fixture({ write: { ok: false, reason } });
      expect(await remove(request)).toEqual({ ok: false, reason, receipt: RECEIPT });
      expect(request).toHaveBeenCalledTimes(3);
      expect(request.mock.calls.filter(([, method]) => method === "DELETE")).toHaveLength(1);
    },
  );
  it.each(["not-found", "permission-denied", "auth-failed", "timeout"] as const)(
    "keeps removal unconfirmed when the parent read returns %s",
    async (reason) => {
      expect(await remove(fixture({ readFailure: { ok: false, reason } }))).toEqual({
        ok: false,
        reason,
        receipt: RECEIPT,
      });
    },
  );
  it.each([
    ISSUE,
    { ...ISSUE, fields: {} },
    { ...ISSUE, fields: { attachment: null } },
    { ...ISSUE, id: "99", fields: { attachment: [] } },
    { ...ISSUE, key: "OTHER-7", fields: { attachment: [] } },
  ])(
    "does not confirm from an unreadable, mismatched or still-containing parent",
    async (after) => {
      expect(await remove(fixture({ after }))).toMatchObject({ ok: false, receipt: RECEIPT });
    },
  );
  it("preserves acknowledged identity and cause if parent read throws", async () => {
    await expect(remove(fixture({ throwAfter: true }))).rejects.toMatchObject({
      name: JiraAcknowledgedMutationError.name,
      receipt: RECEIPT,
      cause: new TypeError("Parent read interrupted"),
    });
  });
  it("does not follow native metadata content/self URLs or read any local source", async () => {
    const request = fixture();
    await remove(request);
    expect(
      request.mock.calls.every(
        ([path]) => path.startsWith("issue/") || path === `attachment/${ID}`,
      ),
    ).toBe(true);
  });
  it("exposes only the reviewed delete operation", () => {
    expect(isJiraAttachmentMutation("jira.delete-attachment")).toBe(true);
    expect(isJiraAttachmentMutation("jira.attach")).toBe(false);
    expect(isJiraAttachmentMutation("jira.delete-all-attachments")).toBe(false);
  });
});

it("admits and confirms exact attachment removal among more than a thousand bounded native rows", async () => {
  const others = Array.from({ length: 1001 }, (_, index) => ({ ...OTHER, id: String(index + 1) }));
  const request = fixture({
    before: { ...ISSUE, fields: { attachment: [...others, FILE] } },
    after: { ...ISSUE, fields: { attachment: others } },
  });
  expect(await remove(request)).toEqual({ ok: true, receipt: RECEIPT });
  expect(request.mock.calls.filter(([, method]) => method === "DELETE")).toHaveLength(1);
});
