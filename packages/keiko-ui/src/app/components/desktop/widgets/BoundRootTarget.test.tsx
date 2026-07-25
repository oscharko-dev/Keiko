import { fireEvent, render, screen } from "@testing-library/react";
import { axe } from "jest-axe";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceManifest } from "@oscharko-dev/keiko-contracts";
import {
  BOUND_ROOT_SURFACES,
  BoundRootTarget,
  resolveExplicitWindowRoot,
  type BoundRootSurfaceType,
} from "./BoundRootTarget";
import { resolveBoundRoot } from "./index";
import { useWorkspaceManifest } from "../hooks/useWorkspaceManifest";

vi.mock("../hooks/useWorkspaceManifest", () => ({ useWorkspaceManifest: vi.fn() }));

const useWorkspaceManifestMock = vi.mocked(useWorkspaceManifest);

type RootDescriptor = WorkspaceManifest["roots"][number];

function root(index: number): RootDescriptor {
  const suffix = String.fromCharCode(97 + index);
  return {
    rootRef: `root-${suffix}` as RootDescriptor["rootRef"],
    canonicalRoot: `/repo/${suffix}`,
    displayName: `Root ${suffix.toUpperCase()}`,
    identityDigest: suffix.repeat(64) as RootDescriptor["identityDigest"],
    sourceDigest: { outcome: "absent" },
  };
}

// `focusedIndex` is a parameter rather than a constant precisely because the property below has to
// re-run every case under every possible focus and prove the answer does not move.
function manifestOf(rootCount: number, focusedIndex = rootCount - 1): WorkspaceManifest {
  const roots = Array.from({ length: rootCount }, (_unused, index) => root(index));
  const focused = roots[focusedIndex];
  if (focused === undefined) throw new Error("focused index outside the manifest");
  return {
    kind: "workspace-manifest",
    schemaVersion: 1,
    workspaceId: "workspace-1" as WorkspaceManifest["workspaceId"],
    manifestRef: "manifest-1" as WorkspaceManifest["manifestRef"],
    revision: 1,
    manifestDigest: "a".repeat(64) as WorkspaceManifest["manifestDigest"],
    roots,
    focusedRootRef: focused.rootRef,
  };
}

function manifest(): WorkspaceManifest {
  return manifestOf(2);
}

const SURFACE_TYPES = Object.keys(BOUND_ROOT_SURFACES) as readonly BoundRootSurfaceType[];
const EXECUTION_SURFACES = SURFACE_TYPES.filter(
  (surface) => BOUND_ROOT_SURFACES[surface].surfaceClass === "execution",
);
const READ_ONLY_SURFACES = SURFACE_TYPES.filter(
  (surface) => BOUND_ROOT_SURFACES[surface].surfaceClass === "read-only",
);

beforeEach(() => {
  useWorkspaceManifestMock.mockReturnValue({ manifest: manifest() } as ReturnType<
    typeof useWorkspaceManifest
  >);
});

describe("BoundRootTarget", () => {
  it("keeps the task-workspace root locked even when cfg names a sibling root", () => {
    expect(
      resolveExplicitWindowRoot(manifest(), "/repo/b", "/task/root", true, "execution"),
    ).toEqual({ status: "bound", root: "/task/root" });
  });

  it("persists an explicit member selection and retargets its child", () => {
    const onSelect = vi.fn();
    render(
      <BoundRootTarget
        fallbackRoot="/repo/a"
        configuredRoot="/repo/a"
        lockedToActiveRoot={false}
        surface="terminal"
        onSelect={onSelect}
      >
        {(bound) => <div>{bound}</div>}
      </BoundRootTarget>,
    );

    fireEvent.change(screen.getByRole("combobox", { name: "Terminal root" }), {
      target: { value: "/repo/b" },
    });
    expect(onSelect).toHaveBeenCalledWith("/repo/b");
    expect(screen.getByText("/repo/a")).toBeInTheDocument();
  });
});

