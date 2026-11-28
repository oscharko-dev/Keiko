import { expect, it } from "vitest";
import { checkProperty, propertySettings } from "../../../../tests/support/property-testing.js";
import { prepareMcpSettingsImport } from "./mcpSettingsImport.js";

const name = "JSONC wrappers preserve server boundaries and duplicate names refuse the batch";
const runs = 100;

it(name, async () => {
  let mixed = 0;
  await checkProperty({
    name,
    runs,
    generate: (random) => ({
      length: random.integer(2, 12),
      offset: random.integer(0, 9_999),
      localFirst: random.chance(0.5),
    }),
    property: ({ length, offset, localFirst }) => {
      const entries = Array.from({ length }, (_, index) => {
        const local = (index % 2 === 0) === localFirst;
        return [
          `fixture-${String(offset + index)}`,
          local
            ? { type: "local", command: ["/opt/tool", "space inside"] }
            : { type: "remote", url: "https://example.test/mcp" },
        ] as const;
      });
      const snapshot = { revision: "a".repeat(64), servers: [] };
      const raw = JSON.stringify(Object.fromEntries(entries));
      const result = prepareMcpSettingsImport(
        `{ /* configuration */ "mcp": {"servers":${raw},}, }`,
        snapshot,
      );
      if (result.kind !== "ready") throw new Error(result.issue);
      expect(result.update.servers.map((server) => [server.name, server.transport.kind])).toEqual(
        entries.map(([entry, definition]) => [entry, definition.type]),
      );
      expect(result.update.servers.every((server) => !server.enabled)).toBe(true);
      const duplicate = `{"mcp":{${raw.slice(1, -1)},${JSON.stringify(entries[0]?.[0])}:{}}}`;
      expect(prepareMcpSettingsImport(duplicate, snapshot)).toMatchObject({
        kind: "invalid",
        issue: "duplicate-key",
      });
      mixed++;
    },
  });
  expect(mixed).toBe(propertySettings({ name, runs }).runs);
});
