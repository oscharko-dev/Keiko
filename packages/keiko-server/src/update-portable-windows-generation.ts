import { join } from "node:path";
import type { UpdatePortableTarget } from "@oscharko-dev/keiko-contracts";
import { isRecord } from "./update-preflight-registry.js";
import { recordAt } from "./update-portable-staging-shared.js";

const SHA256 = /^[a-f0-9]{64}$/u;
const BINDING_KEYS = [
  "schemaVersion",
  "resourceRoot",
  "treeHashSchema",
  "treeSha256",
  "launcherPath",
  "launcherSha256",
] as const;

export interface WindowsGenerationBinding {
  readonly schemaVersion: 1;
  readonly resourceRoot: string;
  readonly treeHashSchema: "KHT1";
  readonly treeSha256: string;
  readonly launcherPath: "Keiko.exe";
  readonly launcherSha256: string;
}

export interface WindowsGenerationLayout {
  readonly installRoot: string;
  readonly resourceRoot: string;
  readonly appRoot: string;
  readonly packageJsonPath: string;
  readonly runtimeNodePath: string;
  readonly runtimeSupervisorPath: string;
  readonly rootLauncherPath: string;
  readonly rootSetupManifestPath: string;
  readonly rootSupportLauncherPath: string;
}

function hasExactKeys(record: Record<string, unknown>): boolean {
  const actual = Object.keys(record).sort();
  const expected = [...BINDING_KEYS].sort();
  return actual.length === expected.length && expected.every((key, index) => actual[index] === key);
}

export function parseWindowsGenerationBinding(
  value: unknown,
): WindowsGenerationBinding | undefined {
  if (!isRecord(value) || !hasExactKeys(value)) return undefined;
  const treeSha256 = value.treeSha256;
  const launcherSha256 = value.launcherSha256;
  const valid = [
    value.schemaVersion === 1,
    value.treeHashSchema === "KHT1",
    typeof treeSha256 === "string" && SHA256.test(treeSha256),
    value.resourceRoot === `.portable/generations/${String(treeSha256)}`,
    value.launcherPath === "Keiko.exe",
    typeof launcherSha256 === "string" && SHA256.test(launcherSha256),
  ].every(Boolean);
  if (!valid || typeof treeSha256 !== "string" || typeof launcherSha256 !== "string") {
    return undefined;
  }
  return {
    schemaVersion: 1,
    resourceRoot: `.portable/generations/${treeSha256}`,
    treeHashSchema: "KHT1",
    treeSha256,
    launcherPath: "Keiko.exe",
    launcherSha256,
  };
}

export function windowsGenerationBindingsEqual(
  left: WindowsGenerationBinding,
  right: WindowsGenerationBinding,
): boolean {
  return BINDING_KEYS.every((key) => left[key] === right[key]);
}

export function verifiedWindowsGenerationManifestBinding(
  manifest: Record<string, unknown>,
  target: UpdatePortableTarget,
): WindowsGenerationBinding | undefined {
  if (target !== "windows-x64") return undefined;
  if (manifest.schemaVersion !== 2) return undefined;
  const outer = parseWindowsGenerationBinding(manifest.windowsGeneration);
  const provenance = parseWindowsGenerationBinding(
    recordAt(manifest, "provenance")?.windowsGeneration,
  );
  const reviewed = parseWindowsGenerationBinding(
    recordAt(recordAt(manifest, "releaseImpact"), "reviewedBinding")?.windowsGeneration,
  );
  if (
    outer === undefined ||
    provenance === undefined ||
    reviewed === undefined ||
    !windowsGenerationBindingsEqual(outer, provenance) ||
    !windowsGenerationBindingsEqual(outer, reviewed)
  ) {
    return undefined;
  }
  return outer;
}

export function portableManifestGenerationSchemaVerified(
  manifest: Record<string, unknown>,
  target: UpdatePortableTarget,
): boolean {
  if (target === "windows-x64") {
    return verifiedWindowsGenerationManifestBinding(manifest, target) !== undefined;
  }
  return (
    manifest.schemaVersion === 1 &&
    manifest.windowsGeneration === undefined &&
    recordAt(manifest, "provenance")?.windowsGeneration === undefined &&
    recordAt(recordAt(manifest, "releaseImpact"), "reviewedBinding")?.windowsGeneration ===
      undefined
  );
}

export function resolveWindowsGenerationLayout(
  installRoot: string,
  binding: WindowsGenerationBinding,
): WindowsGenerationLayout {
  const resourceRoot = join(installRoot, ...binding.resourceRoot.split("/"));
  return {
    installRoot,
    resourceRoot,
    appRoot: join(resourceRoot, "app"),
    packageJsonPath: join(resourceRoot, "app", "package.json"),
    runtimeNodePath: join(resourceRoot, "runtime", "node", "node.exe"),
    runtimeSupervisorPath: join(resourceRoot, "runtime", "native", "keiko-runtime-supervisor.exe"),
    rootLauncherPath: join(installRoot, binding.launcherPath),
    rootSetupManifestPath: join(installRoot, ".portable", "setup-manifest.json"),
    rootSupportLauncherPath: join(installRoot, "support", "keiko-support.cmd"),
  };
}
