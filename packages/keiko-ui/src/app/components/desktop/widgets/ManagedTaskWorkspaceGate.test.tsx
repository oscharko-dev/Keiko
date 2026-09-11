// The managed task-workspace gate the editor, Files and Git hosts share (release-audit F-08, PR #3452
// review): the bound managed root is presentable only with paired read authority (ADR-0141).
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n";
import type { WorkspaceManifestView } from "../hooks/useWorkspaceManifest";
import type { WindowRenderContext } from "../windows/WindowsRegistry";
import { ManagedTaskWorkspaceGate, managedTaskWorkspaceAccess } from "./ManagedTaskWorkspaceGate";

const access = vi.hoisted(() => ({
  current: "available" as "available" | "checking" | "unpaired" | "unavailable",
}));
const refresh = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("../hooks/useWorkspaceManifest", () => ({
  useWorkspaceManifest: (): Pick<WorkspaceManifestView, "pathReadAuthority" | "refresh"> => ({
    pathReadAuthority: access.current,
    refresh,
  }),
}));

const ACTIVE_ROOT = "/managed/task";

function managed(): Pick<WindowRenderContext, "activeBinding"> {
  return {
    activeBinding: {
      schemaVersion: "1",
      workspaceId: "ws-managed",
      taskId: "task-managed",
      activeRoot: ACTIVE_ROOT,
      boundSurfaces: ["git-delivery"],
      gitDeliveryRoot: ACTIVE_ROOT,
      editorProjectRoot: ACTIVE_ROOT,
    },
  };
}

function gate(ctx: Pick<WindowRenderContext, "activeBinding">, root: string | undefined): void {
  render(
    <I18nProvider>
      <ManagedTaskWorkspaceGate ctx={ctx} root={root}>
        <div data-testid="window-content" />
      </ManagedTaskWorkspaceGate>
    </I18nProvider>,
  );
}

afterEach(() => {
  access.current = "available";
  refresh.mockClear();
});

describe("ManagedTaskWorkspaceGate", () => {
  it("renders the paired-session note, not the window, on an unpaired managed task workspace", () => {
    access.current = "unpaired";
    gate(managed(), ACTIVE_ROOT);

    expect(
      screen.getByRole("note", { name: "Task workspace unavailable in this browser" }),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("window-content")).toBeNull();
  });

  it("renders the window once the managed read authority is available", () => {
    gate(managed(), ACTIVE_ROOT);

    expect(screen.getByTestId("window-content")).toBeInTheDocument();
    expect(screen.queryByRole("note")).toBeNull();
  });

  it("keeps another root's window usable while only the managed authority is unpaired", () => {
    access.current = "unpaired";
    gate(managed(), "/repos/keiko");

    expect(screen.getByTestId("window-content")).toBeInTheDocument();
    expect(screen.queryByRole("note")).toBeNull();
  });

  it("offers no recheck while the managed authority is still being checked", () => {
    access.current = "checking";
    gate(managed(), ACTIVE_ROOT);

    expect(screen.getByRole("note")).toBeInTheDocument();
    expect(screen.queryByTestId("window-content")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("offers an explicit recheck of the managed access", async () => {
    access.current = "unavailable";
    gate(managed(), ACTIVE_ROOT);

    await userEvent.click(screen.getByRole("button", { name: "Check again" }));

    expect(refresh).toHaveBeenCalledOnce();
  });
});

describe("managedTaskWorkspaceAccess", () => {
  it("answers only for the bound managed root without paired read authority", () => {
    const unpaired = { pathReadAuthority: "unpaired" } as const;

    expect(managedTaskWorkspaceAccess(managed(), ACTIVE_ROOT, unpaired)).toBe("unpaired");
    expect(managedTaskWorkspaceAccess(managed(), "/repos/keiko", unpaired)).toBeNull();
    expect(managedTaskWorkspaceAccess({ activeBinding: null }, ACTIVE_ROOT, unpaired)).toBeNull();
    expect(
      managedTaskWorkspaceAccess(managed(), ACTIVE_ROOT, { pathReadAuthority: "available" }),
    ).toBeNull();
    // A window without a target root is not the bound managed root, so it is never gated.
    expect(managedTaskWorkspaceAccess(managed(), undefined, unpaired)).toBeNull();
  });
});
