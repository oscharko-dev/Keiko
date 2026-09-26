import { describe, expect, it } from "vitest";
import { DEFAULT_SANDBOX_POLICY } from "@oscharko-dev/keiko-contracts/runtime/tools";
import {
  createInitialToolCatalog,
  compileToolProjection,
  gatewayToolDefinitions,
} from "./index.js";

describe("initial version-bound legacy catalog", () => {
  it("declares only the six existing implemented legacy handlers", () => {
    const catalog = createInitialToolCatalog();
    const projection = compileToolProjection(catalog, { id: "legacy-native", version: 1 });
    expect(projection.tools.map((tool) => tool.alias).sort()).toEqual([
      "apply_patch",
      "inspect_package_scripts",
      "list_files",
      "propose_patch",
      "read_file",
      "run_command",
    ]);
    for (const descriptor of catalog.descriptors) {
      expect(descriptor.handlerRequirement).toEqual({ id: "legacy-tool-port", contractVersion: 1 });
      expect(descriptor.bounds.maxDurationMs).toBe(DEFAULT_SANDBOX_POLICY.defaultTimeoutMs);
      expect(descriptor.resultSchema).toEqual({ type: "string", maxLength: 65536 });
      expect(Object.isFrozen(descriptor.bounds)).toBe(true);
      expect(descriptor).not.toHaveProperty("ready");
      expect(descriptor).not.toHaveProperty("allowed");
      expect(descriptor.toolRef.canonicalId).not.toBe("keiko.repo.search");
    }
    expect(gatewayToolDefinitions(catalog, projection.profile)).toHaveLength(6);
  });
  it("produces detached, deterministic catalogs without singleton state", () => {
    const first = createInitialToolCatalog();
    const second = createInitialToolCatalog();
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(first.descriptors[0]).not.toBe(second.descriptors[0]);
    expect(Reflect.set(first.profiles, "0", null)).toBe(false);
    expect(createInitialToolCatalog()).toEqual(second);
  });
});
