import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { SecurityLogEvent } from "@oscharko-dev/keiko-security";

// The candidate that is validated before it replaces the configuration holds the team's key in
// plain text. If the gateway's loader cannot be loaded at all, the adoption must end as a failed
// save with one line, keep the current configuration and leave no candidate behind.
vi.mock("./lazy-modules.js", () => ({
  loadModelGateway: (): Promise<never> => Promise.reject(new Error("module graph unavailable")),
}));

const { adoptProvisionedConfig } = await import("./provisioned-config.js");

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("leaves no plaintext candidate behind when the gateway loader cannot be loaded", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiko-provisioned-loader-"));
  roots.push(root);
  const source = join(root, "keiko.config.json");
  writeFileSync(
    source,
    '{"providers":[{"modelId":"chat","baseUrl":"https://g.example.test","apiKey":"sk-plain"}]}',
  );
  const stateDir = join(root, "state");
  mkdirSync(join(stateDir, "ui"), { recursive: true });
  writeFileSync(join(stateDir, "ui", "keiko.config.json"), "current");
  const events: SecurityLogEvent[] = [];

  const result = await adoptProvisionedConfig({
    sourcePath: source,
    stateDir,
    env: {},
    running: false,
    securityLogSink: { write: (event): void => void events.push(event) },
  });

  expect(result.outcome).toBe("write-failed");
  expect(
    events
      .filter((event) => event.op === "cli.lifecycle.provisioned-config")
      .map((event) => event.extra?.outcome),
  ).toEqual(["write-failed"]);
  expect(readdirSync(join(stateDir, "ui"))).toEqual(["keiko.config.json"]);
  expect(readFileSync(join(stateDir, "ui", "keiko.config.json"), "utf8")).toBe("current");
});
