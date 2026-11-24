import { describe, expect, it } from "vitest";
import {
  assertFrequencyFloor,
  checkProperty,
  propertySettings,
  type Generator,
  type Random,
} from "../../../tests/support/property-testing.js";
import {
  CONNECTED_FOLDER_TOOL_LIMITS,
  captureConnectedFolderToolRequest,
} from "./connected-folder-tool.js";

/**
 * The request is model output. Whatever a model writes, the boundary must accept exactly the
 * well-formed requests: each case is a well-formed request, optionally damaged in one known way,
 * so the expected verdict comes from how the case was built and not from the validator.
 */

interface RequestCase {
  readonly request: Record<string, unknown>;
  readonly valid: boolean;
  readonly damage: string;
}

const SEGMENTS: readonly string[] = [
  "docs",
  "Projektablage",
  "19-Projekt-Saphir",
  "Finanzen",
  "Kosten-Q2.csv",
  "notes_2024",
  "Übersicht.md",
  "a",
  "v1.2",
];

const HOSTILE_PATHS: readonly unknown[] = [
  "../outside",
  "docs/../../outside",
  "/etc/passwd",
  "C:/Windows/win.ini",
  "docs\\guide.md",
  "docs/./guide.md",
  "~/secret",
  "docs/\u0000guide.md",
  7,
  null,
  ["docs"],
];

function relativePath(random: Random): string {
  const length = random.integer(1, 4);
  return Array.from({ length }, () => random.pick(SEGMENTS)).join("/");
}

function directory(random: Random): string {
  return random.chance(0.3) ? "" : relativePath(random);
}

function wellFormed(random: Random): Record<string, unknown> {
  const view = random.pick(["list", "search", "read"] as const);
  if (view === "list") return { view, directory: directory(random), after: directory(random) };
  if (view === "read") {
    return {
      view,
      path: relativePath(random),
      startLine: random.integer(1, 5_000),
      maxLines: random.integer(1, CONNECTED_FOLDER_TOOL_LIMITS.readLines),
    };
  }
  return {
    view,
    mode: random.pick(["keywords", "literal"] as const),
    query: "q".repeat(random.integer(1, CONNECTED_FOLDER_TOOL_LIMITS.queryChars)),
    directory: directory(random),
    maxResults: random.integer(1, CONNECTED_FOLDER_TOOL_LIMITS.searchHits),
  };
}

type Damage = (random: Random, request: Record<string, unknown>) => Record<string, unknown>;

function pathField(request: Record<string, unknown>): string {
  return request.view === "read" ? "path" : "directory";
}

const DAMAGES: readonly (readonly [string, Damage])[] = [
  ["extra key", (_random, request): Record<string, unknown> => ({ ...request, force: true })],
  [
    "missing key",
    (random, request): Record<string, unknown> => {
      const keys = Object.keys(request).filter((key) => key !== "view");
      const dropped = random.pick(keys);
      return Object.fromEntries(Object.entries(request).filter(([key]) => key !== dropped));
    },
  ],
  [
    "unknown view",
    (random, request): Record<string, unknown> => ({
      ...request,
      view: random.pick(["write", "", 1]),
    }),
  ],
  [
    "hostile path",
    (random, request): Record<string, unknown> => ({
      ...request,
      [pathField(request)]: random.pick(HOSTILE_PATHS),
    }),
  ],
  [
    "bound exceeded",
    (random, request): Record<string, unknown> => {
      if (request.view === "read") {
        return { ...request, maxLines: random.pick([0, -3, 201, 1.5, "5", Number.NaN]) };
      }
      if (request.view === "search") {
        return { ...request, maxResults: random.pick([0, 13, 2.5, "3", Number.POSITIVE_INFINITY]) };
      }
      return { ...request, after: random.pick(HOSTILE_PATHS) };
    },
  ],
  [
    "bad text",
    (random, request): Record<string, unknown> => {
      if (request.view === "search") {
        return { ...request, query: random.pick(["", "   ", "q".repeat(201), "a\u0007b", 5]) };
      }
      if (request.view === "read") return { ...request, startLine: random.pick([0, -1, 2.5, "1"]) };
      return { ...request, directory: random.pick(HOSTILE_PATHS) };
    },
  ],
];

const requestCase: Generator<RequestCase> = (random) => {
  const request = wellFormed(random);
  if (random.chance(0.4)) return { request, valid: true, damage: "none" };
  const [damage, apply] = random.pick(DAMAGES);
  return { request: apply(random, request), valid: false, damage };
};

describe("connected folder tool request boundary", () => {
  it("accepts exactly the well-formed requests", async () => {
    const name = "connected folder tool accepts exactly well-formed requests";
    const { runs } = propertySettings({ name, runs: 3_000 });
    let accepted = 0;
    const refused = new Map<string, number>();
    await checkProperty<RequestCase>({
      name,
      runs: 3_000,
      generate: requestCase,
      property: ({ request, valid, damage }) => {
        const captured = captureConnectedFolderToolRequest(request);
        expect(captured !== undefined, `${damage}: ${JSON.stringify(request)}`).toBe(valid);
        if (captured === undefined) {
          refused.set(damage, (refused.get(damage) ?? 0) + 1);
          return;
        }
        accepted += 1;
        expect(captured).toEqual(request);
        expect(Object.isFrozen(captured)).toBe(true);
      },
    });
    // Vacuity, validated at 3,000 runs: well-formed requests and every kind of damage must each
    // occur often. A replay with fewer runs is decided by the property's own assertions.
    const floor = { runs, validatedRuns: 3_000 };
    assertFrequencyFloor({
      ...floor,
      share: 1 / 4,
      what: "a well-formed request",
      count: accepted,
    });
    for (const [damage] of DAMAGES) {
      const count = refused.get(damage) ?? 0;
      assertFrequencyFloor({ ...floor, share: 1 / 40, what: `damage "${damage}"`, count });
    }
  });
});
