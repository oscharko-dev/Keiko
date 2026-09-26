import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WINDOWS_ATOMIC_RENAME_BACKOFF_MS } from "@oscharko-dev/keiko-security/fs-atomic-rename";
import { writeFailedRegistration } from "./portable-registration.js";

const capturedBackoff: unknown[] = [];

vi.mock("@oscharko-dev/keiko-security/fs-atomic-rename", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@oscharko-dev/keiko-security/fs-atomic-rename")>();
  return {
    ...actual,
    atomicPublishRename: (
      from: string,
      to: string,
      options?: Parameters<typeof actual.atomicPublishRename>[2],
    ): void => {
      capturedBackoff.push(options?.backoffMs);
      actual.atomicPublishRename(from, to, options);
    },
  };
});

const roots: string[] = [];

afterEach(() => {
  capturedBackoff.length = 0;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("writeFailedRegistration rename backoff", () => {
  it("uses the 620ms Windows tree-swap series, not the short state-file default", () => {
    const base = join(homedir(), ".keiko-test-roots");
    mkdirSync(base, { recursive: true });
    const root = mkdtempSync(join(base, "keiko-registration-backoff-"));
    roots.push(root);
    writeFailedRegistration(
      "macos-arm64",
      root,
      new Date("2026-08-31T00:00:00.000Z"),
      "simulated setup failure",
    );
    expect(capturedBackoff).toEqual([WINDOWS_ATOMIC_RENAME_BACKOFF_MS]);
  });
});
