import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const DIST_ROOT = resolve(import.meta.dirname, "../../dist/gitDelivery");
const ROUTE_MODULES = [
  "actionSheetRoutes.js",
  "agentOperationsRoutes.js",
  "commitRoutes.js",
  "evidenceRoutes.js",
  "journeyRoutes.js",
  "localMutationRoutes.js",
  "mergeRoutes.js",
  "prDescriptionRoutes.js",
  "prMarkReadyExecution.js",
  "prRoutes.js",
  "pushRoutes.js",
  "syncRoutes.js",
] as const;

describe("Git delivery route cold imports", () => {
  it.each(ROUTE_MODULES)("loads %s in a fresh ESM process", (moduleName) => {
    const modulePath = resolve(DIST_ROOT, moduleName);
    const result = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", `await import(${JSON.stringify(modulePath)})`],
      { encoding: "utf8", timeout: 10_000 },
    );
    expect(result.status, result.stderr).toBe(0);
  });
});
