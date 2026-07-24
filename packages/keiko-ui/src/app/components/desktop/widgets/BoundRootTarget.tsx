"use client";

import type { ReactNode } from "react";
import type { WorkspaceManifest } from "@oscharko-dev/keiko-contracts";
import { useWorkspaceManifest } from "../hooks/useWorkspaceManifest";
import { workspaceRootTargets } from "../workspaceRootTargets";
import styles from "./BoundRootTarget.module.css";

interface BoundRootTargetProps {
  readonly fallbackRoot: string | undefined;
  readonly configuredRoot: string | undefined;
  readonly lockedToActiveRoot: boolean;
  readonly label: string;
  readonly onSelect: (root: string) => void;
  readonly children: (root: string | undefined) => ReactNode;
}

export function resolveExplicitWindowRoot(
  manifest: WorkspaceManifest | null,
  configuredRoot: string | undefined,
  fallbackRoot: string | undefined,
  lockedToActiveRoot: boolean,
): string | undefined {
  if (lockedToActiveRoot || manifest === null || manifest.roots.length < 2) return fallbackRoot;
  const configured = manifest.roots.find((root) => root.canonicalRoot === configuredRoot);
  if (configured !== undefined) return configured.canonicalRoot;
  const focused = manifest.roots.find((root) => root.rootRef === manifest.focusedRootRef);
  return focused?.canonicalRoot ?? manifest.roots[0]?.canonicalRoot;
}

export function BoundRootTarget({
  fallbackRoot,
  configuredRoot,
  lockedToActiveRoot,
  label,
  onSelect,
  children,
}: BoundRootTargetProps): ReactNode {
  const workspace = useWorkspaceManifest(fallbackRoot ?? configuredRoot);
  const manifest = lockedToActiveRoot ? null : workspace.manifest;
  const selectedRoot = resolveExplicitWindowRoot(
    manifest,
    configuredRoot,
    fallbackRoot,
    lockedToActiveRoot,
  );
  if (manifest === null || manifest.roots.length < 2 || selectedRoot === undefined) {
    return children(selectedRoot);
  }
  const targets = workspaceRootTargets(selectedRoot, manifest);
  return (
    <section className={styles.cmpHost} data-bound-root-target={label}>
      <label className={styles.cmpPicker}>
        <span>{label} root</span>
        <select
          className={styles.cmpSelect}
          aria-label={`${label} root`}
          value={selectedRoot}
          onChange={(event) => onSelect(event.target.value)}
        >
          {targets.map((target) => (
            <option value={target.root} key={target.id}>
              {target.label}
            </option>
          ))}
        </select>
      </label>
      <div className={styles.cmpBody}>{children(selectedRoot)}</div>
    </section>
  );
}
