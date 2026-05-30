import { describe, it, expect } from "vitest";
import { sortProjects, sortChats } from "./sidebar-sort";
import type { ProjectWithAvailability, Chat } from "./types";

function makeProject(
  overrides: Partial<ProjectWithAvailability> & { path: string },
): ProjectWithAvailability {
  return {
    name: overrides.path,
    favorite: false,
    createdAt: 1000,
    lastOpenedAt: 0,
    available: true,
    ...overrides,
  };
}

function makeChat(overrides: Partial<Chat> & { id: string; projectPath: string }): Chat {
  return {
    title: "Chat",
    selectedModel: "model",
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

describe("sortProjects", () => {
  it("returns empty array for empty input", () => {
    expect(sortProjects([])).toEqual([]);
  });

  it("puts favorites first", () => {
    const projects = [
      makeProject({ path: "/a", favorite: false, lastOpenedAt: 9999 }),
      makeProject({ path: "/b", favorite: true, lastOpenedAt: 1 }),
    ];
    const sorted = sortProjects(projects);
    expect(sorted[0]?.path).toBe("/b");
    expect(sorted[1]?.path).toBe("/a");
  });

  it("sorts non-favorites by lastOpenedAt descending", () => {
    const projects = [
      makeProject({ path: "/a", favorite: false, lastOpenedAt: 100 }),
      makeProject({ path: "/b", favorite: false, lastOpenedAt: 200 }),
      makeProject({ path: "/c", favorite: false, lastOpenedAt: 50 }),
    ];
    const sorted = sortProjects(projects);
    expect(sorted.map((p) => p.path)).toEqual(["/b", "/a", "/c"]);
  });

  it("tie-breaks by path ascending when lastOpenedAt equal", () => {
    const projects = [
      makeProject({ path: "/z", favorite: false, lastOpenedAt: 100 }),
      makeProject({ path: "/a", favorite: false, lastOpenedAt: 100 }),
      makeProject({ path: "/m", favorite: false, lastOpenedAt: 100 }),
    ];
    const sorted = sortProjects(projects);
    expect(sorted.map((p) => p.path)).toEqual(["/a", "/m", "/z"]);
  });

  it("handles lastOpenedAt = 0 correctly", () => {
    const projects = [
      makeProject({ path: "/a", favorite: false, lastOpenedAt: 0 }),
      makeProject({ path: "/b", favorite: false, lastOpenedAt: 100 }),
    ];
    const sorted = sortProjects(projects);
    expect(sorted[0]?.path).toBe("/b");
  });

  it("does not mutate the original array", () => {
    const projects = [
      makeProject({ path: "/b", favorite: false, lastOpenedAt: 100 }),
      makeProject({ path: "/a", favorite: false, lastOpenedAt: 200 }),
    ];
    const original = [...projects];
    sortProjects(projects);
    expect(projects[0]?.path).toBe(original[0]?.path);
  });

  it("keeps favorite-to-favorite order by lastOpenedAt desc", () => {
    const projects = [
      makeProject({ path: "/a", favorite: true, lastOpenedAt: 100 }),
      makeProject({ path: "/b", favorite: true, lastOpenedAt: 200 }),
    ];
    const sorted = sortProjects(projects);
    expect(sorted[0]?.path).toBe("/b");
  });
});

describe("sortChats", () => {
  it("returns empty array for empty input", () => {
    expect(sortChats([])).toEqual([]);
  });

  it("sorts by updatedAt descending", () => {
    const chats = [
      makeChat({ id: "a", projectPath: "/p", updatedAt: 100 }),
      makeChat({ id: "b", projectPath: "/p", updatedAt: 300 }),
      makeChat({ id: "c", projectPath: "/p", updatedAt: 200 }),
    ];
    const sorted = sortChats(chats);
    expect(sorted.map((c) => c.id)).toEqual(["b", "c", "a"]);
  });

  it("tie-breaks by id ascending", () => {
    const chats = [
      makeChat({ id: "z", projectPath: "/p", updatedAt: 100 }),
      makeChat({ id: "a", projectPath: "/p", updatedAt: 100 }),
    ];
    const sorted = sortChats(chats);
    expect(sorted.map((c) => c.id)).toEqual(["a", "z"]);
  });

  it("does not mutate the original array", () => {
    const chats = [
      makeChat({ id: "b", projectPath: "/p", updatedAt: 100 }),
      makeChat({ id: "a", projectPath: "/p", updatedAt: 200 }),
    ];
    const firstId = chats[0]?.id;
    sortChats(chats);
    expect(chats[0]?.id).toBe(firstId);
  });
});
