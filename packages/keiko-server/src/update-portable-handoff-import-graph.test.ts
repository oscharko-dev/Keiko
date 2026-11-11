import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

// The portable handoff runs in a short-lived child process during an update. Its import graph must
// stay off the server composition root: `deps.js` loads every product subsystem, which made each
// handoff child spend about 2 s importing code it never runs (#4288).
const handoffModule = new URL("../dist/update-portable-handoff.js", import.meta.url).href;
const handoffPlanModule = new URL("../dist/update-portable-handoff-plan.js", import.meta.url).href;
const compositionRoot = new URL("../dist/deps.js", import.meta.url).href;

function resolvedModules(entry: string): readonly string[] {
  const script = [
    'import { registerHooks } from "node:module";',
    "const resolved = [];",
    "registerHooks({ resolve(specifier, context, next) {",
    "  const result = next(specifier, context);",
    "  resolved.push(result.url);",
    "  return result;",
    "} });",
    `await import(${JSON.stringify(entry)});`,
    "process.stdout.write(JSON.stringify(resolved));",
  ].join("\n");
  const child = spawnSync(
    process.execPath,
    ["--no-warnings", "--input-type=module", "-e", script],
    {
      encoding: "utf8",
      timeout: 60_000,
    },
  );
  expect(child.error).toBeUndefined();
  expect(child.stderr).toBe("");
  expect(child.status).toBe(0);
  return JSON.parse(child.stdout) as string[];
}

describe("portable handoff import graph", () => {
  it("never loads the server composition root", () => {
    const resolved = resolvedModules(handoffModule);
    expect(resolved).toContain(handoffPlanModule);
    expect(resolved).not.toContain(compositionRoot);
  });
});
