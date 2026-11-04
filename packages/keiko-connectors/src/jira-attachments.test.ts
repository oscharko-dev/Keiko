import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { AtlassianHttpBodyPort } from "./atlassian-http-port.js";
import {
  jiraAttachmentUpload,
  parseJiraAttachmentArguments,
  verifiedJiraAttachmentContent,
  type JiraAttachmentContent,
  type JiraAttachmentSource,
} from "./jira-attachments.js";
import { executeJiraManagedMutation } from "./jira-managed-mutations.js";
import {
  fixtureRead,
  fixtureWrite,
  response,
  SYNTHETIC_UPLOAD_LIMIT,
  type SyntheticJira,
} from "../../../tests/support/jira-managed-remote.js";

const SOURCE = { kind: "connected-file", path: "docs/report.txt" } as const;
function content(text = "report body", name = "report.txt"): JiraAttachmentContent {
  const bytes = new TextEncoder().encode(text);
  return { name, bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
}

describe("parseJiraAttachmentArguments", () => {
  it("admits one connected-file source and an optional plain name", () => {
    expect(parseJiraAttachmentArguments({ issueKey: "SYN-1", source: SOURCE })).toEqual({
      issueKey: "SYN-1",
      path: "docs/report.txt",
    });
    expect(
      parseJiraAttachmentArguments({ issueKey: "SYN-1", source: SOURCE, name: "final.txt" }),
    ).toMatchObject({ name: "final.txt" });
  });
  it.each<CatalogJsonObject>([
    { issueKey: "SYN-1" },
    { issueKey: "SYN-1", source: { kind: "host-path", path: "docs/report.txt" } },
    { issueKey: "SYN-1", source: { kind: "connected-file", path: "/etc/passwd" } },
    { issueKey: "SYN-1", source: { kind: "connected-file", path: "../outside.txt" } },
    { issueKey: "SYN-1", source: { kind: "connected-file", path: "C:\\secret.txt" } },
    { issueKey: "SYN-1", source: { kind: "connected-file", path: "~/secret.txt" } },
    { issueKey: "SYN-1", source: { ...SOURCE, extra: true } },
    { issueKey: "SYN-1", source: SOURCE, name: "a/b.txt" },
    { issueKey: "SYN-1", source: SOURCE, name: 'quote".txt' },
    { issueKey: "SYN-1", source: SOURCE, name: "line\nbreak.txt" },
    { issueKey: "SYN-1", source: SOURCE, name: ".." },
    { issueKey: "SYN-1", source: SOURCE, bytes: "inline" },
    { issueKey: "not a key", source: SOURCE },
  ])("refuses a request that could reach beyond a connected file %#", (args) => {
    expect(parseJiraAttachmentArguments(args)).toBeUndefined();
  });
});

describe("jiraAttachmentUpload", () => {
  it("builds one file part whose boundary the content cannot contain", () => {
    const upload = jiraAttachmentUpload(content(), "report.txt");
    const boundary = /boundary=(.+)$/u.exec(upload.contentType)?.[1] ?? "";
    expect(boundary.length).toBeGreaterThan(8);
    const text = Buffer.from(upload.bytes).toString("utf8");
    expect(text).toContain('name="file"; filename="report.txt"');
    expect(text.startsWith(`--${boundary}\r\n`)).toBe(true);
    expect(text.endsWith(`\r\n--${boundary}--\r\n`)).toBe(true);
    expect(text).toContain("report body");
  });
  it("carries non-text bytes unchanged", () => {
    const bytes = Uint8Array.from([0, 255, 13, 10, 45, 45, 128]);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const upload = jiraAttachmentUpload({ name: "x.bin", bytes, sha256 }, "x.bin");
    expect(Buffer.from(upload.bytes).includes(Buffer.from(bytes))).toBe(true);
  });
  it("moves its boundary when the content already contains the first candidate", () => {
    const first = jiraAttachmentUpload(content("plain"), "a.txt");
    const boundary = /boundary=(.+)$/u.exec(first.contentType)?.[1] ?? "";
    const hostile = content(`prefix ${boundary} suffix`);
    const second = jiraAttachmentUpload(hostile, "a.txt");
    expect(second.contentType).not.toContain(boundary);
    const own = /boundary=(.+)$/u.exec(second.contentType)?.[1] ?? "";
    const occurrences = Buffer.from(second.bytes).toString("utf8").split(`--${own}`).length - 1;
    expect(occurrences).toBe(2);
  });
});

describe("verifiedJiraAttachmentContent", () => {
  it("accepts content whose digest, name and size hold", () => {
    expect(verifiedJiraAttachmentContent(content(), 1024)).toBeUndefined();
  });
  it.each([
    ["an empty file", { ...content(""), bytes: new Uint8Array() }, 1024, "bounds-exceeded"],
    ["a file over the limit", content("x".repeat(33)), 32, "bounds-exceeded"],
    [
      "a digest that is not a SHA-256",
      { ...content(), sha256: "not-a-digest" },
      1024,
      "field-validation",
    ],
    ["a name that is not plain", { ...content(), name: "a/b" }, 1024, "field-validation"],
  ] as const)("refuses %s before any byte is sent", (_label, candidate, max, reason) => {
    expect(verifiedJiraAttachmentContent(candidate, max)).toMatchObject({ ok: false, reason });
  });
});

describe("jiraAttachmentUpload names", () => {
  const disposition = (name: string): string => {
    const text = Buffer.from(jiraAttachmentUpload(content(), name).bytes).toString("utf8");
    return /Content-Disposition: ([^\r]*)/u.exec(text)?.[1] ?? "";
  };
  it("sends an ASCII name as one plain filename", () => {
    expect(disposition("report.txt")).toBe('form-data; name="file"; filename="report.txt"');
  });
  it("sends a non-ASCII name as a sanitized filename plus the RFC 5987 extended form", () => {
    expect(disposition("Bericht \u00fc'(1).txt")).toBe(
      'form-data; name="file"; filename="Bericht _\'(1).txt"; filename*=UTF-8\'\'Bericht%20%C3%BC%27%281%29.txt',
    );
  });
});

interface Harness {
  readonly http: ReturnType<typeof vi.fn<AtlassianHttpBodyPort>>;
  readonly state: SyntheticJira;
  readonly source: ReturnType<typeof vi.fn<JiraAttachmentSource>>;
  readonly run: (args?: CatalogJsonObject) => ReturnType<typeof executeJiraManagedMutation>;
}
function harness(
  options: {
    readonly source?: JiraAttachmentSource | undefined;
    readonly meta?: { readonly enabled: boolean; readonly uploadLimit: number };
    readonly readback?: "omit" | "denied" | "renamed";
  } = {},
): Harness {
  const state: SyntheticJira = { fields: { summary: "Original" }, comment: "" };
  const http = vi.fn<AtlassianHttpBodyPort>((request) => {
    const path = new URL(request.url).pathname;
    if (request.method === "POST")
      return Promise.resolve(fixtureWrite(path, undefined, state, request.upload));
    if (path.endsWith("/attachment/meta") && options.meta !== undefined)
      return Promise.resolve(response(options.meta));
    if (options.readback === "omit" && path.endsWith("/issue/SYN-1"))
      return Promise.resolve(response({ id: "10001", key: "SYN-1", fields: { attachment: [] } }));
    if (options.readback === "denied" && path.endsWith("/issue/SYN-1"))
      return Promise.resolve(response({ errorMessages: ["No."] }, 403));
    if (options.readback === "renamed" && path.endsWith("/issue/SYN-1"))
      return Promise.resolve(
        response({
          id: "10001",
          key: "SYN-1",
          fields: { attachment: [{ id: "10300", filename: "other.txt", size: 11 }] },
        }),
      );
    return Promise.resolve(fixtureRead(path, state));
  });
  const source = vi.fn<JiraAttachmentSource>(
    options.source ??
      ((): ReturnType<JiraAttachmentSource> => Promise.resolve({ ok: true, content: content() })),
  );
  const connection = {
    deployment: "data-center",
    baseUrl: "https://jira.example.invalid/context",
    http,
    ...(Object.hasOwn(options, "source") && options.source === undefined
      ? {}
      : { attachmentSource: source }),
  } as const;
  return {
    http,
    state,
    source,
    run: (args = { issueKey: "SYN-1", source: SOURCE }) =>
      executeJiraManagedMutation(
        "jira.attach",
        args,
        {
          invocationId: "synthetic",
          correlationId: "synthetic",
          signal: new AbortController().signal,
          beforeEffect: () => true,
        },
        connection,
      ),
  };
}

describe("jira.attach", () => {
  it("uploads the governed bytes once, as multipart with the opt-out header's owner, and reads them back", async () => {
    const f = harness();
    expect(await f.run()).toEqual({
      ok: true,
      receipt: { issueKey: "SYN-1", attachmentId: "10300" },
    });
    expect(f.source).toHaveBeenCalledWith({
      kind: "connected-file",
      path: "docs/report.txt",
      maxBytes: SYNTHETIC_UPLOAD_LIMIT,
    });
    const posts = f.http.mock.calls.filter(([request]) => request.method === "POST");
    expect(posts).toHaveLength(1);
    const [request] = posts[0] ?? [];
    expect(request?.bodyJson).toBeUndefined();
    expect(request?.url).toBe(
      "https://jira.example.invalid/context/rest/api/2/issue/SYN-1/attachments",
    );
    expect(request?.upload?.contentType).toMatch(
      /^multipart\/form-data; boundary=keiko-[0-9a-f]{40}$/u,
    );
  });
  it("lowers the read bound to the instance's own upload limit and passes the requested name", async () => {
    const f = harness({ meta: { enabled: true, uploadLimit: 4096 } });
    await f.run({ issueKey: "SYN-1", source: SOURCE, name: "final.txt" });
    expect(f.source).toHaveBeenCalledWith(
      expect.objectContaining({ maxBytes: 4096, name: "final.txt" }),
    );
  });
  it("never reads a file when the instance has attachments switched off", async () => {
    const f = harness({ meta: { enabled: false, uploadLimit: 4096 } });
    expect(await f.run()).toEqual({ ok: false, reason: "unavailable" });
    expect(f.source).not.toHaveBeenCalled();
    expect(f.http.mock.calls.every(([request]) => request.method === "GET")).toBe(true);
  });
  it("refuses without a governed source port and without contacting Jira", async () => {
    const f = harness({ source: undefined });
    expect(await f.run()).toEqual({ ok: false, reason: "unavailable" });
    expect(f.http).not.toHaveBeenCalled();
  });
  it("returns the source's own refusal to the model and sends nothing", async () => {
    const f = harness({
      source: () =>
        Promise.resolve({
          ok: false,
          reason: "field-validation",
          detail: { fieldId: "source", validation: "invalid-field", messages: ["Not connected."] },
        }),
    });
    expect(await f.run()).toMatchObject({
      ok: false,
      reason: "field-validation",
      detail: { fieldId: "source", messages: ["Not connected."] },
    });
    expect(f.http.mock.calls.every(([request]) => request.method === "GET")).toBe(true);
  });
  it.each([
    ["a source that returns more than the instance allows", content("x".repeat(64)), 32],
    ["a source whose digest is not a SHA-256", { ...content(), sha256: "short" }, 4096],
  ] as const)("refuses %s before any byte is sent", async (_label, candidate, limit) => {
    const f = harness({
      source: () => Promise.resolve({ ok: true, content: candidate }),
      meta: { enabled: true, uploadLimit: limit },
    });
    expect(await f.run()).toMatchObject({ ok: false });
    expect(f.http.mock.calls.every(([request]) => request.method === "GET")).toBe(true);
  });
  it.each([
    [{ issueKey: "SYN-1" }],
    [{ issueKey: "SYN-1", source: { kind: "connected-file", path: "../x" } }],
    [{ issueKey: "SYN-1", source: SOURCE, extra: 1 }],
  ] as const)("refuses malformed arguments without reading or sending %#", async (args) => {
    const f = harness();
    expect(await f.run(args)).toMatchObject({ ok: false, reason: "field-validation" });
    expect(f.source).not.toHaveBeenCalled();
    expect(f.http).not.toHaveBeenCalled();
  });
  it("does not claim success when Jira's stored attachment cannot be read back", async () => {
    const f = harness({ readback: "omit" });
    expect(await f.run()).toEqual({ ok: false, reason: "conflict" });
    expect(f.http.mock.calls.filter(([request]) => request.method === "POST")).toHaveLength(1);
  });
  it("returns Jira's own refusal of the upload without a retry", async () => {
    const f = harness();
    f.http.mockImplementation((request) => {
      const path = new URL(request.url).pathname;
      if (request.method === "POST")
        return Promise.resolve(
          response({ errorMessages: ["The file is blocked."], errors: {} }, 400),
        );
      return Promise.resolve(fixtureRead(path, f.state));
    });
    expect(await f.run()).toMatchObject({
      ok: false,
      reason: "field-validation",
      detail: { messages: ["The file is blocked."] },
    });
    expect(f.http.mock.calls.filter(([request]) => request.method === "POST")).toHaveLength(1);
  });
  it("confirms a non-ASCII name against the sanitized spelling Jira stored", async () => {
    const f = harness({
      source: () => Promise.resolve({ ok: true, content: content("x", "B\u00fc.txt") }),
    });
    expect(await f.run({ issueKey: "SYN-1", source: SOURCE, name: "B\u00fc.txt" })).toMatchObject({
      ok: true,
      receipt: { attachmentId: "10300" },
    });
  });
  it("does not confirm an attachment Jira stored under another name", async () => {
    const f = harness({
      readback: "renamed",
      source: () => Promise.resolve({ ok: true, content: content("x".repeat(11)) }),
    });
    expect(await f.run()).toEqual({ ok: false, reason: "conflict" });
  });
  it("reports a refused readback as a closed failure, not as the HTTP outcome", async () => {
    const f = harness({ readback: "denied" });
    const result = await f.run();
    expect(result).toEqual({
      ok: false,
      reason: "permission-denied",
      detail: { messages: ["No."] },
    });
  });
});
