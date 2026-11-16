import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  OPENCODE_PERSISTENCE_SCHEMAS,
  OPENCODE_PERSISTENCE_TABLE_CLASSES,
} from "./opencodePersistenceContract.js";
import {
  OPENCODE_PINNED_VERSION,
  OPENCODE_RUNTIME_VERSION_PINS,
} from "./opencodeRuntimeVersions.js";

const sorted = (values: readonly string[]): readonly string[] =>
  [...values].sort((left, right) => left.localeCompare(right));

describe("the OpenCode persistence contract", () => {
  it.each(OPENCODE_RUNTIME_VERSION_PINS.map((pin) => pin.version))(
    "describes and classifies every table of %s",
    (version) => {
      const schema = OPENCODE_PERSISTENCE_SCHEMAS[version];
      const classes = OPENCODE_PERSISTENCE_TABLE_CLASSES[version];
      expect(schema).toBeDefined();
      expect(classes).toBeDefined();
      expect(sorted(Object.keys(classes ?? {}))).toEqual(sorted(Object.keys(schema ?? {})));
    },
  );

  it("matches the schema captured from the real pinned producer", () => {
    // Written by opencodeNativeSessionResume.real.test.ts with
    // KEIKO_WRITE_OPENCODE_PERSISTENCE_FIXTURE=1, so a stale contract fails without the binary.
    const captured = JSON.parse(
      readFileSync(
        new URL(
          `./opencodePersistenceSchema.opencode-${OPENCODE_PINNED_VERSION}.fixture.json`,
          import.meta.url,
        ),
        "utf8",
      ),
    ) as Readonly<Record<string, readonly string[]>>;
    const contract = Object.entries(
      OPENCODE_PERSISTENCE_SCHEMAS[OPENCODE_PINNED_VERSION] ?? {},
    ).map(([table, columns]) => [table, sorted(columns)]);
    const actual = Object.entries(captured).map(([table, columns]) => [table, sorted(columns)]);
    expect(Object.fromEntries(actual)).toEqual(Object.fromEntries(contract));
  });
});
