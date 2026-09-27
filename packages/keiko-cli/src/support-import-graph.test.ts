// Activity Log-only support commands never load keiko-server (#3558, ADR-0179).
//
// The proof runs the built CLI exactly as the root `keiko` bin does: it imports the keiko-cli barrel
// (every command module the bin's static graph evaluates), installs the process guards and awaits
// `runCli`. Importing a single command module instead would miss a static edge anywhere else in the
// CLI graph, which is how a keiko-server module can reach every command, the support commands
// included. The resolve hook runs synchronously on the main thread (`module.registerHooks`), so no
// resolution can be lost the way output from an off-thread loader can be at process exit.

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const BUILT_CLI_BARREL = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const REPORT_PREFIX = "KEIKO_IMPORT_GRAPH_REPORT ";
const roots: string[] = [];

const DRIVER = `
import { registerHooks } from "node:module";
const resolved = [];
registerHooks({
  resolve(specifier, context, nextResolve) {
    const result = nextResolve(specifier, context);
    resolved.push(result.url);
    return result;
  },
});
const cli = await import(process.argv[1]);
cli.installProcessGuards();
const stateDir = process.argv[2];
const io = { out: () => undefined, err: (text) => process.stderr.write(text) };
const env = { ...process.env, KEIKO_STATE_DIR: stateDir };
const commands = [
  ["support", "query", "--state-dir", stateDir, "--correlation-id", "import-graph-3558-query", "--json"],
  ["support", "query", "--state-dir", stateDir, "--incident", "f".repeat(32), "--json"],
  ["support", "incident", "list", "--state-dir", stateDir, "--json"],
  ["support", "manifest", "rebuild", "--state-dir", stateDir, "--json"],
  ["support", "manifest", "verify", "--state-dir", stateDir, "--json"],
];
const exitCodes = [];
for (const args of commands) exitCodes.push(await cli.runCli(args, io, env));
const packagePath = (url) => url.split("/packages/").at(-1);
process.stderr.write("${REPORT_PREFIX}" + JSON.stringify({
  exitCodes,
  server: resolved.filter((url) => url.includes("/keiko-server/")).map(packagePath),
  activityLog: resolved.filter((url) => url.includes("/keiko-activity-log/")).length,
}) + "\\n");
`;

interface ImportGraphReport {
  readonly exitCodes: readonly number[];
  readonly server: readonly string[];
  readonly activityLog: number;
}

function importGraphReport(stderr: string): ImportGraphReport {
  const line = stderr.split("\n").find((candidate) => candidate.startsWith(REPORT_PREFIX));
  if (line === undefined) throw new Error(`import-graph driver produced no report:\n${stderr}`);
  return JSON.parse(line.slice(REPORT_PREFIX.length)) as ImportGraphReport;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Activity Log-only support commands", () => {
  it("never resolve a keiko-server module through the CLI entry graph", () => {
    if (!existsSync(BUILT_CLI_BARREL)) {
      throw new Error("Built keiko-cli is missing; run npm run build:packages before this test");
    }
    const root = mkdtempSync(join(tmpdir(), "keiko-import-graph-"));
    roots.push(root);

    const run = spawnSync(
      process.execPath,
      [
        "--no-warnings",
        "--input-type=module",
        "--eval",
        DRIVER,
        pathToFileURL(BUILT_CLI_BARREL).href,
        root,
      ],
      { encoding: "utf8", timeout: 30_000 },
    );

    expect(run.error, run.stderr).toBeUndefined();
    expect(run.status, run.stderr).toBe(0);
    const report = importGraphReport(run.stderr);
    expect(report.exitCodes).toEqual([0, 0, 0, 0, 0]);
    // Positive control: the hook saw the commands load the Activity Log package, so an empty
    // server list is evidence rather than a hook that never ran.
    expect(report.activityLog).toBeGreaterThan(0);
    expect(report.server).toEqual([]);
  });
});
