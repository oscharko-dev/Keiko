import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { expect, it } from "vitest";
import { DEFAULT_LAB_CONNECTION } from "../testing/jira-chat-lab/lab-client.mjs";

const sessionScript = fileURLToPath(
  new URL("../testing/jira-chat-lab/session.mjs", import.meta.url),
);

function invokeSession(action, projects, inspectFailure = false) {
  const root = mkdtempSync(join(tmpdir(), "keiko-exclusive-lab-"));
  const directory = join(root, "session");
  const tools = join(root, "tools");
  const calls = join(root, "calls.jsonl");
  mkdirSync(join(directory, "secrets", "tls"), { recursive: true });
  mkdirSync(tools);
  writeFileSync(
    join(directory, "session.json"),
    JSON.stringify({
      ...DEFAULT_LAB_CONNECTION,
      schemaVersion: 1,
      syntheticOnly: true,
      project: "keiko-jira-4081-owned",
    }),
    { mode: 0o600 },
  );
  for (const name of ["ca.key", "ca.pem", "server.key", "server.pem"])
    writeFileSync(join(directory, "secrets", "tls", name), "synthetic TLS fixture", {
      mode: 0o600,
    });
  writeFileSync(
    join(tools, "docker"),
    `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.SYNTHETIC_CALLS, JSON.stringify(args) + "\\n");
if (args[0] === "ps") {
  if (process.env.SYNTHETIC_INSPECT_FAILURE === "yes") process.exit(1);
  process.stdout.write(process.env.SYNTHETIC_PROJECTS);
}
`,
    { mode: 0o700 },
  );
  try {
    const result = spawnSync(process.execPath, [sessionScript, action, directory], {
      encoding: "utf8",
      timeout: 10_000,
      env: {
        ...process.env,
        PATH: tools + delimiter + process.env.PATH,
        SYNTHETIC_CALLS: calls,
        SYNTHETIC_PROJECTS: projects.join("\n"),
        SYNTHETIC_INSPECT_FAILURE: inspectFailure ? "yes" : "no",
      },
    });
    return {
      ...result,
      calls: readFileSync(calls, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

it.each([["keiko-jira-4081-foreign"], ["keiko-jira-4081-owned", "keiko-jira-4081-foreign"]])(
  "refuses a second Jira lab before compose up: %j",
  (...projects) => {
    const result = invokeSession("start", projects);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Another Jira laboratory is running");
    expect(result.calls.some((args) => args[0] === "compose")).toBe(false);
  },
);

it.each([[], ["keiko-jira-4081-owned"]])(
  "allows an exclusive or already-owned lab: %j",
  (...projects) => {
    const result = invokeSession("start", projects);
    expect(result.status).toBe(0);
    expect(result.calls.at(-1)).toEqual(
      expect.arrayContaining(["compose", "keiko-jira-4081-owned", "up", "-d"]),
    );
  },
);

it("fails closed when Docker cannot establish exclusivity", () => {
  const result = invokeSession("start", [], true);
  expect(result.status).toBe(1);
  expect(result.calls.some((args) => args[0] === "compose")).toBe(false);
});

it("keeps stopping the owned lab available while a foreign lab runs", () => {
  const result = invokeSession("stop", ["keiko-jira-4081-foreign"]);
  expect(result.status).toBe(0);
  expect(result.calls).toHaveLength(1);
  expect(result.calls[0]).toEqual(
    expect.arrayContaining(["compose", "keiko-jira-4081-owned", "stop"]),
  );
});
