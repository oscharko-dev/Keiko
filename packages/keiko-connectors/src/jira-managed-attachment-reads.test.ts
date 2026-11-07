import { describe, expect, it, vi } from "vitest";
import { JIRA_ATTACHMENT_MAX_BYTES } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { AtlassianWriteHttpOutcome } from "./atlassian-write-http.js";
import { jiraAttachmentLimit } from "./jira-attachments.js";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import {
  executeJiraAttachmentRead,
  isJiraAttachmentRead,
  JIRA_ATTACHMENT_READS,
} from "./jira-managed-attachment-reads.js";

function request(
  body: Record<string, unknown>,
  status = 200,
): ReturnType<typeof vi.fn<JiraMutationRequest>> {
  return vi.fn<JiraMutationRequest>(() => Promise.resolve({ ok: true, status, body }));
}
const FILE = {
  filename: "design.pdf",
  size: 1200,
  mimeType: "application/pdf",
  created: "2026-11-07T10:00:00.000+0000",
};
const ENTRY = {
  entryIndex: 0,
  name: "folder/design.pdf",
  size: 1200,
  mediaType: "application/pdf",
};

describe("closed attachment metadata and archive reads", () => {
  it("reports the native limit and existing local ceiling without granting upload permission", async () => {
    const port = request({ enabled: true, uploadLimit: JIRA_ATTACHMENT_MAX_BYTES * 2 });
    expect(await executeJiraAttachmentRead("jira.attachment-settings", {}, port)).toEqual({
      data: {
        outcome: "succeeded",
        enabled: true,
        uploadLimit: JIRA_ATTACHMENT_MAX_BYTES * 2,
        maxBytes: JIRA_ATTACHMENT_MAX_BYTES,
      },
    });
    expect(port).toHaveBeenCalledExactlyOnceWith("attachment/meta");
  });
  it.each([true, false])(
    "keeps enabled=%s readable without inventing a missing limit",
    async (enabled) => {
      expect(
        await executeJiraAttachmentRead("jira.attachment-settings", {}, request({ enabled })),
      ).toEqual({ data: { outcome: "succeeded", enabled } });
    },
  );
  it("does not admit an upload when the enabled instance omits its limit", async () => {
    expect(await jiraAttachmentLimit(request({ enabled: true }))).toEqual({
      ok: false,
      reason: "malformed-payload",
    });
  });
  it("reads the selected metadata even when native AttachmentBean omits id and strips remote URLs/users", async () => {
    const port = request({
      ...FILE,
      self: "https://untrusted.invalid/self",
      content: "https://untrusted.invalid/download",
      thumbnail: "https://untrusted.invalid/image",
      author: { emailAddress: "private@example.invalid" },
    });
    expect(
      await executeJiraAttachmentRead(
        "jira.attachment",
        { attachmentId: "9007199254740993" },
        port,
      ),
    ).toEqual({ data: { outcome: "succeeded", attachmentId: "9007199254740993", ...FILE } });
    expect(port).toHaveBeenCalledExactlyOnceWith("attachment/9007199254740993");
  });
  it("omits null optional metadata without replacing it with invented values", async () => {
    expect(
      await executeJiraAttachmentRead(
        "jira.attachment",
        { attachmentId: "17" },
        request({ ...FILE, mimeType: null, created: null }),
      ),
    ).toEqual({
      data: { outcome: "succeeded", attachmentId: "17", filename: FILE.filename, size: FILE.size },
    });
  });
  it("pages only supplied raw entries and preserves the larger remote total", async () => {
    const port = request({ entries: [ENTRY, { ...ENTRY, entryIndex: 2 }], totalEntryCount: 9 });
    const result = await executeJiraAttachmentRead(
      "jira.attachment-archive",
      { attachmentId: "17", startAt: 0, maxResults: 1 },
      port,
    );
    expect(result.data).toEqual({
      outcome: "succeeded",
      attachmentId: "17",
      startAt: 0,
      total: 2,
      nextStartAt: 1,
      totalEntryCount: 9,
      entriesComplete: false,
      items: [ENTRY],
    });
    expect(port).toHaveBeenCalledExactlyOnceWith("attachment/17/expand/raw");
  });
  it.each([undefined, null])(
    "preserves unknown counts and per-entry size (%s)",
    async (unknown) => {
      const result = await executeJiraAttachmentRead(
        "jira.attachment-archive",
        { attachmentId: "17" },
        request({
          entries: [{ entryIndex: 0, abbreviatedName: "entry", size: unknown }],
          totalEntryCount: unknown,
        }),
      );
      expect(result.data).toEqual({
        outcome: "succeeded",
        attachmentId: "17",
        startAt: 0,
        total: 1,
        items: [{ entryIndex: 0, abbreviatedName: "entry" }],
      });
    },
  );
  it("reports empty supplied entries without asserting that the attachment is a valid archive", async () => {
    expect(
      (
        await executeJiraAttachmentRead(
          "jira.attachment-archive",
          { attachmentId: "17" },
          request({ entries: [], totalEntryCount: 0 }),
        )
      ).data,
    ).toEqual({
      outcome: "succeeded",
      attachmentId: "17",
      startAt: 0,
      total: 0,
      totalEntryCount: 0,
      entriesComplete: true,
      items: [],
    });
  });
  it("returns only documented human-summary fields and never opaque entries", async () => {
    const port = request({
      id: 17,
      name: "design.zip",
      mediaType: "application/zip",
      entries: { arbitrary: { content: "not-for-projection" } },
      totalEntryCount: 9,
    });
    expect(
      (
        await executeJiraAttachmentRead(
          "jira.attachment-archive-summary",
          { attachmentId: "17" },
          port,
        )
      ).data,
    ).toEqual({
      outcome: "succeeded",
      attachmentId: "17",
      name: "design.zip",
      mediaType: "application/zip",
      totalEntryCount: 9,
    });
    expect(port).toHaveBeenCalledExactlyOnceWith("attachment/17/expand/human");
  });
  it("leaves an unknown human-summary count omitted", async () => {
    const result = await executeJiraAttachmentRead(
      "jira.attachment-archive-summary",
      { attachmentId: "17" },
      request({ id: 17, totalEntryCount: null }),
    );
    expect(result.data).toEqual({ outcome: "succeeded", attachmentId: "17" });
  });
  it.each([
    ["jira.attachment-settings", { enabled: "true" }],
    ["jira.attachment-settings", { enabled: true, uploadLimit: "unknown" }],
    ["jira.attachment-settings", { enabled: true, uploadLimit: -1 }],
    ["jira.attachment", { ...FILE, id: "18" }],
    ["jira.attachment", { ...FILE, size: 9007199254740992 }],
    ["jira.attachment", { ...FILE, mimeType: {} }],
    ["jira.attachment-archive", { entries: {} }],
    ["jira.attachment-archive", { entries: [{ ...ENTRY, entryIndex: 0.5 }] }],
    ["jira.attachment-archive", { entries: [ENTRY, ENTRY] }],
    ["jira.attachment-archive", { entries: [{ ...ENTRY, size: -1 }] }],
    ["jira.attachment-archive", { entries: [ENTRY], totalEntryCount: 0 }],
    ["jira.attachment-archive", { entries: [], totalEntryCount: -1 }],
    ["jira.attachment-archive-summary", { id: 18 }],
    ["jira.attachment-archive-summary", { id: 9007199254740992 }],
  ] as const)("refuses malformed %s without a second request", async (name, body) => {
    const port = request(body);
    expect(
      (
        await executeJiraAttachmentRead(
          name,
          name === "jira.attachment-settings" ? {} : { attachmentId: "17" },
          port,
        )
      ).data.reason,
    ).toBe("malformed-payload");
    expect(port).toHaveBeenCalledTimes(1);
  });
  it.each([
    ["jira.attachment-settings", { attachmentId: "17" }],
    ["jira.attachment", { attachmentId: "../17" }],
    ["jira.attachment", { attachmentId: "17", url: "https://untrusted.invalid" }],
    ["jira.attachment-archive", { attachmentId: "17", startAt: null }],
    ["jira.attachment-archive", { attachmentId: "17", maxResults: 101 }],
    ["jira.attachment-archive-summary", { attachmentId: "17", startAt: 0 }],
  ] satisfies readonly (readonly [(typeof JIRA_ATTACHMENT_READS)[number], CatalogJsonObject])[])(
    "refuses unsupported %s arguments before I/O",
    async (name, args) => {
      const port = request({});
      expect((await executeJiraAttachmentRead(name, args, port)).data.reason).toBe("invalid-input");
      expect(port).not.toHaveBeenCalled();
    },
  );
  it("refuses an oversized source array before local pagination", async () => {
    const result = await executeJiraAttachmentRead(
      "jira.attachment-archive",
      { attachmentId: "17", maxResults: 1 },
      request({
        entries: Array.from({ length: 1001 }, (_, entryIndex) => ({ ...ENTRY, entryIndex })),
      }),
    );
    expect(result.data.reason).toBe("bounds-exceeded");
  });
  it("uses an exact local continuation when the shared byte bound shortens a page", async () => {
    const result = await executeJiraAttachmentRead(
      "jira.attachment-archive",
      { attachmentId: "17", maxResults: 100 },
      request({
        entries: Array.from({ length: 100 }, (_, entryIndex) => ({
          entryIndex,
          name: "界".repeat(1024),
          abbreviatedName: "界".repeat(1024),
        })),
      }),
    );
    const items = result.data.items;
    if (!Array.isArray(items)) throw new TypeError("Expected a bounded archive page");
    expect(result.data.outcome).toBe("succeeded");
    expect(items.length).toBeGreaterThan(0);
    expect(items.length).toBeLessThan(100);
    expect(result.data.nextStartAt).toBe(items.length);
    expect(result.data.total).toBe(100);
  });
  it.each(["auth-failed", "permission-denied", "conflict", "timeout"] as const)(
    "preserves %s with no alternate request",
    async (reason) => {
      const response: AtlassianWriteHttpOutcome = { ok: false, reason };
      const port = vi.fn<JiraMutationRequest>(() => Promise.resolve(response));
      expect(
        (await executeJiraAttachmentRead("jira.attachment-archive", { attachmentId: "17" }, port))
          .data.reason,
      ).toBe(reason);
      expect(port).toHaveBeenCalledTimes(1);
    },
  );
  it("accepts only the four registered read names", () => {
    for (const name of JIRA_ATTACHMENT_READS) expect(isJiraAttachmentRead(name)).toBe(true);
    expect(isJiraAttachmentRead("jira.attachment-delete")).toBe(false);
  });
});
