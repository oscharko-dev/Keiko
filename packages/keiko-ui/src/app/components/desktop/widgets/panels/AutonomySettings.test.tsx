import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AutonomySettings } from "./AutonomySettings";

const autonomyPolicyMock = vi.hoisted(() => vi.fn());
const githubGrantMock = vi.hoisted(() => vi.fn());
const projectMock = vi.hoisted(() => ({ path: null as string | null }));

vi.mock("../../hooks/useAutonomyModePolicy", () => ({
  useAutonomyModePolicy: autonomyPolicyMock,
}));

vi.mock("../../hooks/useGitHubIssueReaderAuthorization", () => ({
  useGitHubIssueReaderAuthorization: githubGrantMock,
}));

vi.mock("../../context/ChatSessionContext", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../context/ChatSessionContext")>();
  return {
    ...actual,
    useOptionalChatSessionProject: (): { readonly path: string; readonly name: string } | null =>
      projectMock.path === null ? null : { path: projectMock.path, name: "keiko" },
  };
});

describe("AutonomySettings", () => {
  const change = vi.fn();

  // The effective-mode chip carries data-mode too and precedes the options, so a bare attribute
  // query can answer for the chip instead of the option under test. Resolve through the radio.
  function option(label: string): HTMLElement {
    const control = screen.getByRole("radio", { name: label }).closest("label");
    if (control === null) throw new Error(`no option wrapper for ${label}`);
    return control;
  }

  const changeGrant = vi.fn();
  const reloadGrant = vi.fn();

  function grantView(
    overrides: Partial<{
      repositoryId: string | null;
      authorized: boolean;
      revision: number;
      pending: boolean;
      error: "hydrate" | "persist" | "conflict" | "unknown-repository" | null;
    }> = {},
  ): unknown {
    return {
      repositoryId: "f".repeat(64),
      authorized: false,
      revision: 1,
      pending: false,
      error: null,
      change: changeGrant,
      reload: reloadGrant,
      ...overrides,
    };
  }

  beforeEach(() => {
    change.mockReset();
    changeGrant.mockReset();
    reloadGrant.mockReset();
    projectMock.path = "/repos/keiko";
    githubGrantMock.mockReset();
    githubGrantMock.mockReturnValue(grantView());
    autonomyPolicyMock.mockReturnValue({
      requestedMode: "supervised-coding",
      effectiveMode: "supervised-coding",
      deploymentCeiling: "autonomous-delivery",
      pending: false,
      error: null,
      change,
    });
  });

  // Hermetic even when an assertion inside a test throws before its own cleanup line runs: only
  // one test in this file stubs `globalThis.fetch` (the real-hook PUT test below), but a stub left
  // in place by a mid-test throw would otherwise leak into every test that runs after it.
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("owns all three product modes and persists a full-access selection", async (): Promise<void> => {
    const user = userEvent.setup();
    render(<AutonomySettings />);

    expect(screen.getByRole("radio", { name: "Supervised workspace" })).toBeChecked();
    await user.click(screen.getByRole("radio", { name: "Full access" }));

    expect(change).toHaveBeenCalledWith("autonomous-delivery");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("shows the server-effective clamp without changing the requested selection", () => {
    autonomyPolicyMock.mockReturnValue({
      requestedMode: "autonomous-delivery",
      effectiveMode: "supervised-coding",
      deploymentCeiling: "supervised-coding",
      pending: false,
      error: null,
      change,
    });
    render(<AutonomySettings />);

    expect(screen.getByRole("radio", { name: "Full access" })).toBeChecked();
    expect(screen.getByRole("status")).toHaveTextContent(
      "This deployment currently limits the effective mode to Supervised workspace.",
    );
  });

  it("marks every mode above the deployment ceiling as capped before the choice is made", (): void => {
    autonomyPolicyMock.mockReturnValue({
      requestedMode: "governed-assist",
      effectiveMode: "governed-assist",
      deploymentCeiling: "governed-assist",
      pending: false,
      error: null,
      change,
    });

    render(<AutonomySettings />);

    expect(document.querySelectorAll('[data-capped="true"]')).toHaveLength(2);
    for (const label of ["Supervised workspace", "Full access"]) {
      expect(option(label)).toHaveAttribute("data-capped", "true");
    }
    expect(option("Ask for approval")).not.toHaveAttribute("data-capped", "true");
    expect(screen.getAllByText("Capped by this deployment")).toHaveLength(2);
  });

  it("caps nothing while the server reports no deployment ceiling", (): void => {
    autonomyPolicyMock.mockReturnValue({
      requestedMode: "supervised-coding",
      effectiveMode: "supervised-coding",
      deploymentCeiling: null,
      pending: false,
      error: null,
      change,
    });

    render(<AutonomySettings />);

    expect(document.querySelectorAll('[data-capped="true"]')).toHaveLength(0);
    expect(screen.queryByText("Capped by this deployment")).not.toBeInTheDocument();
  });

  it("omits effective status while the server policy has no effective mode", (): void => {
    autonomyPolicyMock.mockReturnValue({
      requestedMode: "supervised-coding",
      effectiveMode: null,
      deploymentCeiling: null,
      pending: false,
      error: null,
      change,
    });

    render(<AutonomySettings />);

    expect(screen.queryByText(/^Effective:/u)).not.toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Supervised workspace" })).toBeEnabled();
  });

  it.each([
    ["hydrate", "The current autonomy policy could not be loaded. Keiko remains fail-closed."],
    [
      "persist",
      "The autonomy mode could not be saved. The previous server-confirmed mode remains active.",
    ],
  ] as const)("renders the server policy %s failure", (error, message): void => {
    autonomyPolicyMock.mockReturnValue({
      requestedMode: "supervised-coding",
      effectiveMode: "supervised-coding",
      deploymentCeiling: "autonomous-delivery",
      pending: false,
      error,
      change,
    });

    render(<AutonomySettings />);

    expect(screen.getByRole("alert")).toHaveTextContent(message);
  });

  it("locks all mode controls while a policy request is pending", (): void => {
    autonomyPolicyMock.mockReturnValue({
      requestedMode: "supervised-coding",
      effectiveMode: "supervised-coding",
      deploymentCeiling: "autonomous-delivery",
      pending: true,
      error: null,
      change,
    });

    render(<AutonomySettings />);

    for (const control of screen.getAllByRole("radio")) expect(control).toBeDisabled();
  });

  // #3385 — the per-checkout GitHub issue reader grant lives on the same security surface as the
  // autonomy mode: a server-persisted, revisioned toggle keyed on the selected repository.
  describe("GitHub issue access grant (#3385)", () => {
    function grantSection(): HTMLElement {
      return screen.getByRole("group", { name: "GitHub issue access" });
    }

    it("keys the grant on the selected project path and shows only the content-free repository id", () => {
      render(<AutonomySettings />);

      expect(githubGrantMock).toHaveBeenCalledWith("/repos/keiko");
      const section = grantSection();
      expect(section).toHaveTextContent("f".repeat(64));
      expect(section).not.toHaveTextContent("/repos/keiko");
      expect(
        screen.getByRole("checkbox", { name: /Allow reading GitHub issues/u }),
      ).not.toBeChecked();
      expect(section).toHaveTextContent("Disabled");
    });

    it("persists a grant through the hook and reflects the server-confirmed state", async () => {
      const user = userEvent.setup();
      render(<AutonomySettings />);

      await user.click(screen.getByRole("checkbox", { name: /Allow reading GitHub issues/u }));
      expect(changeGrant).toHaveBeenCalledWith(true);

      githubGrantMock.mockReturnValue(grantView({ authorized: true, revision: 2 }));
      render(<AutonomySettings />);
      const [, second] = screen.getAllByRole("checkbox", { name: /Allow reading GitHub issues/u });
      expect(second).toBeChecked();
    });

    it("is keyboard operable: Space toggles the grant", async () => {
      const user = userEvent.setup();
      render(<AutonomySettings />);

      const toggle = screen.getByRole("checkbox", { name: /Allow reading GitHub issues/u });
      toggle.focus();
      await user.keyboard(" ");
      expect(changeGrant).toHaveBeenCalledWith(true);
    });

    it("states that no repository is selected and disables the toggle", () => {
      projectMock.path = null;
      githubGrantMock.mockReturnValue(grantView({ repositoryId: null, revision: 0 }));
      render(<AutonomySettings />);

      expect(githubGrantMock).toHaveBeenCalledWith(null);
      expect(grantSection()).toHaveTextContent(
        "Open a repository as a project to manage its GitHub issue access.",
      );
      expect(screen.getByRole("checkbox", { name: /Allow reading GitHub issues/u })).toBeDisabled();
    });

    it("locks the toggle and announces loading while a grant request is pending", () => {
      githubGrantMock.mockReturnValue(grantView({ pending: true }));
      render(<AutonomySettings />);

      expect(screen.getByRole("checkbox", { name: /Allow reading GitHub issues/u })).toBeDisabled();
      expect(grantSection().querySelector('[aria-live="polite"]')).toHaveTextContent(
        "Loading GitHub issue access…",
      );
    });

    it.each([
      [
        "hydrate",
        "GitHub issue access could not be loaded. Reading stays disabled until it is confirmed.",
      ],
      [
        "persist",
        "GitHub issue access could not be saved. The previous server-confirmed setting remains active.",
      ],
      [
        "conflict",
        "GitHub issue access changed elsewhere. The current server state was reloaded; review it and try again.",
      ],
      [
        "unknown-repository",
        "This path is not an opened project. Open the repository as a project before changing its GitHub issue access.",
      ],
    ] as const)("renders the %s failure as an alert", (error, message) => {
      githubGrantMock.mockReturnValue(grantView({ error }));
      render(<AutonomySettings />);

      const alerts = screen.getAllByRole("alert");
      expect(alerts.some((alert) => alert.textContent?.includes(message) === true)).toBe(true);
    });

    // Every test above mocks the hook itself, so `changeGrant` proves only that the component calls
    // whatever `useGitHubIssueReaderAuthorization` returns — never that the hook's own PUT request
    // carries the fields the server contract requires. This test drives the REAL hook against a
    // mocked `fetch`, so a regression in the wire shape (a dropped field, a wrong method, a stale
    // revision) fails here even though every hook-mocked test above stays green.
    it("PUTs the real grant shape through fetch and reflects the server-confirmed response", async () => {
      const real = await vi.importActual<
        typeof import("../../hooks/useGitHubIssueReaderAuthorization")
      >("../../hooks/useGitHubIssueReaderAuthorization");
      githubGrantMock.mockImplementation(real.useGitHubIssueReaderAuthorization);

      const fetchMock = vi.fn((_input: unknown, init?: RequestInit): Promise<Response> => {
        if (init?.method === "PUT") {
          return Promise.resolve(
            new Response(
              JSON.stringify({ repositoryId: "f".repeat(64), authorized: true, revision: 2 }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            ),
          );
        }
        return Promise.resolve(
          new Response(
            JSON.stringify({ repositoryId: "f".repeat(64), authorized: false, revision: 1 }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        );
      });
      vi.stubGlobal("fetch", fetchMock);

      const user = userEvent.setup();
      render(<AutonomySettings />);

      const toggle = await screen.findByRole("checkbox", { name: /Allow reading GitHub issues/u });
      await waitFor(() => {
        expect(toggle).toBeEnabled();
      });
      expect(toggle).not.toBeChecked();

      await user.click(toggle);

      const putCall = fetchMock.mock.calls.find(
        (call) => (call[1] as RequestInit | undefined)?.method === "PUT",
      );
      expect(putCall).toBeDefined();
      expect(String(putCall?.[0])).toBe("/api/coding-workbench/github-authorization");
      expect(JSON.parse(String((putCall?.[1] as RequestInit).body))).toEqual({
        repositoryPath: "/repos/keiko",
        authorized: true,
        expectedRevision: 1,
      });

      expect(
        await screen.findByRole("checkbox", { name: /Allow reading GitHub issues/u }),
      ).toBeChecked();
    });

    it("has no serious or critical axe violations in the granted, pending, and failed states", async () => {
      for (const view of [
        grantView({ authorized: true }),
        grantView({ pending: true }),
        grantView({ error: "conflict" }),
        grantView({ repositoryId: null }),
      ]) {
        githubGrantMock.mockReturnValue(view);
        const { container, unmount } = render(<AutonomySettings />);
        const report = await axe(container);
        expect(
          report.violations.filter((violation) =>
            ["serious", "critical"].includes(violation.impact ?? ""),
          ),
        ).toEqual([]);
        unmount();
      }
    });
  });
});
