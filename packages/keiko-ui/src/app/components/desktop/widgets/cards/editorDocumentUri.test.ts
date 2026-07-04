// GEN-MAINT-COMPLEXITY-001 — unit coverage for the pure URI/id helpers extracted from
// EditorRuntimeWidget. Pure functions of string args; no DOM, so this runs under node/jsdom.

import { describe, expect, it } from "vitest";
import {
  documentSessionKey,
  documentUri,
  encodePathSegments,
  rootHash,
  safeDomIdSegment,
} from "./editorDocumentUri";

describe("safeDomIdSegment", () => {
  it("keeps DOM-safe characters and replaces the rest with a dash", () => {
    expect(safeDomIdSegment("src/app/Main.tsx")).toBe("src-app-Main-tsx");
    expect(safeDomIdSegment("a_b-c9")).toBe("a_b-c9");
  });

  it("falls back to a stable id only when the sanitized result is empty", () => {
    expect(safeDomIdSegment("")).toBe("editor");
    // Disallowed characters become dashes rather than triggering the fallback.
    expect(safeDomIdSegment("///")).toBe("---");
  });
});

describe("rootHash", () => {
  it("is deterministic and returns an 8-char hex string", () => {
    const hash = rootHash("/home/user/project");
    expect(hash).toMatch(/^[0-9a-f]{8}$/u);
    expect(rootHash("/home/user/project")).toBe(hash);
  });

  it("distinguishes different roots", () => {
    expect(rootHash("/a")).not.toBe(rootHash("/b"));
  });

  it("hashes the empty root without throwing", () => {
    expect(rootHash("")).toMatch(/^[0-9a-f]{8}$/u);
  });
});

describe("encodePathSegments", () => {
  it("encodes each segment and normalizes separators", () => {
    expect(encodePathSegments("src/app/Main.tsx")).toBe("src/app/Main.tsx");
    expect(encodePathSegments("src\\app\\Main.tsx")).toBe("src/app/Main.tsx");
    expect(encodePathSegments("a b/c#d")).toBe("a%20b/c%23d");
  });

  it("collapses repeated separators", () => {
    expect(encodePathSegments("a//b")).toBe("a/b");
  });
});

describe("documentUri", () => {
  it("builds a filesystem-path-free, scope-and-root-qualified model URI", () => {
    const uri = documentUri("/home/user/project", "src/app/Main.tsx", "win-1");
    expect(uri).toBe(
      `keiko-editor://workspace/win-1/${rootHash("/home/user/project")}/src/app/Main.tsx`,
    );
    expect(uri).not.toContain("/home/user/project");
  });

  it("varies by root, file, and scope", () => {
    const base = documentUri("/r", "f.ts", "s");
    expect(documentUri("/r2", "f.ts", "s")).not.toBe(base);
    expect(documentUri("/r", "g.ts", "s")).not.toBe(base);
    expect(documentUri("/r", "f.ts", "s2")).not.toBe(base);
  });
});

describe("documentSessionKey", () => {
  it("joins root and file with a NUL separator that cannot appear in a path", () => {
    expect(documentSessionKey("/r", "a/b.ts")).toBe("/r\u0000a/b.ts");
  });

  it("does not collide across a boundary shift between root and file", () => {
    expect(documentSessionKey("/r/a", "b.ts")).not.toBe(documentSessionKey("/r", "a/b.ts"));
  });
});
