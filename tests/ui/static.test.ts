import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join, sep } from "node:path";
import { PassThrough } from "node:stream";
import type { ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveContainedPath, serveFile } from "../../src/ui/static.js";

const ROOT = resolve("/var/app/dist/ui/static");

describe("resolveContainedPath", () => {
  it("resolves a normal nested asset within the root", () => {
    const result = resolveContainedPath(ROOT, "/_next/static/chunk.js");
    expect(result).toBe(resolve(ROOT, "_next/static/chunk.js"));
  });

  it("resolves the index document", () => {
    expect(resolveContainedPath(ROOT, "/index.html")).toBe(resolve(ROOT, "index.html"));
  });

  it("clamps a parent-directory traversal inside the root (never escapes)", () => {
    const result = resolveContainedPath(ROOT, "/../../etc/passwd");
    expect(result).toBeDefined();
    expect(result?.startsWith(ROOT + sep)).toBe(true);
    expect(result).not.toBe(resolve("/etc/passwd"));
  });

  it("clamps an encoded traversal (%2e%2e) inside the root", () => {
    const result = resolveContainedPath(ROOT, "/%2e%2e/%2e%2e/etc/passwd");
    expect(result).toBeDefined();
    expect(result?.startsWith(ROOT + sep)).toBe(true);
  });

  it("rejects an embedded NUL byte", () => {
    expect(resolveContainedPath(ROOT, "/index.html%00.png")).toBeUndefined();
  });

  it("rejects a malformed percent-encoding", () => {
    expect(resolveContainedPath(ROOT, "/%zz")).toBeUndefined();
  });

  it("clamps a sibling-directory traversal inside the root", () => {
    // A `../static-evil` attempt is neutralized: the leading `..` collapses against root, so the
    // result stays inside the contained root rather than reaching the sibling directory.
    const result = resolveContainedPath(ROOT, "/../static-evil/secret");
    expect(result).toBeDefined();
    expect(result?.startsWith(ROOT + sep)).toBe(true);
  });

  it("keeps the root itself contained", () => {
    const result = resolveContainedPath(ROOT, "/");
    expect(result).toBe(ROOT);
  });

  it("contained results never leave the root", () => {
    const result = resolveContainedPath(ROOT, "/a/b/c.css");
    expect(result?.startsWith(ROOT + sep)).toBe(true);
  });
});

// A minimal ServerResponse stand-in: a writable stream with the header setters serveFile touches.
// The PassThrough is returned alongside so a test can drain it before its temp dir is removed
// (serveFile returns before the piped read finishes; draining avoids a late ENOENT on cleanup).
function fakeRes(): { res: ServerResponse; stream: PassThrough } {
  const stream = new PassThrough();
  const res = stream as unknown as ServerResponse & { statusCode: number };
  res.statusCode = 0;
  res.setHeader = (): ServerResponse => res;
  return { res, stream };
}

function drained(stream: PassThrough): Promise<void> {
  return new Promise<void>((resolve) => {
    stream.on("end", resolve);
    stream.resume();
  });
}

describe("serveFile (FIX 5 — symlink-safe static serving)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "keiko-static-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("serves a regular file", async () => {
    const file = join(dir, "asset.css");
    writeFileSync(file, "body{}");
    const { res, stream } = fakeRes();
    expect(await serveFile(res, file)).toBe(true);
    await drained(stream);
  });

  it("refuses a symlink even when it points to a regular file inside the root", async () => {
    const target = join(dir, "real.css");
    writeFileSync(target, "body{}");
    const link = join(dir, "link.css");
    symlinkSync(target, link);
    expect(await serveFile(fakeRes().res, link)).toBe(false);
  });

  it("returns false for a missing path", async () => {
    expect(await serveFile(fakeRes().res, join(dir, "nope.js"))).toBe(false);
  });
});
