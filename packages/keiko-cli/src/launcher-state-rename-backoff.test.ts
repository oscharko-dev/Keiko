import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WINDOWS_ATOMIC_RENAME_BACKOFF_MS } from "@oscharko-dev/keiko-security/fs-atomic-rename";
import { LAUNCHER_STATE_VERSION, saveState } from "./launcher-state.js";

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

describe("saveState rename backoff", () => {
  it("uses the 620ms Windows tree-swap series, not the short state-file default", () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-launcher-backoff-"));
    roots.push(root);
    saveState(root, { version: LAUNCHER_STATE_VERSION, entries: [] });
    expect(capturedBackoff).toEqual([WINDOWS_ATOMIC_RENAME_BACKOFF_MS]);
  });
});
