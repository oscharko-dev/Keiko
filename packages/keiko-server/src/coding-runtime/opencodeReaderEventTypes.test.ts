import { existsSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  OPENCODE_PINNED_VERSION,
  OPENCODE_RUNTIME_VERSION_PINS,
} from "./opencodeRuntimeVersions.js";

// Every pinned runtime version's committed protocol-surface capture that exists; the current pin's
// follows the constant, so no version is restated here.
const FIXTURES = OPENCODE_RUNTIME_VERSION_PINS.map(
  (pin) => `opencodeProtocolSurface.opencode-${pin.version}.fixture.json`,
).filter((name) => existsSync(new URL(name, import.meta.url)));

/**
 * Event types a reader of the runtime's history depends on that no pinned protocol-surface fixture
 * names. A context-usage reader of exactly this kind (`message.updated.1`) read nothing in every
 * real run and nobody noticed (#4359). The list may only shrink, and every entry says which
 * profile emits the type and why the reader stays: witness a type in a fixture and remove its
 * entry, or remove its reader. A new reader type that is neither witnessed nor listed fails.
 *
 * The three types below belong to the legacy V1 sync-history parser (`POST /sync/history`,
 * `createOpenCodeHttpClient`). No pinned runtime profile emits them: production reads the V2
 * message API (`opencodeV2History.ts`, `createOpenCodeV2HttpClient`), which delivers the
 * compaction signal live (pinned in opencodeV2History.test.ts and, through the context usage
 * registry, in productionOpenCodeBackend.test.ts). The parser stays only for the stored V1
 * history rows its functional harness and `opencodeSafeActivity` still validate.
 */
const KNOWN_UNWITNESSED_READER_EVENT_TYPES = [
  {
    type: "message.part.updated.1",
    profile: "legacy V1 sync history (no pinned profile)",
    reason: "compaction part of a V1 history row; the V2 message API carries compaction instead",
  },
  {
    type: "message.updated.1",
    profile: "legacy V1 sync history (no pinned profile)",
    reason: "message and compaction summary of a V1 history row; V2 reads session messages",
  },
  {
    type: "session.updated.1",
    profile: "legacy V1 sync history (no pinned profile)",
    reason: "session observation of a V1 history row; V2 reads the session through its API",
  },
] as const;

function read(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), "utf8");
}

/** Every versioned sync event type the history reader branches on. */
function readerEventTypes(): readonly string[] {
  const source = read("./opencodeProtocol.ts");
  const found = new Set<string>();
  for (const match of source.matchAll(/"((?:[a-z]+\.)+[a-z]+\.\d+)"/gu)) {
    const type = match[1];
    if (type !== undefined) found.add(type);
  }
  return [...found].sort();
}

function witnessedBaseNames(): ReadonlySet<string> {
  const witnessed = new Set<string>();
  for (const fixture of FIXTURES)
    for (const match of read(fixture).matchAll(/"((?:[a-z]+\.)+[a-z]+)"/gu)) {
      const name = match[1];
      if (name !== undefined) witnessed.add(name);
    }
  return witnessed;
}

describe("event types the OpenCode history reader depends on", () => {
  it("compares the current pinned version's protocol-surface capture, which must exist", () => {
    const current = `opencodeProtocolSurface.opencode-${OPENCODE_PINNED_VERSION}.fixture.json`;
    expect(existsSync(new URL(current, import.meta.url))).toBe(true);
    expect(FIXTURES).toContain(current);
  });

  it("finds the reader's event types", () => {
    expect(readerEventTypes()).toEqual(
      expect.arrayContaining(["session.created.1", "message.updated.1"]),
    );
  });

  it("names every reader event type the pinned protocol fixtures do not witness, and no other", () => {
    const witnessed = witnessedBaseNames();
    const unwitnessed = readerEventTypes().filter(
      (type) => !witnessed.has(type.replace(/\.\d+$/u, "")),
    );
    expect(unwitnessed).toEqual(KNOWN_UNWITNESSED_READER_EVENT_TYPES.map((entry) => entry.type));
    for (const entry of KNOWN_UNWITNESSED_READER_EVENT_TYPES) {
      expect(entry.profile.length, entry.type).toBeGreaterThan(10);
      expect(entry.reason.length, entry.type).toBeGreaterThan(10);
    }
  });
});
