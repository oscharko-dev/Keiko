import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { describe, expect, it, vi } from "vitest";
import {
  WORKSPACE_TRUST_SCHEMA_VERSION,
  type WorkspaceTrustStatus,
} from "@oscharko-dev/keiko-contracts";
import { I18nProvider } from "@/lib/i18n";
import {
  WorkspaceTrustBadge,
  WorkspaceTrustBanner,
  WorkspaceTrustDecisionDialog,
} from "./WorkspaceTrustSurfaces";

function restrictedStatus(reason: WorkspaceTrustStatus["reason"]): WorkspaceTrustStatus {
  return {
    kind: "workspace-trust-status",
    schemaVersion: WORKSPACE_TRUST_SCHEMA_VERSION,
    projectId: "/registered/workspace",
    trust: "restricted",
    decidedBy: "server",
    reason,
    revision: 4,
  };
}

describe("Workspace Trust governance surfaces", () => {
  it("renders a failed trust read as unavailable instead of claiming Restricted Mode", () => {
    render(
      <I18nProvider>
        <WorkspaceTrustBanner
          status={undefined}
          issue="load"
          failure={{
            code: "WORKSPACE_STATE_UNAVAILABLE",
            correlationId: "trust-banner-request-2625",
          }}
          surface="commands"
          onManage={vi.fn()}
        />
      </I18nProvider>,
    );

    expect(screen.getByText("Workspace Trust unavailable")).toBeVisible();
    expect(screen.getByTestId("workspace-trust-banner-commands")).toHaveTextContent(
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
      "Support ID: trust-banner-request-2625",
    );
  });

  it("projects unavailable trust as restricted and renders a trusted badge explicitly", () => {
    const view = render(
      <I18nProvider>
        <WorkspaceTrustBadge status={undefined} />
      </I18nProvider>,
    );
    expect(screen.getByLabelText("Restricted Mode")).toHaveAttribute("data-trust", "restricted");

    view.rerender(
      <I18nProvider>
        <WorkspaceTrustBadge status={{ ...restrictedStatus("human-grant"), trust: "trusted" }} />
      </I18nProvider>,
    );
    expect(screen.getByLabelText("Trusted workspace")).toHaveAttribute("data-trust", "trusted");
  });

  it("renders the honest digest-invalidation reason and an accessible management path", async () => {
    const onManage = vi.fn();
    const user = userEvent.setup();
    const { container } = render(
      <I18nProvider>
        <WorkspaceTrustBanner
          status={restrictedStatus("manifest-changed")}
          issue={undefined}
          surface="editor"
          onManage={onManage}
          editor
        />
      </I18nProvider>,
    );

    expect(screen.getByText("Trust expired because the workspace manifest changed.")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Manage Workspace Trust" }));
    expect(onManage).toHaveBeenCalledOnce();
    expect(await axe(container)).toHaveNoViolations();
  });

  it("keeps Enter on the safe choice and traps keyboard focus in the prompt", async () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn(async () => true);
    const user = userEvent.setup();
    const { container } = render(
      <I18nProvider>
        <WorkspaceTrustDecisionDialog
          action="grant"
          initialPrompt
          mutating={false}
          onCancel={onCancel}
          onConfirm={onConfirm}
        />
      </I18nProvider>,
    );

    const stayRestricted = screen.getByRole("button", { name: "Stay restricted" });
    await waitFor(() => expect(stayRestricted).toHaveFocus());
    await user.keyboard("{Enter}");
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onConfirm).not.toHaveBeenCalled();

    await user.tab();
    expect(screen.getByRole("button", { name: "Trust workspace" })).toHaveFocus();
    await user.tab();
    expect(stayRestricted).toHaveFocus();
    expect(await axe(container)).toHaveNoViolations();
  });
});
