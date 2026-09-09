import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readState,
  writeState,
  type DeliveryProviderState,
} from "../servers/coding-issue-delivery-transport.mjs";

const interception = vi.hoisted(() => ({ afterWrite: undefined as (() => void) | undefined }));
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return {
    ...fs,
    writeFileSync: (...args: Parameters<typeof fs.writeFileSync>): void => {
      fs.writeFileSync(...args);
      const callback = interception.afterWrite;
      interception.afterWrite = undefined;
      callback?.();
    },
  };
});

const directories: string[] = [];
afterEach(() => {
  interception.afterWrite = undefined;
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("delivery provider fixture state", () => {
  it("publishes complete snapshots when another writer finishes before the first rename", () => {
    const dir = mkdtempSync(join(tmpdir(), "keiko-delivery-state-"));
    directories.push(dir);
    const initial: DeliveryProviderState = {
      headRef: "initial",
      pushes: 0,
      creates: 0,
      rejections: 0,
      mode: "normal",
      pullRequests: [],
      pullRequestBodies: {},
    };
    writeState(dir, initial);
    const outer = { ...initial, headRef: "outer-longer-ref" };
    const inner = { ...initial, headRef: "inner" };
    interception.afterWrite = (): void => {
      expect(readState(dir)).toEqual(initial);
      writeState(dir, inner);
      expect(readState(dir)).toEqual(inner);
    };
    expect(() => {
      writeState(dir, outer);
    }).not.toThrow();
    expect(readState(dir)).toEqual(outer);
  });
});
