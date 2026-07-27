import { fireEvent, render, screen } from "@testing-library/react";
import { axe } from "jest-axe";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceManifest } from "@oscharko-dev/keiko-contracts";
import {
  BOUND_ROOT_SURFACES,
  BoundRootTarget,
  resolveExplicitWindowRoot,
  workspaceManifestAvailability,
  type BoundRootSurfaceType,
  type WorkspaceManifestAvailability,
} from "./BoundRootTarget";
import { resolveBoundRoot } from "./index";
import { useWorkspaceManifest } from "../hooks/useWorkspaceManifest";

vi.mock("../hooks/useWorkspaceManifest", () => ({ useWorkspaceManifest: vi.fn() }));

const useWorkspaceManifestMock = vi.mocked(useWorkspaceManifest);

type RootDescriptor = WorkspaceManifest["roots"][number];

function loaded(manifest: WorkspaceManifest): WorkspaceManifestAvailability {
  return { status: "loaded", manifest };
}

// The hook's own shape, so a test can express "the fetch failed" and "the first load is in flight"
// as the distinct states they are rather than as one shared `null`.
function manifestView(
  overrides: Partial<ReturnType<typeof useWorkspaceManifest>>,
): ReturnType<typeof useWorkspaceManifest> {
  return {
    manifest: null,
    loading: false,
    mutating: false,
    issue: null,
    ...overrides,
  } as ReturnType<typeof useWorkspaceManifest>;
}

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
      resolveExplicitWindowRoot(loaded(manifest()), "/repo/b", "/task/root", true, "execution"),
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
        resolveExplicitWindowRoot(loaded(manifest()), undefined, "/repo/a", false, surfaceClass),
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
        resolveExplicitWindowRoot(loaded(manifest()), undefined, "/repo/a", false, surfaceClass),
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
                resolveExplicitWindowRoot(loaded(current), member, fallback, false, surfaceClass),
                `${context}/${member}`,
              ).toEqual({ status: "bound", root: member });
            }
          }
          // Given none — or a root that is not a current member — an execution surface is denied and
          // a read-only surface follows focus. Neither may invent a root outside the manifest.
          for (const configured of [undefined, "/not/a/member", ""]) {
            const decision = resolveExplicitWindowRoot(
              loaded(current),
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

  // #2619 removed the implicit-root fallback for execution surfaces, but only for a manifest that
  // was successfully read. "No manifest" and "manifest not readable right now" were the same value
  // (`null`), so a failed or in-flight load put every execution surface back on the fallback root
  // with no picker and no denial — the exact implicit binding that issue exists to forbid. One
  // unreadable or future-schema manifest anywhere in the store makes the whole list throw, so this
  // is reachable without touching the workspace being acted on.
  it("denies execution while the workspace membership is unknown, and still binds read-only", () => {
    expect(
      resolveExplicitWindowRoot(
        { status: "unavailable", reason: "failed" },
        undefined,
        "/repo/a",
        false,
        "execution",
      ),
    ).toEqual({ status: "denied", reason: "root-binding-required" });
    expect(
      resolveExplicitWindowRoot(
        { status: "unavailable", reason: "failed" },
        "/repo/a",
        "/repo/a",
        false,
        "execution",
      ),
    ).toEqual({ status: "denied", reason: "root-binding-required" });
    expect(
      resolveExplicitWindowRoot(
        { status: "unavailable", reason: "failed" },
        undefined,
        "/repo/a",
        false,
        "read-only",
      ),
    ).toEqual({ status: "bound", root: "/repo/a" });
  });

  it("separates an unreadable manifest from a workspace that has none", () => {
    const view = { manifest: null, loading: false, issue: null } as const;
    expect(workspaceManifestAvailability(view)).toEqual({ status: "absent" });
    expect(workspaceManifestAvailability({ ...view, loading: true })).toEqual({
      status: "unavailable",
      reason: "loading",
    });
    expect(workspaceManifestAvailability({ ...view, issue: "load" })).toEqual({
      status: "unavailable",
      reason: "failed",
    });
    const current = manifestOf(2);
    expect(workspaceManifestAvailability({ ...view, manifest: current })).toEqual(loaded(current));
  });

  it("renders the denial instead of the child when the manifest cannot be read", () => {
    useWorkspaceManifestMock.mockReturnValue(
      manifestView({ manifest: null, loading: false, issue: "load" }),
    );
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
    expect(screen.getByTestId("bound-root-denied-terminal")).toBeInTheDocument();
    expect(child).not.toHaveBeenCalled();
  });

  // The first read is in flight on every mount, so denying is right but announcing it is not. What
  // matters for the fail-open is that the child stays unmounted in BOTH unavailable states.
  it("mounts no execution child while the first manifest read is still in flight", () => {
    useWorkspaceManifestMock.mockReturnValue(
      manifestView({ manifest: null, loading: true, issue: null }),
    );
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
    expect(child).not.toHaveBeenCalled();
    expect(screen.queryByTestId("bound-root-denied-terminal")).toBeNull();
  });

  it("keeps the legacy single-root and unbound chains untouched", () => {
    for (const surfaceClass of ["execution", "read-only"] as const) {
      expect(
        resolveExplicitWindowRoot({ status: "absent" }, undefined, "/repo/a", false, surfaceClass),
      ).toEqual({
        status: "bound",
        root: "/repo/a",
      });
      expect(
        resolveExplicitWindowRoot(loaded(manifestOf(1)), undefined, "/repo/a", false, surfaceClass),
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
