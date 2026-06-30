import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { UpdateCompatibilityScan, UpdateStateStore } from "@oscharko-dev/keiko-contracts";
import { UPDATE_STATE_STORES } from "@oscharko-dev/keiko-contracts";

export type ArtifactCategory =
  | "lifecycle"
  | "launcher"
  | "ui-database"
  | "gateway-config"
  | "credential-vault"
  | "memory-vault"
  | "local-knowledge"
  | "evidence"
  | "quality-intelligence"
  | "update-recovery";

export interface ArtifactNode {
  readonly relPath: string;
  readonly absPath: string;
  readonly category: ArtifactCategory;
}

export interface RetainedNode {
  readonly relPath: string;
  readonly owned: boolean;
  readonly category?: ArtifactCategory | undefined;
}

export interface StateScan {
  readonly status: UpdateCompatibilityScan["stateDirStatus"];
  readonly files: readonly ArtifactNode[];
  readonly directories: readonly ArtifactNode[];
  readonly retained: readonly RetainedNode[];
}

export const UPDATE_DIR = "updates";

export const CATEGORY_STORE: Readonly<Record<ArtifactCategory, UpdateStateStore>> = {
  lifecycle: "server-runtime",
  launcher: "server-runtime",
  "ui-database": "ui-layout",
  "gateway-config": "durable-config",
  "credential-vault": "durable-config",
  "memory-vault": "memory-vault",
  "local-knowledge": "local-knowledge",
  evidence: "evidence",
  "quality-intelligence": "evidence",
  "update-recovery": "server-runtime",
};

const STORE_ALIASES: Readonly<Record<UpdateStateStore, readonly string[]>> = {
  "ui-layout": ["ui", "ui-layout", "ui-database", "workspace-layout", "browser-ui"],
  "server-runtime": ["server-runtime", "runtime", "lifecycle", "launcher", "updates"],
  "durable-config": ["durable-config", "gateway-config", "config", "credentials"],
  evidence: ["evidence", "audit", "quality-intelligence", "qi"],
  "memory-vault": ["memory", "memory-vault", "memoriaviva"],
  "local-knowledge": ["local-knowledge", "knowledge", "local knowledge"],
  "workspace-references": ["workspace", "workspace-references", "repository-context"],
  "package-install": ["package", "install", "package-install", "npm", "yarn"],
};

export function canonicalStore(value: string): UpdateStateStore | undefined {
  const normalized = value.trim().toLowerCase().replaceAll("_", "-");
  return UPDATE_STATE_STORES.find(
    (store) => store === normalized || STORE_ALIASES[store].includes(normalized),
  );
}

function rootFileCategory(relPath: string): ArtifactCategory | undefined {
  if (relPath === "ui.pid" || relPath === "ui.log") return "lifecycle";
  if (relPath === "launcher-state.json" || relPath.startsWith(".launcher-state-"))
    return "launcher";
  if (relPath === "keiko.config.json") return "gateway-config";
  if (relPath === "keiko-ui.db" || relPath.startsWith("keiko-ui.db-")) return "ui-database";
  return undefined;
}

function knownStateSubtreeCategory(relPath: string): ArtifactCategory | undefined {
  if (relPath === "credentials" || relPath.startsWith("credentials/")) return "credential-vault";
  if (relPath === "memory" || relPath.startsWith("memory/")) return "memory-vault";
  if (relPath === "local-knowledge" || relPath.startsWith("local-knowledge/")) {
    return "local-knowledge";
  }
  if (relPath === UPDATE_DIR || relPath.startsWith(`${UPDATE_DIR}/`)) return "update-recovery";
  return undefined;
}

function evidenceCategory(relPath: string): ArtifactCategory | undefined {
  if (relPath === "evidence") return "evidence";
  if (relPath.startsWith("evidence/qi/")) return "quality-intelligence";
  if (relPath.startsWith("evidence/figma/")) return "credential-vault";
  if (relPath.startsWith("evidence/")) return "evidence";
  return undefined;
}

function topCategory(relPath: string): ArtifactCategory | undefined {
  return (
    rootFileCategory(relPath) ?? knownStateSubtreeCategory(relPath) ?? evidenceCategory(relPath)
  );
}

function childPath(relDir: string, name: string): string {
  return relDir.length === 0 ? name : `${relDir}/${name}`;
}

function walkState(
  absDir: string,
  relDir: string,
  acc: { files: ArtifactNode[]; directories: ArtifactNode[]; retained: RetainedNode[] },
): void {
  for (const name of readdirSync(absDir)) {
    const absPath = join(absDir, name);
    const relPath = childPath(relDir, name);
    const stat = lstatSync(absPath);
    const category = topCategory(relPath);
    if (stat.isSymbolicLink()) {
      acc.retained.push({ relPath, owned: category !== undefined, category });
      continue;
    }
    if (stat.isDirectory()) {
      if (category === undefined) {
        acc.retained.push({ relPath, owned: false });
        continue;
      }
      acc.directories.push({ relPath, absPath, category });
      walkState(absPath, relPath, acc);
      continue;
    }
    if (stat.isFile() && category !== undefined && stat.nlink <= 1) {
      acc.files.push({ relPath, absPath, category });
      continue;
    }
    acc.retained.push({ relPath, owned: category !== undefined, category });
  }
}

export function scanStateDir(stateDir: string): StateScan {
  try {
    const root = lstatSync(stateDir);
    if (root.isSymbolicLink())
      return { status: "symlink", files: [], directories: [], retained: [] };
    if (!root.isDirectory()) {
      return { status: "not-directory", files: [], directories: [], retained: [] };
    }
    const acc = {
      files: [] as ArtifactNode[],
      directories: [] as ArtifactNode[],
      retained: [] as RetainedNode[],
    };
    walkState(stateDir, "", acc);
    return { status: "directory", ...acc };
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return { status: "absent", files: [], directories: [], retained: [] };
    }
    throw error;
  }
}
