import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  parsedConfigDocument,
  readConfigDocuments,
  readGlobalConfigDocuments,
} from "./opencodeConfigDocuments.js";
import type {
  SecureWorkspaceTextReadPort,
  SecureWorkspaceTextReadResult,
} from "./secureWorkspaceTextRead.js";

describe("OpenCode configuration documents (#3900 AC3/AC4)", () => {
  const created: string[] = [];
  afterEach(() => {
    for (const directory of created.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  function directory(): string {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-config-documents-")));
    created.push(root);
    return root;
  }

  function workspace(files: Readonly<Record<string, string>>): SecureWorkspaceTextReadPort {
    return {
      readText: ({ relativePath }): Promise<SecureWorkspaceTextReadResult> => {
        const text = files[relativePath];
        return Promise.resolve(
          text === undefined ? { ok: false, reason: "not-found" } : { ok: true, text },
        );
      },
    };
  }

  it("reads the global documents in merge order, then the project's", async () => {
    const config = directory();
    writeFileSync(join(config, "config.json"), '{"first":true}');
    writeFileSync(join(config, "opencode.json"), '﻿{"second":true}');
    const documents = await readConfigDocuments(
      config,
      workspace({
        "opencode.json": '{"third":true}',
        ".opencode/opencode.json": '{"fourth":true}',
      }),
    );
    expect(documents).toEqual({
      global: [{ second: true }],
      project: [{ third: true }, { fourth: true }],
      refused: [],
    });
  });

  it("refuses malformed, writable-by-others and non-object documents", () => {
    const config = directory();
    writeFileSync(join(config, "opencode.jsonc"), "{not json");
    writeFileSync(join(config, "config.json"), "{not json");
    writeFileSync(join(config, "opencode.json"), "{}");
    chmodSync(join(config, "opencode.json"), 0o666);
    expect(readGlobalConfigDocuments(config)).toEqual({
      documents: [],
      refused: ["not-owner-private", "config-malformed"],
    });
    expect(parsedConfigDocument("[1,2]")).toBe("config-malformed");
  });

  it("reads global JSONC after JSON and refuses malformed partial documents", () => {
    const config = directory();
    writeFileSync(join(config, "config.json"), '{"order":1}');
    writeFileSync(join(config, "opencode.json"), '{"order":2}');
    writeFileSync(
      join(config, "opencode.jsonc"),
      '// global\n{"order":3,"instructions":["guide.md"],"formatter":false,}',
    );
    expect(readGlobalConfigDocuments(config)).toEqual({
      documents: [{ order: 2 }, { order: 3, instructions: ["guide.md"], formatter: false }],
      refused: [],
    });
    writeFileSync(
      join(config, "opencode.jsonc"),
      '{"instructions":["must-not-partially-load.md"],"broken":',
    );
    expect(readGlobalConfigDocuments(config)).toEqual({
      documents: [{ order: 2 }],
      refused: ["config-malformed"],
    });
  });

  it("uses the shared JSONC parser for project instructions, formatters and agents in merge order", async () => {
    const documents = await readConfigDocuments(
      directory(),
      workspace({
        "opencode.json": '{"first":true}',
        "opencode.jsonc": '// root\n{"instructions":["docs/*.md"],}',
        ".opencode/opencode.json": '{"third":true}',
        ".opencode/opencode.jsonc":
          '{/* nested */"formatter":{"probe":{"disabled":true}},"agents":{"review":{"system":"Review"}},}',
      }),
    );
    expect(documents.project).toEqual([
      { first: true },
      { instructions: ["docs/*.md"] },
      { third: true },
      { formatter: { probe: { disabled: true } }, agents: { review: { system: "Review" } } },
    ]);
    expect(documents.refused).toEqual([]);
  });

  it("refuses malformed or partial configuration while both extensions accept JSONC", () => {
    for (const text of [
      '{"instructions":["safe.md"],"broken":',
      '{"agents":{}, trailing}',
      "[]",
      "null",
    ]) {
      expect(parsedConfigDocument(text, "jsonc")).toBe("config-malformed");
    }
    expect(parsedConfigDocument('// comment\n{"instructions":[],}')).toEqual({ instructions: [] });
  });

  it.each([
    '{"__proto__":{"instructions":["inherited.md"]}}',
    '{"agents":{"review":{"__proto__":{"model":"inherited"}}}}',
    '{"instructions":[{"__proto__":{"hidden":true}}]}',
    '{"__proto__":null}',
  ])("refuses non-plain objects produced by hostile configuration keys: %s", (text) => {
    expect(parsedConfigDocument(text, "jsonc")).toBe("config-malformed");
    expect(parsedConfigDocument(text, "json")).toBe("config-malformed");
  });

  it("reads nothing from a missing configuration directory", () => {
    const missing = join(directory(), "absent");
    mkdirSync(join(missing, ".."), { recursive: true });
    expect(readGlobalConfigDocuments(missing)).toEqual({ documents: [], refused: [] });
  });
});
