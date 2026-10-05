import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectWorkspaceAt } from "./detect.js";
import { executeCodingRepositoryRequest } from "./codingRepositorySearch.js";
import { findFiles, readExcerpt, searchText, type SearchScope } from "./repoSearch.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "keiko-legacy-codecs-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});
function scope(): SearchScope {
  return {
    workspace: detectWorkspaceAt(root, undefined, { scanSourceFilesForLanguages: false }),
    scopeId: "legacy-codecs",
    relativePaths: [],
  };
}
function put(path: string, bytes: Uint8Array): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), bytes);
}
const query = {
  kind: "exact-symbol",
  text: "CodecServiceProbe",
  maxResults: 8,
  caseSensitive: true,
  emittedAtMs: 0,
} as const;
const path = "handbook/archive/edition/maintenance/service.html";
function manual(charset: string, encodedText: Uint8Array): Buffer {
  return Buffer.concat([
    Buffer.from(
      `<meta charset="${charset}">\n${"<!-- archived instructions -->\n".repeat(300)}<p>CodecServiceProbe `,
    ),
    encodedText,
    Buffer.from(" maintenance every 750 hours</p>\n"),
  ]);
}

describe("explicitly declared legacy HTML codecs", () => {
  it.each([
    '<meta charset=""><meta charset="utf-8">',
    '<meta charset="  "><meta charset="utf-8">',
    '<meta charset="utf-16">',
    '<meta charset="utf-16le">',
    '<meta charset="utf-16be">',
  ])("retains late physical coordinates for HTML declaration %s", async (declaration) => {
    put(
      path,
      Buffer.from(
        `${declaration}\r\n${"<!-- archived instructions -->\r\n".repeat(300)}<p>CodecServiceProbe Ölwechsel 中文 750 hours</p>\r\n`,
      ),
    );
    const selected = scope();
    const result = await searchText(selected, query);
    expect(result.coverage).toMatchObject({ incomplete: false, filesScanned: 1 });
    expect(result.atoms).toContainEqual(
      expect.objectContaining({ scopePath: path, lineRange: { startLine: 302, endLine: 302 } }),
    );
    const excerpt = await readExcerpt(selected, {
      scopePath: path,
      startLine: 302,
      endLine: 302,
      maxBytes: 512,
    });
    expect(excerpt.content).toBe("<p>CodecServiceProbe Ölwechsel 中文 750 hours</p>\r");
  });
  it.each([
    '<meta/charset="windows-1252">',
    '<meta http-equiv="Content-Type"content="text/html; charset=windows-1252">',
  ])("searches and reads compact encoding declaration %s", async (declaration) => {
    put(
      path,
      Buffer.from(`${declaration}\n<p>CodecServiceProbe Ölwechsel 750 hours</p>\n`, "latin1"),
    );
    const selected = scope();
    const result = await searchText(selected, query);
    expect(result.coverage.incomplete).toBe(false);
    expect(result.atoms).toContainEqual(
      expect.objectContaining({ scopePath: path, lineRange: { startLine: 2, endLine: 2 } }),
    );
    const excerpt = await readExcerpt(selected, {
      scopePath: path,
      startLine: 2,
      endLine: 2,
      maxBytes: 512,
    });
    expect(excerpt.content).toBe("<p>CodecServiceProbe Ölwechsel 750 hours</p>");
  });

  it.each([
    ["Shift_JIS", [0x82, 0xa0], "あ"],
    ["Big5", [0xa4, 0xa4, 0xa4, 0xe5], "中文"],
    ["ISO-2022-JP", [0x1b, 0x24, 0x42, 0x24, 0x22, 0x1b, 0x28, 0x42], "あ"],
  ] as const)("searches and reads a late %s fact without Git", async (charset, bytes, text) => {
    put(path, manual(charset, new Uint8Array(bytes)));
    const selected = scope();
    const result = await searchText(selected, query);
    expect(result.coverage.incomplete).toBe(false);
    expect(result.atoms).toContainEqual(
      expect.objectContaining({ scopePath: path, lineRange: { startLine: 302, endLine: 302 } }),
    );
    expect(
      (
        await readExcerpt(selected, {
          scopePath: path,
          startLine: 302,
          endLine: 302,
          maxBytes: 512,
        })
      ).content,
    ).toContain(`${text} maintenance every 750 hours`);
    const coding = await executeCodingRepositoryRequest(selected.workspace, {
      kind: "read",
      path,
      startLine: 302,
      endLine: 302,
      maxBytes: 512,
    });
    expect(coding.ok && coding.kind === "read" && coding.excerpt.snippet).toContain(text);
  });

  it.each([false, true])(
    "reports unavailable declared text as incomplete (other hit=%s)",
    async (withHit) => {
      put(path, manual("not-a-supported-codec", Buffer.from("ordinary text")));
      if (withHit) put("valid.txt", Buffer.from("CodecServiceProbe VALIDVALUE\n"));
      const selected = scope();
      const result = await searchText(selected, query);
      expect(result.atoms.map((atom) => atom.scopePath)).toEqual(withHit ? ["valid.txt"] : []);
      expect(result.coverage.incomplete).toBe(true);
      expect(result.coverage.reasons).toContain("io-error");
      expect(result.candidates).toContainEqual(
        expect.objectContaining({ scopePath: path, omitted: "tool-unavailable" }),
      );
      const listing = await findFiles(selected, { ...query, kind: "file-pattern", text: "**/*" });
      expect(listing.coverage.incomplete).toBe(true);
      await expect(
        readExcerpt(selected, { scopePath: path, startLine: 302, endLine: 302, maxBytes: 512 }),
      ).rejects.toMatchObject({ reason: "io-error" });
      await expect(
        executeCodingRepositoryRequest(selected.workspace, {
          kind: "read",
          path,
          startLine: 302,
          endLine: 302,
          maxBytes: 512,
        }),
      ).rejects.toMatchObject({ reason: "file-unreadable" });
    },
  );

  it.each([
    new Uint8Array([0x82]),
    new Uint8Array([0x82, 0xa0, 0]),
    new Uint8Array([0x82, 0xa0, ...Array<number>(200).fill(1)]),
  ])("keeps malformed or binary declared text excluded (%#)", async (bytes) => {
    put(
      path,
      Buffer.concat([Buffer.from('<meta charset="Shift_JIS">\nCodecServiceProbe '), bytes]),
    );
    const result = await searchText(scope(), query);
    expect(result.atoms).toEqual([]);
    expect(result.candidates).toContainEqual(
      expect.objectContaining({ scopePath: path, omitted: "binary" }),
    );
    await expect(
      readExcerpt(scope(), { scopePath: path, startLine: 2, endLine: 2, maxBytes: 512 }),
    ).rejects.toMatchObject({ reason: "binary" });
  });
});
