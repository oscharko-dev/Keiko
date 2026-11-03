import { describe, expect, it } from "vitest";
import {
  CREDENTIAL_PATH_DENY_PATTERNS,
  ENV_EXAMPLE_BASENAME,
  TOOL_STATE_PATH_DENY_PATTERNS,
} from "./sensitive-path-patterns.js";

describe("sensitive path patterns", () => {
  it("are frozen, non-empty and disjoint", () => {
    expect(Object.isFrozen(CREDENTIAL_PATH_DENY_PATTERNS)).toBe(true);
    expect(Object.isFrozen(TOOL_STATE_PATH_DENY_PATTERNS)).toBe(true);
    expect(CREDENTIAL_PATH_DENY_PATTERNS.length).toBeGreaterThan(0);
    const toolState = new Set(TOOL_STATE_PATH_DENY_PATTERNS);
    expect(CREDENTIAL_PATH_DENY_PATTERNS.filter((pattern) => toolState.has(pattern))).toEqual([]);
  });

  it("keep the toolchain's own state out of the kernel-enforced credential subset", () => {
    for (const toolState of [".git", "node_modules", ".cache", ".config", ".gitconfig", ".keiko"])
      expect(CREDENTIAL_PATH_DENY_PATTERNS).not.toContain(toolState);
    for (const credential of [".env", ".env.*", ".ssh", ".aws", "id_rsa", "*.pem", ".npmrc"])
      expect(CREDENTIAL_PATH_DENY_PATTERNS).toContain(credential);
    expect(ENV_EXAMPLE_BASENAME).toBe(".env.example");
  });

  it("use only the segment alphabet the native sandbox can translate exactly", () => {
    for (const pattern of [...CREDENTIAL_PATH_DENY_PATTERNS, ...TOOL_STATE_PATH_DENY_PATTERNS])
      expect(pattern).toMatch(/^[A-Za-z0-9_.*-]+$/u);
  });
});
