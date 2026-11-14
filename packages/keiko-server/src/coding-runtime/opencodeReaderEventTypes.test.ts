import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const FIXTURES = [
  "opencodeProtocolSurface.opencode-2.1.4.fixture.json",
  "opencodeProtocolSurface.opencode-2.2.5.fixture.json",
] as const;

/**
 * Event types a reader of the runtime's history depends on that no pinned protocol-surface fixture
 * names. Each is a reader whose input nobody has witnessed from the pinned runtime: a context-usage
 * reader of exactly this kind (`message.updated.1`) read nothing in every real run and nobody
 * noticed (#4359). The list may only shrink: witness a type in a fixture and remove it here, or
 * remove its reader. A new reader type that is neither witnessed nor listed fails this test.
 */
const KNOWN_UNWITNESSED_READER_EVENT_TYPES = [
  "message.part.updated.1",
  "message.updated.1",
  "session.updated.1",
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
    expect(unwitnessed).toEqual([...KNOWN_UNWITNESSED_READER_EVENT_TYPES]);
  });
});
