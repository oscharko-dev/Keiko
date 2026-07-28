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
    expect(screen.getByTestId("workspace-trust-banner-commands")).toHaveAttribute(
      "data-trust",
      "unavailable",
    );
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

  it("surfaces a refused revoke on a workspace that is still trusted", () => {
    // The banner returned null for every trusted state before the `issue === "update"` alert could
    // run, so a revoke the server refused was completely silent: the human asked to withdraw trust,
    // the request failed, and the UI showed an ordinary trusted workspace. The copy is
    // direction-aware because the shared string asserts the workspace "remains restricted", which
    // is the opposite of what happened here.
    render(
      <I18nProvider>
        <WorkspaceTrustBanner
          status={{ ...restrictedStatus("human-grant"), trust: "trusted" }}
          issue="update"
          failure={{ code: "WORKSPACE_TRUST_UPDATE_FAILED", correlationId: "revoke-2523" }}
          surface="editor"
          onManage={vi.fn()}
        />
      </I18nProvider>,
    );

    const banner = screen.getByTestId("workspace-trust-banner-editor");
    expect(banner).toHaveAttribute("data-trust", "trusted");
    expect(banner).toHaveTextContent("This workspace remains trusted.");
    expect(banner).not.toHaveTextContent("This workspace remains restricted.");
    expect(screen.getByRole("alert")).toBeVisible();
    expect(screen.queryByText("Restricted Mode")).toBeNull();
  });

  it("stays silent on a trusted workspace with no failed transition", () => {
    const { container } = render(
      <I18nProvider>
        <WorkspaceTrustBanner
          status={{ ...restrictedStatus("human-grant"), trust: "trusted" }}
          issue={undefined}
          surface="editor"
        />
      </I18nProvider>,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("distinguishes unavailable, restricted, and trusted badge states", () => {
    const view = render(
      <I18nProvider>
        <WorkspaceTrustBadge status={undefined} issue="load" />
      </I18nProvider>,
    );
    expect(screen.getByLabelText("Workspace Trust unavailable")).toHaveAttribute(
      "data-trust",
      "unavailable",
    );

    view.rerender(
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
    expect(screen.getByTestId("workspace-trust-banner-editor")).toHaveAttribute(
      "data-trust",
      "restricted",
    );
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