// Issue #2619 (ADR-0147 D1/D4) — the focused root is presentation state and must never supply the
// missing root of a mutating or executing dispatch. Before this suite, a terminal opened without an
// explicit project path in a two-root workspace silently resolved to the focused root and executed
// shell commands there, and re-focusing the other root retargeted the running window.
describe("root identity is explicit for execution surfaces (#2619)", () => {
  it("denies an execution surface that was given no root in a multi-root workspace", () => {
    expect(EXECUTION_SURFACES.length).toBeGreaterThan(0);
    for (const surface of EXECUTION_SURFACES) {
      // Read the class back out of the table per surface — passing a literal here would make every
      // iteration the same call and the loop decorative.
      const { surfaceClass } = BOUND_ROOT_SURFACES[surface];
      expect(
        resolveExplicitWindowRoot(manifest(), undefined, "/repo/a", false, surfaceClass),
        surface,
      ).toEqual({ status: "denied", reason: "root-binding-required" });
    }
  });

  // The Out-of-Scope clause of #2619: read-only surfaces may legitimately follow focus, and the
  // exception is enumerated here so it stays deliberate. `problems` reads a per-root in-memory
  // diagnostics store and jumps to a file; it dispatches nothing.
  it("names the read-only surfaces that may still follow the focused root", () => {
    expect(READ_ONLY_SURFACES).toEqual(["problems"]);
    for (const surface of READ_ONLY_SURFACES) {
      const { surfaceClass } = BOUND_ROOT_SURFACES[surface];
      expect(
        resolveExplicitWindowRoot(manifest(), undefined, "/repo/a", false, surfaceClass),
        surface,
      ).toEqual({ status: "bound", root: "/repo/b" });
    }
  });

  // Pins the classification itself by value. A regex over the union member would be satisfied by the
  // type system alone and could never fail while the file compiles; reclassifying `terminal` as
  // read-only must break a test, not pass one.
  it("pins the class of every bound-root surface by value", () => {
    expect(
      Object.fromEntries(
        SURFACE_TYPES.map((surface) => [surface, BOUND_ROOT_SURFACES[surface].surfaceClass]),
      ),
    ).toEqual({
      problems: "read-only",
      debug: "execution",
      terminal: "execution",
      commands: "execution",
      runtime: "execution",
      governedGit: "execution",
      governedPullRequest: "execution",
      governedMerge: "execution",
      containerStatus: "execution",
    });
  });

  // AC2 — the property, enumerated exhaustively rather than sampled: for a workspace of N roots, no
  // operation resolves a root other than the one it was given, and an operation given none is denied.
  it("resolves exactly the given root, or denies, for every root count, focus and surface", () => {
    for (let rootCount = 2; rootCount <= 8; rootCount += 1) {
      for (let focusedIndex = 0; focusedIndex < rootCount; focusedIndex += 1) {
        const current = manifestOf(rootCount, focusedIndex);
        const members = current.roots.map((entry) => entry.canonicalRoot);
        for (const surface of SURFACE_TYPES) {
          const { surfaceClass } = BOUND_ROOT_SURFACES[surface];
          const context = `${surface}/${String(rootCount)}/${String(focusedIndex)}`;
          // Given a root: it is the one that comes back, whatever is focused and whatever the
          // legacy fallback chain would have offered.
          for (const member of members) {
            for (const fallback of [undefined, "/repo/a", "/elsewhere"]) {
              expect(
                resolveExplicitWindowRoot(current, member, fallback, false, surfaceClass),
                `${context}/${member}`,
              ).toEqual({ status: "bound", root: member });
            }
          }
          // Given none — or a root that is not a current member — an execution surface is denied and
          // a read-only surface follows focus. Neither may invent a root outside the manifest.
          for (const configured of [undefined, "/not/a/member", ""]) {
            const decision = resolveExplicitWindowRoot(
              current,
              configured,
              "/repo/a",
              false,
              surfaceClass,
            );
            if (surfaceClass === "execution") {
              expect(decision, context).toEqual({
                status: "denied",
                reason: "root-binding-required",
              });
            } else {
              expect(decision.status, context).toBe("bound");
              const resolved = decision.status === "bound" ? decision.root : undefined;
              expect(members, context).toContain(resolved);
              expect(resolved, context).toBe(current.roots[focusedIndex]?.canonicalRoot);
            }
          }
        }
      }
    }
  });

  it("keeps the legacy single-root and unbound chains untouched", () => {
    for (const surfaceClass of ["execution", "read-only"] as const) {
      expect(resolveExplicitWindowRoot(null, undefined, "/repo/a", false, surfaceClass)).toEqual({
        status: "bound",
        root: "/repo/a",
      });
      expect(
        resolveExplicitWindowRoot(manifestOf(1), undefined, "/repo/a", false, surfaceClass),
      ).toEqual({ status: "bound", root: "/repo/a" });
    }
  });

  // AC4 — the user-facing half: the window refuses with a typed, content-free notice and offers the
  // picker that turns the implicit intent into an explicit one.
  it("renders a content-free typed denial instead of binding a terminal silently", () => {
    const child = vi.fn((bound: string | undefined) => <div>child:{bound}</div>);
    render(
      <BoundRootTarget
        fallbackRoot="/repo/a"
        configuredRoot={undefined}
        lockedToActiveRoot={false}
        surface="terminal"
        onSelect={vi.fn()}
      >
        {child}
      </BoundRootTarget>,
    );

    const denial = screen.getByTestId("bound-root-denied-terminal");
    expect(denial).toHaveAttribute("data-deny-reason", "root-binding-required");
    // The executing child never mounts, so nothing can dispatch against a root nobody chose.
    expect(child).not.toHaveBeenCalled();
    // Content-free: the refusal names no root path, no display name, and no manifest identity.
    expect(denial.textContent ?? "").not.toContain("/repo/");
    expect(denial.textContent ?? "").not.toContain("Root A");
    expect(denial.textContent ?? "").not.toContain("manifest-1");
    // The remedy is present and nothing is pre-selected.
    expect(screen.getByRole("combobox", { name: "Terminal root" })).toHaveValue("");
  });

  it("mounts the read-only surface against the focused root instead of denying", () => {
    const child = vi.fn((bound: string | undefined) => <div>child:{bound}</div>);
    render(
      <BoundRootTarget
        fallbackRoot="/repo/a"
        configuredRoot={undefined}
        lockedToActiveRoot={false}
        surface="problems"
        onSelect={vi.fn()}
      >
        {child}
      </BoundRootTarget>,
    );

    expect(screen.queryByTestId("bound-root-denied-problems")).toBeNull();
    expect(child).toHaveBeenCalledWith("/repo/b");
  });

  it("keeps the denied surface accessible", async () => {
    const { container } = render(
      <BoundRootTarget
        fallbackRoot="/repo/a"
        configuredRoot={undefined}
        lockedToActiveRoot={false}
        surface="terminal"
        onSelect={vi.fn()}
      >
        {(bound) => <div>child:{bound}</div>}
      </BoundRootTarget>,
    );
    expect(await axe(container)).toHaveNoViolations();
  });

  it("stops denying as soon as the human names a root", () => {
    const child = vi.fn((bound: string | undefined) => <div>child:{bound}</div>);
    const { rerender } = render(
      <BoundRootTarget
        fallbackRoot="/repo/a"
        configuredRoot={undefined}
        lockedToActiveRoot={false}
        surface="terminal"
        onSelect={vi.fn()}
      >
        {child}
      </BoundRootTarget>,
    );
    expect(screen.getByTestId("bound-root-denied-terminal")).toBeInTheDocument();

    rerender(
      <BoundRootTarget
        fallbackRoot="/repo/a"
        configuredRoot="/repo/a"
        lockedToActiveRoot={false}
        surface="terminal"
        onSelect={vi.fn()}
      >
        {child}
      </BoundRootTarget>,
    );
    expect(screen.queryByTestId("bound-root-denied-terminal")).toBeNull();
    expect(child).toHaveBeenCalledWith("/repo/a");
  });

  // The surfaces that resolve a root WITHOUT this component go through `resolveBoundRoot`, whose
  // chain is `activeRoot → cfg → linkedRoot` — no focus term, so no focused root can enter it.
  //
  // This is NOT the whole story for `editor`: `SelectionAwareWorkspaceHosts` additionally hands the
  // manifest to `MultiRootEditorHost`, which does consult `focusedRootRef`. That use is covered by
  // its own named exception test, which proves every root is mounted with its own explicit binding
  // so focus only selects the visible tab.
  it("keeps the non-manifest chain free of any focus term", () => {
    expect(resolveBoundRoot({ activeRoot: "/task/root", linkedRoot: "/linked" }, "/cfg")).toBe(
      "/task/root",
    );
    expect(resolveBoundRoot({ activeRoot: null, linkedRoot: "/linked" }, "/cfg")).toBe("/cfg");
    expect(resolveBoundRoot({ activeRoot: null, linkedRoot: "/linked" }, undefined)).toBe(
      "/linked",
    );
    expect(resolveBoundRoot({ activeRoot: null, linkedRoot: null }, undefined)).toBeUndefined();
  });
});
