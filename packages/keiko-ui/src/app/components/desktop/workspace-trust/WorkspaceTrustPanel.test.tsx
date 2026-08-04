import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  WORKSPACE_TRUST_SCHEMA_VERSION,
  type WorkspaceTrustReason,
  type WorkspaceTrustStatus,
} from "@oscharko-dev/keiko-contracts";
import { I18nProvider } from "@/lib/i18n";
import { WorkspaceTrustPanel } from "./WorkspaceTrustPanel";

const fetchProjectsMock = vi.fn();

vi.mock("@/lib/api", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/api")>();
  return { ...original, fetchProjects: () => fetchProjectsMock() };
});

const ROOT = "/user-selected/workspace";

function status(
  trust: "trusted" | "restricted",
  reason: WorkspaceTrustReason,
): WorkspaceTrustStatus {
  return {
    kind: "workspace-trust-status",
    schemaVersion: WORKSPACE_TRUST_SCHEMA_VERSION,
    projectId: ROOT,
    trust,
    decidedBy: "server",
    reason,
    revision: trust === "trusted" ? 5 : 4,
  };
}

function response(body: unknown): Response {
  return { ok: true, json: async () => body } as Response;
}

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("WorkspaceTrustPanel", () => {
  it("renders a failed trust read as unavailable instead of a missing or restricted grant", async () => {
    fetchProjectsMock.mockResolvedValue({
      projects: [
        {
          path: ROOT,
          name: "Chosen workspace",
          favorite: false,
          createdAt: 1,
          lastOpenedAt: 1,
          available: true,
        },
      ],
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: {
              code: "WORKSPACE_STATE_UNAVAILABLE",
              message: "workspace trust unavailable",
              correlationId: "trust-panel-request-2625",
            },
          }),
          {
            status: 503,
            headers: {
              "Content-Type": "application/json",
              "X-Keiko-Correlation-Id": "trust-panel-request-2625",
            },
          },
        ),
      ),
    );

    render(
      <I18nProvider>
        <WorkspaceTrustPanel />
      </I18nProvider>,
    );

    expect(await screen.findByText("Workspace Trust unavailable")).toHaveAttribute(
      "data-trust",
      "unavailable",
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Workspace Trust could not be read safely.",
    );
    expect(screen.queryByText("Restricted Mode")).toBeNull();
    expect(
      screen.queryByText(
        "No current server-validated trust grant is available for this workspace.",
      ),
    ).toBeNull();
    expect(screen.getByTestId("workspace-trust-failure-details")).toHaveTextContent(
      "Error code: WORKSPACE_STATE_UNAVAILABLE",
    );
    expect(screen.getByTestId("workspace-trust-failure-details")).toHaveTextContent(
      "Support ID: trust-panel-request-2625",
    );
    expect(screen.getByRole("button", { name: "Retry" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Trust" })).toBeNull();
  });

  it("lists roots and keeps capabilities restricted until the server confirms grant and revoke", async () => {
    fetchProjectsMock.mockResolvedValue({
      projects: [
        {
          path: ROOT,
          name: "Chosen workspace",
          favorite: false,
          createdAt: 1,
          lastOpenedAt: 1,
          available: true,
        },
      ],
    });
    let serverStatus = status("restricted", "manifest-changed");
    let resolveGrant: ((value: Response) => void) | undefined;
    const grantResponse = new Promise<Response>((resolve) => {
      resolveGrant = resolve;
    });
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") return grantResponse;
      if (init?.method === "DELETE") {
        serverStatus = status("restricted", "human-revocation");
        return Promise.resolve(response(serverStatus));
      }
      return Promise.resolve(response(serverStatus));
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    const { container } = render(
      <I18nProvider>
        <WorkspaceTrustPanel />
      </I18nProvider>,
    );

    expect(await screen.findByText("Chosen workspace")).toBeVisible();
    expect(screen.getByText(ROOT)).toBeVisible();
    expect(
      await screen.findByText("Trust expired because the workspace manifest changed."),
    ).toBeVisible();
    expect(await axe(container)).toHaveNoViolations();

    await user.click(screen.getByRole("button", { name: "Trust" }));
    const confirmGrant = screen.getByRole("button", { name: "Trust workspace" });
    await waitFor(() => expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus());
    await user.click(confirmGrant);
    expect(screen.getByText("Restricted Mode")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Revoke" })).toBeNull();

    serverStatus = status("trusted", "human-grant");
    await act(async () => resolveGrant?.(response(serverStatus)));
    expect(await screen.findByText("Trusted workspace")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Revoke" }));
    await user.click(screen.getByRole("button", { name: "Revoke trust" }));
    await waitFor(() => expect(screen.getByText("Restricted Mode")).toBeVisible());
    expect(fetchMock.mock.calls.map(([, init]) => init?.method ?? "GET")).toContain("DELETE");
    expect(await axe(container)).toHaveNoViolations();
  });

  it("rejects a malformed successful response without optimistically unlocking", async () => {
    fetchProjectsMock.mockResolvedValue({
      projects: [
        {
          path: ROOT,
          name: "Chosen workspace",
          favorite: false,
          createdAt: 1,
          lastOpenedAt: 1,
          available: true,
        },
      ],
    });
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      Promise.resolve(
        response(
          init?.method === "POST" ? { trusted: true } : status("restricted", "state-unavailable"),
        ),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(
      <I18nProvider>
        <WorkspaceTrustPanel />
      </I18nProvider>,
    );

    await screen.findByText(/No current server-validated trust grant is available/u);
    await user.click(screen.getByRole("button", { name: "Trust" }));
    await user.click(screen.getByRole("button", { name: "Trust workspace" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The server did not confirm the trust change.",
    );
    expect(screen.getByText("Restricted Mode")).toBeVisible();
  });
});
