import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { nullSecurityLogSink } from "./log-port.js";
import { attestPortableTreeKht1Sync, hashPortableTreeKht1 } from "./portable-tree-attestation.js";

// The async tree walk advances one machine step per call through `runAsyncSteps`. A tree of 12,000
// files is tens of thousands of steps: written as `return advance()` from an async function, every
// step would leave a pending outer promise until the last one settled (hundreds of thousands live
// at once for a 60,000-entry tree), where the loop it replaced held constant memory. The digest
// must still be the one the synchronous machine verifies in a single pass.
describe("the asynchronous KHT1 tree walk over many steps", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("produces the digest the one-pass synchronous machine verifies", async () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-kht1-many-"));
    roots.push(root);
    for (let directory = 0; directory < 60; directory += 1) {
      const path = join(root, `d${String(directory)}`);
      mkdirSync(path);
      for (let file = 0; file < 200; file += 1)
        writeFileSync(join(path, `f${String(file)}.txt`), `${String(directory)}:${String(file)}\n`);
    }
    const deadline = Date.now() + 120_000;
    const digest = await hashPortableTreeKht1(root, {
      deadline,
      now: Date.now,
      yieldControl: () => Promise.resolve(),
      signal: undefined,
      securityLogSink: nullSecurityLogSink(),
    });
    expect(digest).toMatch(/^[0-9a-f]{64}$/u);
    expect(() => {
      attestPortableTreeKht1Sync(root, digest, deadline, nullSecurityLogSink());
    }).not.toThrow();
  }, 120_000);
});
