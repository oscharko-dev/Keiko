import { realpathSync } from "node:fs";
import { join } from "node:path";

import type { ManagedLspRuntimeConfiguration } from "@oscharko-dev/keiko-contracts";
import { isWithinWorkspace } from "@oscharko-dev/keiko-workspace";

const MAX_CONFIGURATION_NODES = 4_096;

export function providerConfigurationPathsContained(
  root: string,
  configuration: ManagedLspRuntimeConfiguration,
): boolean {
  try {
    const realRoot = realpathSync(root);
    const paths = workspacePaths(configuration);
    if (paths === undefined) return false;
    return paths.every((path) => {
      const realPath = realpathSync(join(realRoot, path));
      return isWithinWorkspace(realRoot, realPath);
    });
  } catch {
    return false;
  }
}

function workspacePaths(
  configuration: ManagedLspRuntimeConfiguration,
): readonly string[] | undefined {
  const paths: string[] = [];
  const pending: unknown[] = [configuration];
  const seen = new Set<object>();
  while (pending.length > 0 && seen.size <= MAX_CONFIGURATION_NODES) {
    const value = pending.pop();
    if (typeof value !== "object" || value === null || seen.has(value)) continue;
    seen.add(value);
    if (isWorkspacePath(value)) {
      paths.push(value.path);
      continue;
    }
    const children: readonly unknown[] = Array.isArray(value) ? value : Object.values(value);
    pending.push(...children);
  }
  return seen.size <= MAX_CONFIGURATION_NODES ? paths : undefined;
}

/** The members a workspace-relative path entry of a provider configuration carries. */
interface ConfigurationPathCandidate {
  readonly kind?: unknown;
  readonly path?: unknown;
}

function isWorkspacePath(
  value: ConfigurationPathCandidate,
): value is { readonly kind: string; readonly path: string } {
  return (
    "kind" in value &&
    "path" in value &&
    value.kind === "workspaceRelative" &&
    typeof value.path === "string"
  );
}
