import { Buffer } from "node:buffer";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { provisionJiraApiSources } from "../provision-jira-api-sources.mjs";
import { checkJiraApiInventory } from "../check-jira-api-inventory.mjs";
import { jiraApiSourcePath } from "../lib/jira-api-sources.mjs";
import { jiraInventoryFixture } from "./jira-api-inventory.fixture.mjs";

const temporary = [];
function fixture(cacheSources = false) {
  const directory = mkdtempSync(join(tmpdir(), "keiko-provision-jira-"));
  temporary.push(directory);
  const result = jiraInventoryFixture(directory, { cacheSources });
  return {
    ...result,
    fetchSource: vi.fn((url) =>
      Promise.resolve(new globalThis.Response(result.sourceBytes.get(url))),
    ),
  };
}
function provision(input, fetchSource = input.fetchSource) {
  return provisionJiraApiSources({
    provenance: input.provenance,
    cache: input.cacheDirectory,
    fetchSource,
  });
}
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("on-demand Jira source provisioning", () => {
  it("downloads canonical URLs without credentials or redirects and retains exact validated bytes", async () => {
    const input = fixture();
    await expect(provision(input)).resolves.toEqual({ verifiedSources: 4, downloadedSources: 4 });
    expect(input.fetchSource).toHaveBeenCalledTimes(4);
    for (const [url, options] of input.fetchSource.mock.calls) {
      expect(input.sourceBytes.has(url)).toBe(true);
      expect(options.redirect).toBe("error");
      expect(options.credentials).toBe("omit");
      expect(options.referrerPolicy).toBe("no-referrer");
      expect(options.headers).toEqual({ accept: "application/json" });
      expect(options.signal).toBeInstanceOf(globalThis.AbortSignal);
    }
    for (const source of input.provenance.sources)
      expect(readFileSync(jiraApiSourcePath(input.cacheDirectory, source))).toEqual(
        input.sourceBytes.get(source.url),
      );
    expect(
      checkJiraApiInventory(input.directory, {
        reconcileSources: true,
        cacheDirectory: input.cacheDirectory,
        registryFile: input.registryFile,
      }),
    ).toMatchObject({ ok: true, verification: "sources" });
  });

  it("reuses verified originals without network access", async () => {
    const input = fixture(true);
    await expect(provision(input)).resolves.toEqual({ verifiedSources: 4, downloadedSources: 0 });
    expect(input.fetchSource).not.toHaveBeenCalled();
  });

  it("replaces corrupt cached bytes only after a new download matches the pin", async () => {
    const input = fixture(true);
    writeFileSync(jiraApiSourcePath(input.cacheDirectory, input.provenance.sources[0]), "corrupt");
    await expect(provision(input)).resolves.toEqual({ verifiedSources: 4, downloadedSources: 1 });
    expect(
      checkJiraApiInventory(input.directory, {
        reconcileSources: true,
        cacheDirectory: input.cacheDirectory,
        registryFile: input.registryFile,
      }).ok,
    ).toBe(true);
  });

  it("refuses unpinned URLs before the first request", async () => {
    const input = fixture();
    input.provenance.sources[0].url = "https://example.invalid/unapproved";
    await expect(provision(input)).rejects.toThrow("source-url");
    expect(input.fetchSource).not.toHaveBeenCalled();
  });

  it("refuses a redirect response without following its destination", async () => {
    const input = fixture();
    const fetchSource = vi.fn(() =>
      Promise.resolve(
        new globalThis.Response(null, {
          status: 302,
          headers: { location: "https://example.invalid/unapproved" },
        }),
      ),
    );
    await expect(provision(input, fetchSource)).rejects.toThrow("download-status");
    expect(fetchSource.mock.calls.every(([url]) => input.sourceBytes.has(url))).toBe(true);
  });

  it("rejects different bytes of the expected length without installing them", async () => {
    const input = fixture();
    const fetchSource = (url) =>
      Promise.resolve(
        new globalThis.Response(Buffer.alloc(input.sourceBytes.get(url).length, 120)),
      );
    await expect(provision(input, fetchSource)).rejects.toThrow("source-digest");
    expect(
      checkJiraApiInventory(input.directory, {
        reconcileSources: true,
        cacheDirectory: input.cacheDirectory,
        registryFile: input.registryFile,
      }).ok,
    ).toBe(false);
  });

  it("stops oversized response streams at the pinned byte ceiling", async () => {
    const input = fixture();
    const cancelled = vi.fn();
    const fetchSource = (url) =>
      Promise.resolve(
        new globalThis.Response(
          new globalThis.ReadableStream({
            start: (controller) =>
              controller.enqueue(Buffer.concat([input.sourceBytes.get(url), Buffer.from(" ")])),
            cancel: cancelled,
          }),
        ),
      );
    await expect(provision(input, fetchSource)).rejects.toThrow("download-byte-bound");
    expect(cancelled).toHaveBeenCalledTimes(4);
  });

  it("refuses a symlink cache before writing or downloading", async () => {
    const input = fixture();
    const outside = join(input.directory, "outside");
    mkdirSync(outside);
    symlinkSync(outside, input.cacheDirectory, "dir");
    await expect(provision(input)).rejects.toThrow("source-cache-directory");
    expect(input.fetchSource).not.toHaveBeenCalled();
  });
});
