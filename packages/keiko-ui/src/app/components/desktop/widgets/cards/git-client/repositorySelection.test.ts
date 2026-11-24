import { describe, expect, it } from "vitest";
import type { ProjectWithAvailability } from "@/lib/types";
import {
  decideRepositorySelection,
  handedOffRepositoryPath,
  type RepositorySelectionInput,
} from "./repositorySelection";

const LISTED: ProjectWithAvailability = {
  path: "/repos/listed",
  name: "listed",
  favorite: false,
  createdAt: 0,
  lastOpenedAt: 0,
  available: true,
  workspaceAvailable: true,
};

function input(overrides: Partial<RepositorySelectionInput> = {}): RepositorySelectionInput {
  return {
    lockedToActiveRoot: false,
    configuredPath: LISTED.path,
    handOffPending: false,
    selectedPath: null,
    reposLoading: false,
    reposListFailed: false,
    reposError: null,
    repositories: [LISTED],
    ...overrides,
  };
}

describe("decideRepositorySelection (#4103 F2)", () => {
  it.each([
    ["the repository list is loading", { reposLoading: true }],
    ["the repository list failed to load", { reposListFailed: true, reposError: "list failed" }],
  ])("waits while %s, even for an explicit hand-off", (_case, overrides) => {
    expect(decideRepositorySelection(input({ handOffPending: true, ...overrides }))).toStrictEqual({
      kind: "wait",
    });
  });

  it("keeps the window where it is after an error about one repository without a hand-off", () => {
    expect(decideRepositorySelection(input({ reposError: "unavailable" }))).toStrictEqual({
      kind: "wait",
    });
  });

  // CodeRabbit on #4553: a refused repository A must not block a later hand-off of repository B.
  it("lets an explicit hand-off supersede an error about an earlier repository", () => {
    expect(
      decideRepositorySelection(input({ handOffPending: true, reposError: "A is unavailable" })),
    ).toStrictEqual({ kind: "select", path: LISTED.path, endsHandOff: true });
  });

  it("connects a handed-off folder that is not listed despite an earlier error", () => {
    expect(
      decideRepositorySelection(
        input({ handOffPending: true, configuredPath: "/repos/new", reposError: "A failed" }),
      ),
    ).toStrictEqual({ kind: "connect-hand-off", path: "/repos/new" });
  });
});

describe("handedOffRepositoryPath", () => {
  it.each([
    [true, false, "/repos/a", "/repos/a"],
    [false, false, "/repos/a", null],
    [true, true, "/repos/a", null],
    [true, false, null, null],
  ])(
    "pending %s, locked %s, configured %s gives %s",
    (handOffPending, lockedToActiveRoot, configuredPath, expected) => {
      expect(handedOffRepositoryPath({ handOffPending, lockedToActiveRoot, configuredPath })).toBe(
        expected,
      );
    },
  );
});
