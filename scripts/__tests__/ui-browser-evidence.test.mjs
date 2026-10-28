import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createUiStaticFixtureServer,
  listenUiStaticFixtureServer,
} from "../lib/ui-browser-evidence.mjs";

const { fetch } = globalThis;

describe("shared UI browser evidence server", () => {
  let directory;
  let server;
  let base;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "keiko-ui-evidence-"));
    const root = join(directory, "public");
    await mkdir(join(root, "nested"), { recursive: true });
    await writeFile(join(root, "index.html"), "root fixture");
    await writeFile(join(root, "page.html"), "extension fixture");
    await writeFile(join(root, "nested/index.html"), "nested fixture");
    await writeFile(join(root, "style.css"), "body { margin: 0; }");
    server = await createUiStaticFixtureServer(root);
    await listenUiStaticFixtureServer(server, 0);
    base = "http://127.0.0.1:" + server.address().port;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });

  it.each([
    ["/", "root fixture", "text/html"],
    ["/page?fixture=true", "extension fixture", "text/html"],
    ["/nested/", "nested fixture", "text/html"],
    ["/style.css", "body { margin: 0; }", "text/css"],
  ])("preserves content, MIME type and caching for %s", async (path, content, mime) => {
    const response = await fetch(base + path);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(mime);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe(content);
  });

  it("rejects a realpath escape without reflecting outside content", async () => {
    await writeFile(join(directory, "outside.txt"), "outside fixture marker");
    await symlink(join(directory, "outside.txt"), join(directory, "public/escape.txt"));
    const response = await fetch(base + "/escape.txt");
    expect(response.status).toBe(403);
    expect(await response.text()).toBe("forbidden");
  });

  it("retains fixed missing-file and malformed-encoding responses", async () => {
    const missing = await fetch(base + "/missing");
    expect(missing.status).toBe(404);
    expect(await missing.text()).toBe("not found");
    const malformed = await fetch(base + "/%invalid");
    expect(malformed.status).toBe(500);
    expect(await malformed.text()).toBe("internal error");
  });

  it("rejects a colliding port instead of leaving a pending capture", async () => {
    const other = await createUiStaticFixtureServer(join(directory, "public"));
    await expect(listenUiStaticFixtureServer(other, server.address().port)).rejects.toMatchObject({
      code: "EADDRINUSE",
    });
  });
});
