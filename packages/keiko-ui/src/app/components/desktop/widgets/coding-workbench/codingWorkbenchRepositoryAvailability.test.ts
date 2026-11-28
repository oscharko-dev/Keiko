import { describe, expect, it } from "vitest";
import type { ProjectWithAvailability } from "@/lib/types";
import { needsReconnect } from "./codingWorkbenchRepositoryAvailability";

function entry(patch: Partial<ProjectWithAvailability>): ProjectWithAvailability {
  return {
    path: "/work/app",
    name: "app",
    favorite: false,
    createdAt: 1,
    lastOpenedAt: 1,
    available: true,
    ...patch,
  };
}

describe("needsReconnect (U-16)", () => {
  it("is true only for an existing, readable folder whose workspace is reported not current", () => {
    expect(needsReconnect(entry({ workspaceAvailable: false }))).toBe(true);
    expect(needsReconnect(entry({ workspaceAvailable: false, readable: true }))).toBe(true);
  });

  it("is false when the workspace is current or not reported (fails closed)", () => {
    expect(needsReconnect(entry({ workspaceAvailable: true }))).toBe(false);
    expect(needsReconnect(entry({}))).toBe(false);
  });

  it("is false for a missing or refused folder whatever its workspace says", () => {
    for (const workspaceAvailable of [undefined, false, true]) {
      const base = workspaceAvailable === undefined ? {} : { workspaceAvailable };
      expect(needsReconnect(entry({ ...base, available: false }))).toBe(false);
      expect(needsReconnect(entry({ ...base, readable: false }))).toBe(false);
    }
  });
});
