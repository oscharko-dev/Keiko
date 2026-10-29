import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import type {
  ExternalMcpConnection,
  ManagedMcpLogPort,
} from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { connectExternalMcp, mcpStdioEnvironment } from "./external-client.js";

it.skipIf(process.platform === "win32")(
  "starts an absolute MCP launcher with its sibling runtime without inheriting PATH",
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-mcp-sibling-")));
    const launcher = join(root, "mcp-launcher.mjs");
    const fixture = new URL("./__tests__/browser-server.fixture.ts", import.meta.url);
    const events: Parameters<ManagedMcpLogPort["write"]>[0][] = [];
    let connection: ExternalMcpConnection | undefined;
    try {
      symlinkSync(process.execPath, join(root, "keiko-mcp-sibling-node"));
      writeFileSync(
        launcher,
        `#!/usr/bin/env keiko-mcp-sibling-node\nimport ${JSON.stringify(fixture.href)};\n`,
        { mode: 0o700 },
      );
      connection = await connectExternalMcp({
        correlationId: "stdio-sibling-runtime",
        signal: new AbortController().signal,
        log: {
          write: (event) => {
            events.push(event);
          },
        },
        transport: {
          kind: "local",
          command: [launcher, join(root, "effects.jsonl")],
          cwd: root,
          environment: {},
        },
      });
      expect(connection.tools.map((tool) => tool.name)).toEqual(["read_probe", "write_probe"]);
      expect(events.length).toBeGreaterThan(0);
    } finally {
      await connection?.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
);

const windowsTransport = {
  kind: "local" as const,
  command: [String.raw`C:\tools\node.exe`] as const,
  cwd: String.raw`C:\private\mcp-state`,
  environment: {},
};
it("keeps Windows DLL lookup and private profiles available without ambient profile inheritance", () => {
  const env = mcpStdioEnvironment(windowsTransport, "win32", String.raw`C:\Windows`);
  expect(env).toMatchObject({
    SYSTEMROOT: String.raw`C:\Windows`,
    USERPROFILE: windowsTransport.cwd,
    TEMP: windowsTransport.cwd,
    TMP: windowsTransport.cwd,
  });
  expect(env.PATH).toBe(String.raw`C:\tools;C:\Windows\System32;C:\Windows`);
  expect(env).not.toHaveProperty("API_KEY");
});
it.each([undefined, "relative", String.raw`\\host\Windows`, String.raw`\\?\C:\Windows`])(
  "refuses an unqualified or remote Windows system directory: %s",
  (systemRoot) => {
    expect(() => mcpStdioEnvironment(windowsTransport, "win32", systemRoot)).toThrow();
  },
);

it("honors explicit Windows environment keys irrespective of case", () => {
  const env = mcpStdioEnvironment(
    { ...windowsTransport, environment: { Path: "synthetic-explicit-path" } },
    "win32",
    String.raw`C:\Windows`,
  );
  expect(env.PATH).toBe("synthetic-explicit-path");
  expect(env).not.toHaveProperty("Path");
});
it("refuses Windows environment keys that collide under native case folding", () => {
  expect(() =>
    mcpStdioEnvironment(
      { ...windowsTransport, environment: { Path: "first", PATH: "second" } },
      "win32",
      String.raw`C:\Windows`,
    ),
  ).toThrow();
});
