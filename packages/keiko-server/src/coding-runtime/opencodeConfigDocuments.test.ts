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
      global: [{ first: true }, { second: true }],
      project: [{ third: true }, { fourth: true }],
      refused: [],
    });
  });

  it("refuses a JSONC, a malformed, a writable-by-others and a non-object document", () => {
    const config = directory();
    writeFileSync(join(config, "opencode.jsonc"), "{}");
    writeFileSync(join(config, "config.json"), "{not json");
    writeFileSync(join(config, "opencode.json"), "{}");
    chmodSync(join(config, "opencode.json"), 0o666);
    expect(readGlobalConfigDocuments(config)).toEqual({
      documents: [],
      refused: ["unsupported-format", "config-malformed", "not-owner-private"],
    });
    expect(parsedConfigDocument("[1,2]")).toBe("config-malformed");
  });

  it("reads nothing from a missing configuration directory", () => {
    const missing = join(directory(), "absent");
    mkdirSync(join(missing, ".."), { recursive: true });
    expect(readGlobalConfigDocuments(missing)).toEqual({ documents: [], refused: [] });
  });
});
