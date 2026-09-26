import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const BUILT_SUPPORT_MODULE = fileURLToPath(
  new URL("../../keiko-cli/dist/support.js", import.meta.url),
);
const SERVER_MARKER = "KEIKO_SERVER_MODULE_RESOLVED_3558";
const roots: string[] = [];

const LOADER = `
export async function resolve(specifier, context, nextResolve) {
  const resolved = await nextResolve(specifier, context);
  if (resolved.url.includes("/keiko-server/")) process.stderr.write("KEIKO_SERVER_MODULE_RESOLVED_3558\\n");
  return resolved;
}
`;

const DRIVER = `
const { runSupportCli } = await import(process.argv[1]);
const io = { out: (text) => process.stdout.write(text), err: (text) => process.stderr.write(text) };
for (const selector of [
  ["--correlation-id", "compatibility-3558-query"],
  ["--incident", "f".repeat(32)],
]) {
  const code = await runSupportCli(["query", "--state-dir", process.argv[2], ...selector, "--json"], io, {});
  if (code !== 0) process.exitCode = code;
}
`;

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Activity-Log-only CLI query runtime imports (#3558)", () => {
  it("does not resolve keiko-server while executing built correlation and incident query paths", () => {
    if (!existsSync(BUILT_SUPPORT_MODULE)) {
      throw new Error("Built keiko-cli is missing; run npm run build:packages before this test");
    }
    const root = mkdtempSync(join(tmpdir(), "keiko-activity-import-3558-"));
    roots.push(root);
    const loader = join(root, "activity-log-import-3558-loader.mjs");
    writeFileSync(loader, LOADER, { mode: 0o600 });

    const run = spawnSync(
      process.execPath,
      [
        "--no-warnings",
        "--experimental-loader",
        pathToFileURL(loader).href,
        "--input-type=module",
        "--eval",
        DRIVER,
        pathToFileURL(BUILT_SUPPORT_MODULE).href,
        root,
      ],
      { encoding: "utf8", timeout: 30_000 },
    );

    expect(run.error, run.stderr).toBeUndefined();
    expect(run.status, run.stderr).toBe(0);
    expect(run.stderr).not.toContain(SERVER_MARKER);
  });
});
