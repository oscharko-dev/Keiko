import { describe, expect, it } from "vitest";
import { parseMcpServerRegistry } from "./mcp-servers.js";

const remote = { kind: "remote", url: "https://tools.example.test/mcp" };
describe("shared MCP settings compatibility", () => {
  it("admits automatic discovery without inventing a tool allowlist", () => {
    expect(
      parseMcpServerRegistry({
        schemaVersion: 1,
        servers: [
          {
            name: "notes-api",
            transport: remote,
            discovery: "automatic",
            tools: {},
          },
        ],
      }),
    ).toMatchObject({ ok: true, servers: [{ discovery: "automatic", tools: {} }] });
  });
  it("keeps an empty manual allowlist invalid", () => {
    expect(
      parseMcpServerRegistry({
        schemaVersion: 1,
        servers: [
          {
            name: "notes",
            transport: remote,
            tools: {},
          },
        ],
      }),
    ).toMatchObject({ ok: false });
  });
  it("supports ordinary server names and sealed local environment references", () => {
    expect(
      parseMcpServerRegistry({
        schemaVersion: 1,
        servers: [
          {
            name: "notes_api",
            transport: {
              kind: "local",
              command: ["/usr/bin/node", "/opt/fixture/main.mjs"],
              environment: {},
              secretEnvironment: { SERVICE_TOKEN: { secretEnv: "KEIKO_MCP_SECRET_FIXTURE" } },
            },
            tools: { lookup: "read" },
          },
        ],
      }),
    ).toMatchObject({ ok: true });
  });
  it("refuses ambiguous native tool actions across distinct servers", () => {
    expect(
      parseMcpServerRegistry({
        schemaVersion: 1,
        servers: [
          { name: "notes_api", transport: remote, tools: { lookup: "write" } },
          { name: "notes", transport: remote, tools: { api_lookup: "read" } },
        ],
      }),
    ).toMatchObject({ ok: false });
  });
});
