// Wiring test for `buildUiHandlerDeps`'s composition of the rendered-diff registry (#3873, PR #3876
// review).
//
// The editor route lifts keiko-tools' collapsed-diff heuristic only for a diff whose exact text the
// coding runtime's edit port registered. The port WRITES the registry through the production
// resolver; the route READS it through `UiHandlerDeps.materializedPatches`. If `deps.ts` built one
// registry for each side, every registration would be invisible to the route and every edit beside
// a backslash-n would meet the engine's heuristic again, with the resolver's, the port's and the
// route's own tests all green: each is right about its own side.
//
// WHAT THIS PINS
//
// `createProductionCodingRuntimeResolver` is module-mocked to CAPTURE the registry the composition
// root hands it (real behaviour is preserved through `importOriginal` and delegation), and the
// assertion compares that instance with the one the same composition exposes to the route.
// Splitting `createRuntimeMutationPorts()` into two registries, or forgetting to spread it into the
// resolver input, fails it.

import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const captured = vi.hoisted(() => ({ registries: [] as unknown[] }));

vi.mock("./coding-runtime/productionCodingRuntimeResolver.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./coding-runtime/productionCodingRuntimeResolver.js")>();
  return {
    ...actual,
    createProductionCodingRuntimeResolver: (
      ...args: Parameters<typeof actual.createProductionCodingRuntimeResolver>
    ): ReturnType<typeof actual.createProductionCodingRuntimeResolver> => {
      captured.registries.push(args[0].materializedPatches);
      return actual.createProductionCodingRuntimeResolver(...args);
    },
  };
});

// Imported AFTER the mock declaration so `deps.ts` resolves the mocked resolver factory.
import { buildUiHandlerDeps } from "./deps.js";

const tmpDirs: string[] = [];

afterEach(() => {
  captured.registries.length = 0;
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  tmpDirs.push(dir);
  return dir;
}

describe("buildUiHandlerDeps rendered-diff registry wiring (#3873)", () => {
  it("hands the runtime's resolver and the editor route one and the same registry", () => {
    const deps = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir: tmp("ev-materialized-patches-wiring-"),
      env: {},
      uiDbPath: join(tmp("ui-materialized-patches-wiring-"), "keiko-ui.db"),
      codingRuntimeStartConfirmationConsumer: { consume: () => undefined },
      codingRuntimeProductionPorts: {
        backend: {
          createRun: (): never => {
            throw new Error("backend must not be reached");
          },
        },
        secureWorkspaceTextRead: {
          readText: () => Promise.resolve({ ok: false, reason: "denied" }),
        },
        editorAgentClient: {
          action: () => Promise.reject(new Error("editor must not be reached")),
        },
      },
    });

    expect(deps.codingRuntimeHostQualified).toBe(true);
    expect(deps.materializedPatches).toBeDefined();
    expect(captured.registries).toHaveLength(1);
    expect(captured.registries[0]).toBe(deps.materializedPatches);
    void deps.dispose?.();
  });
});
