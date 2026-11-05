import { Buffer } from "node:buffer";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  INSTRUMENT_FILES,
  digestFiles,
  instrumentDigest,
  productDistDigest,
} from "../testing/memory-lab/instrument.mjs";

const LAB = join(import.meta.dirname, "..", "testing", "memory-lab");

describe("the instrument digest of a run", () => {
  it("names existing lab files, sorted, and digests this checkout's instrument stably", () => {
    expect(INSTRUMENT_FILES).toEqual([...INSTRUMENT_FILES].toSorted());
    for (const name of INSTRUMENT_FILES) expect(existsSync(join(LAB, name)), name).toBe(true);
    const digest = instrumentDigest();
    expect(digest).toMatch(/^[0-9a-f]{64}$/u);
    expect(instrumentDigest()).toBe(digest);
  });

  // This list has drifted from the code twice, and an operator reads it to know what breaks comparison.
  it("is named in full on the lab's page, every file of it", () => {
    const page = readFileSync(join(LAB, "../../../docs/qa/memoria-viva-lab.md"), "utf8");
    const start = page.indexOf("`INSTRUMENT_FILES` in `instrument.mjs`:");
    const paragraph = page.slice(start, page.indexOf("), beside", start)).replace(/\s+/gu, " ");
    expect(start).toBeGreaterThan(0);
    const named = [...paragraph.matchAll(/`([\w./-]+\.mjs)`/gu)].map((match) => match[1]);
    expect(named.filter((name) => name !== "instrument.mjs")).toEqual([...INSTRUMENT_FILES]);
  });

  it("changes with a file's content and with its name, not with the reader", () => {
    const files = { "a.mjs": "export const a = 1;\n", "b.mjs": "export const b = 2;\n" };
    const read = (name) => files[name];
    const base = digestFiles(Object.keys(files), read);
    expect(digestFiles(Object.keys(files), (name) => Buffer.from(files[name]))).toBe(base);
    expect(digestFiles(Object.keys(files), (name) => `${files[name]} `)).not.toBe(base);
    expect(digestFiles(["a.mjs", "c.mjs"], (name) => files[name] ?? files["b.mjs"])).not.toBe(base);
    expect(digestFiles(["b.mjs", "a.mjs"], read)).not.toBe(base);
  });
});

describe("the digest of the measured product's built packages", () => {
  let root;
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  function checkout(files) {
    root = mkdtempSync(join(tmpdir(), "memory-lab-dist-"));
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(join(root, path, ".."), { recursive: true });
      writeFileSync(join(root, path), text);
    }
    return root;
  }

  it("covers every built .js file by relative path and changes when one changes", () => {
    const first = productDistDigest(
      checkout({
        "packages/one/dist/index.js": "export {};\n",
        "packages/two/dist/nested/x.js": "export const x = 1;\n",
        "packages/two/dist/x.d.ts": "export declare const x: number;\n",
      }),
    );
    expect(first).toMatch(/^[0-9a-f]{64}$/u);
    rmSync(root, { recursive: true, force: true });
    const changed = productDistDigest(
      checkout({
        "packages/one/dist/index.js": "export {};\n",
        "packages/two/dist/nested/x.js": "export const x = 2;\n",
      }),
    );
    expect(changed).not.toBe(first);
  });

  it("is unavailable, not a digest of nothing, when no package is built", () => {
    expect(productDistDigest(checkout({ "packages/one/src/index.ts": "export {};\n" }))).toBe(
      "unavailable",
    );
    expect(productDistDigest(join(tmpdir(), "memory-lab-no-such-checkout"))).toBe("unavailable");
  });
});
