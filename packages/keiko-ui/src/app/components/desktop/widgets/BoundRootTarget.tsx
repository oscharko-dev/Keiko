"use client";

import type { ReactNode } from "react";
import type { EditorAgentActionDenyReason, WorkspaceManifest } from "@oscharko-dev/keiko-contracts";
import { useTranslate } from "@/lib/i18n";
import { useWorkspaceManifest } from "../hooks/useWorkspaceManifest";
import { workspaceRootTargets, type WorkspaceRootTarget } from "../workspaceRootTargets";
import styles from "./BoundRootTarget.module.css";

// Issue #2619 (ADR-0147 D1/D4) — the focused root is presentation state. It may drive read-only
// navigation, but it must never supply the missing root of a mutating or executing dispatch: a
// terminal opened without an explicit project path in a two-root workspace would otherwise run shell
// commands against whichever root happened to be focused, and re-focusing would silently retarget it.
//
// Each window that resolves one root through this component declares its class here. The exhaustive
// `Record` is the fail-closed part: a new bound-root surface cannot be added without answering the
// question, because omitting it does not compile.
export type BoundRootSurfaceType =
  | "problems"
  | "debug"
  | "terminal"
  | "commands"
  | "runtime"
  | "governedGit"
  | "governedPullRequest"
  | "governedMerge"
  | "containerStatus";

// "execution" covers every surface whose dispatch executes a process, mutates repository state, or
// has an external effect. "read-only" is the deliberate, enumerated exception ADR-0147 D1 permits.
export type BoundRootSurfaceClass = "execution" | "read-only";

export interface BoundRootSurfaceDefinition {
  readonly label: string;
  readonly surfaceClass: BoundRootSurfaceClass;
}

export const BOUND_ROOT_SURFACES: Readonly<
  Record<BoundRootSurfaceType, BoundRootSurfaceDefinition>
> = {
  // Reads a per-root in-memory diagnostics store and jumps to a file. No dispatch of its own, so
  // following focus stays legitimate presentation behaviour.
  problems: { label: "Problems", surfaceClass: "read-only" },
  // Starts a debuggee process via POST /api/editor/debug/sessions.
  debug: { label: "Debug", surfaceClass: "execution" },
  // Spawns host processes via POST /api/terminal/executions.
  terminal: { label: "Terminal", surfaceClass: "execution" },
  // Spawns package scripts via POST /api/commands/runs.
  commands: { label: "Commands", surfaceClass: "execution" },
  // Propagates its root into the executing windows below through openWindow, so an implicit root
  // here becomes an implicit root there.
  runtime: { label: "Runtime", surfaceClass: "execution" },
  // Stages, commits, switches branches, and pushes.
  governedGit: { label: "Git", surfaceClass: "execution" },
  // Opens and updates a pull request.
  governedPullRequest: { label: "Pull request", surfaceClass: "execution" },
  // Merges a pull request into its base.
  governedMerge: { label: "Merge", surfaceClass: "execution" },
  // Starts containers via POST /api/containers/runs.
  containerStatus: { label: "Containers", surfaceClass: "execution" },
};

// The reason is taken from the shared governance vocabulary rather than re-declared, so the browser
// refusal and the server denial name the same fact (`keiko-contracts` is the leaf both depend on).
// Deliberately module-local: it exists to bind this surface to the contract vocabulary, and callers
// consume it through `BoundRootDecision` rather than naming it directly.
type BoundRootDenyReason = Extract<EditorAgentActionDenyReason, "root-binding-required">;

export type BoundRootDecision =
  // `root` stays optional: the legacy single-root/unbound chain may legitimately have no root yet,
  // and its children already render an empty state for that.
  | { readonly status: "bound"; readonly root: string | undefined }
  | { readonly status: "denied"; readonly reason: BoundRootDenyReason };

interface BoundRootTargetProps {
  readonly fallbackRoot: string | undefined;
  readonly configuredRoot: string | undefined;
  readonly lockedToActiveRoot: boolean;
  readonly surface: BoundRootSurfaceType;
  readonly onSelect: (root: string) => void;
  readonly children: (root: string | undefined) => ReactNode;
}

