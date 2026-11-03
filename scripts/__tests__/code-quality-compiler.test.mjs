import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectPolicySubject } from "../lib/code-quality-inventory.mjs";
import { createSymbolResolver } from "../lib/code-quality-symbols.mjs";
import { createSymbolFixture } from "./support/code-quality-symbol-fixture.mjs";

const fixtures = [];
afterEach(() => {
  for (const { root, resolver } of fixtures.splice(0)) {
    resolver?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

// TypeScript's host decodes a UTF-8 byte-order mark away; the currentness check reads the file's
// own bytes, so the snapshot must hold those bytes (REVIEW-3918-052).
describe("compiler snapshot currentness", () => {
  it("keeps an unchanged non-input declaration with a byte-order mark current", async () => {
    const own = createSymbolFixture(false, ({ root, put }) => {
      put("node_modules/beta/package.json", { name: "beta", type: "module", types: "index.d.ts" });
      put("node_modules/beta/index.d.ts", "﻿export declare const beta: number;\n");
      const consumer = readFileSync(join(root, "src/consumer.ts"), "utf8");
      put(
        "src/consumer.ts",
        `${consumer}import { beta } from "beta"; export const third = beta;\n`,
      );
    });
    fixtures.push(own);
    own.resolver = createSymbolResolver(await collectPolicySubject(own.root));
    own.resolver.resolveExport({
      consumerPath: "src/consumer.ts",
      specifier: "alpha",
      exportName: "parse",
    });
    expect(() => own.resolver.assertCurrent()).not.toThrow();
    own.put("node_modules/beta/index.d.ts", "﻿export declare const beta: string;\n");
    expect(() => own.resolver.assertCurrent()).toThrow("symbol-subject-changed");
  });
});