/**
 * Resolve the one root this window acts on.
 *
 * An active task-workspace binding (V1, single-root) and a legacy or single-root workspace keep the
 * existing `activeRoot → cfg → linkedRoot` presentation chain untouched. Only a V2 multi-root
 * manifest changes: there the root must be an explicitly configured current member, otherwise an
 * execution surface is denied. ADR-0147 supersedes the `cfg`/`linkedRoot` fallback for every V2
 * mutating or executing dispatch, which is why `fallbackRoot` is not consulted in that branch.
 */
export function resolveExplicitWindowRoot(
  manifest: WorkspaceManifest | null,
  configuredRoot: string | undefined,
  fallbackRoot: string | undefined,
  lockedToActiveRoot: boolean,
  surfaceClass: BoundRootSurfaceClass,
): BoundRootDecision {
  if (lockedToActiveRoot || manifest === null || manifest.roots.length < 2) {
    return { status: "bound", root: fallbackRoot };
  }
  const configured = manifest.roots.find((root) => root.canonicalRoot === configuredRoot);
  if (configured !== undefined) return { status: "bound", root: configured.canonicalRoot };
  if (surfaceClass === "execution") return { status: "denied", reason: "root-binding-required" };
  const focused = manifest.roots.find((root) => root.rootRef === manifest.focusedRootRef);
  return { status: "bound", root: focused?.canonicalRoot ?? manifest.roots[0]?.canonicalRoot };
}

function boundRoot(decision: BoundRootDecision): string | undefined {
  return decision.status === "bound" ? decision.root : undefined;
}

// Content-free by construction: a closed reason and two catalog strings. No root path, display name,
// manifest reference, or digest reaches this render — the picker beside it is how the human turns the
// implicit intent into an explicit one.
function BoundRootDenied({ surface }: { readonly surface: BoundRootSurfaceType }): ReactNode {
  const t = useTranslate();
  return (
    <div
      className={styles.cmpDenied}
      role="note"
      data-testid={`bound-root-denied-${surface}`}
      data-deny-reason="root-binding-required"
    >
      <p className={styles.cmpDeniedTitle}>{t("boundRoot.denied.title")}</p>
      <p className={styles.cmpDeniedBody}>{t("boundRoot.denied.rootBindingRequired")}</p>
    </div>
  );
}

// The remedy that sits beside a denial: naming a root here turns the implicit intent into an
// explicit one. When denied nothing is preselected, so the control cannot imply a binding that the
// window does not have.
function BoundRootPicker({
  label,
  decision,
  targets,
  onSelect,
}: {
  readonly label: string;
  readonly decision: BoundRootDecision;
  readonly targets: readonly WorkspaceRootTarget[];
  readonly onSelect: (root: string) => void;
}): ReactNode {
  const t = useTranslate();
  return (
    <label className={styles.cmpPicker}>
      <span>{label} root</span>
      <select
        className={styles.cmpSelect}
        aria-label={`${label} root`}
        value={boundRoot(decision) ?? ""}
        onChange={(event) => onSelect(event.target.value)}
      >
        {decision.status === "denied" ? (
          <option value="" disabled>
            {t("boundRoot.denied.placeholder")}
          </option>
        ) : null}
        {targets.map((target) => (
          <option value={target.root} key={target.id}>
            {target.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function BoundRootTarget({
  fallbackRoot,
  configuredRoot,
  lockedToActiveRoot,
  surface,
  onSelect,
  children,
}: BoundRootTargetProps): ReactNode {
  const { label, surfaceClass } = BOUND_ROOT_SURFACES[surface];
  const workspace = useWorkspaceManifest(fallbackRoot ?? configuredRoot);
  const manifest = lockedToActiveRoot ? null : workspace.manifest;
  const decision = resolveExplicitWindowRoot(
    manifest,
    configuredRoot,
    fallbackRoot,
    lockedToActiveRoot,
    surfaceClass,
  );
  if (manifest === null || manifest.roots.length < 2) return children(boundRoot(decision));
  return (
    <section className={styles.cmpHost} data-bound-root-target={label}>
      <BoundRootPicker
        label={label}
        decision={decision}
        targets={workspaceRootTargets(boundRoot(decision), manifest)}
        onSelect={onSelect}
      />
      <div className={styles.cmpBody}>
        {decision.status === "denied" ? (
          <BoundRootDenied surface={surface} />
        ) : (
          children(decision.root)
        )}
      </div>
    </section>
  );
}
