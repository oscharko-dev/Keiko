import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { describe, expect, it, vi } from "vitest";
import {
  CODING_WORKBENCH_SCHEMA_VERSION,
  type CodingWorkbenchCodexSubscriptionProfile,
  type CodingWorkbenchSidecarGatewayResult,
} from "@oscharko-dev/keiko-contracts";
import { CodingWorkbenchWindow, type CodingWorkbenchWindowApi } from "./CodingWorkbenchWindow";
import { CODING_WORKBENCH_PROJECTIONS } from "./codingWorkbenchProjection";

function sidecarProfile(): CodingWorkbenchSidecarGatewayResult {
  return {
    status: "available",
    profileId: "gateway-redacted",
    modelAlias: "model-redacted",
    localEndpointPath: "/api/coding-sidecar/gateway/chat/completions",
    supportsStreaming: true,
    supportsToolCalling: true,
    runMetadata: {
      maxPromptTokens: 200_000,
      maxOutputTokens: 16_000,
      maxInputMessages: 64,
      maxRequestBytes: 1_000_000,
    },
  };
}

function codexProfile(): CodingWorkbenchCodexSubscriptionProfile {
  return {
    schemaVersion: CODING_WORKBENCH_SCHEMA_VERSION,
    profileId: "codex-subscription",
    modelSource: "chatgpt-codex-subscription-profile",
    runtimeSource: "codex-cli-adapter",
    status: "connected",
    authMethod: "codex-access-token",
    credentialStore: "file",
    stateScope: "keiko-owned-state",
    stateRoot: "keiko-codex-runtime-state",
    usesGlobalCodexHome: false,
    runtimeBinarySources: ["managed-sidecar-runtime"],
    supportsBrowserLogin: true,
    supportsDeviceCode: true,
    supportsAccessToken: true,
    deploymentPolicyDisabled: false,
    headless: false,
  };
}

function api(): CodingWorkbenchWindowApi {
  return {
    fetchSidecarGatewayProfile: vi.fn(async () => sidecarProfile()),
    fetchCodexSubscriptionProfile: vi.fn(async () => codexProfile()),
  };
}

describe("CodingWorkbenchWindow", () => {
  it("renders a usable empty workbench surface with visible mode authority", async () => {
    render(<CodingWorkbenchWindow api={api()} />);

    expect(screen.getByRole("region", { name: "Coding Workbench" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Ready for a coding run" })).toBeInTheDocument();
    expect(screen.getByRole("radiogroup", { name: "Coding autonomy mode" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Governed Assist/u })).toBeEnabled();
    expect(screen.getByRole("radio", { name: /Supervised Coding/u })).toBeEnabled();
    expect(screen.getByRole("radio", { name: /Autonomous Delivery/u })).toBeDisabled();
    expect(screen.getByText("No runtime events yet.")).toBeInTheDocument();
    expect(screen.queryByText(/marketing|documentation card/iu)).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByText("Available").length).toBeGreaterThanOrEqual(1));
  });

  it("keeps mode authority visible while running and exposes active Stop and Take Over controls", async () => {
    const onStopRun = vi.fn();
    const onTakeOver = vi.fn();
    const user = userEvent.setup();
    render(
      <CodingWorkbenchWindow
        api={api()}
        projection={CODING_WORKBENCH_PROJECTIONS.running}
        onStopRun={onStopRun}
        onTakeOver={onTakeOver}
      />,
    );

    expect(screen.getByRole("radio", { name: /Supervised Coding/u })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Stop sidecar" }));
    expect(onStopRun).toHaveBeenCalledWith("cw-issue-1990");
    expect(screen.getByRole("status")).toHaveTextContent("Stop requested");
    await user.click(screen.getByRole("button", { name: "Take over manually" }));
    expect(onTakeOver).toHaveBeenCalledWith("cw-issue-1990");
    expect(screen.getByRole("status")).toHaveTextContent("Manual takeover requested");
  });

  it.each([
    ["running", CODING_WORKBENCH_PROJECTIONS.running],
    ["approval-required", CODING_WORKBENCH_PROJECTIONS.approvalRequired],
    ["blocked", CODING_WORKBENCH_PROJECTIONS.blocked],
  ])("keeps operator controls available in the %s active state", (_name, projection) => {
    render(<CodingWorkbenchWindow api={api()} projection={projection} />);

    expect(screen.getByRole("button", { name: "Stop sidecar" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Take over manually" })).toBeEnabled();
  });

  it("renders supervised permission prompts without raw command or diff content", async () => {
    const user = userEvent.setup();
    render(
      <CodingWorkbenchWindow
        api={api()}
        projection={CODING_WORKBENCH_PROJECTIONS.approvalRequired}
      />,
    );

    expect(screen.getByRole("heading", { name: "Just-in-time approval" })).toBeInTheDocument();
    expect(screen.getByText(/workspace write requested/iu)).toBeInTheDocument();
    expect(screen.queryByText(/diff --git|access token|refresh token/iu)).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("Connected")).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Approve once" }));
    expect(screen.getByRole("status")).toHaveTextContent("One-time approval recorded");
    await user.click(screen.getByRole("button", { name: "Deny" }));
    expect(screen.getByRole("status")).toHaveTextContent("Permission request denied");
  });

  it("renders blocked, failed, and completed run summaries distinctly", () => {
    const { rerender } = render(
      <CodingWorkbenchWindow api={api()} projection={CODING_WORKBENCH_PROJECTIONS.blocked} />,
    );
    expect(screen.getByText("Governance holds")).toBeInTheDocument();
    expect(screen.getByText(/network-egress denied/iu)).toBeInTheDocument();

    rerender(
      <CodingWorkbenchWindow api={api()} projection={CODING_WORKBENCH_PROJECTIONS.failed} />,
    );
    expect(screen.getByText("One verification gate failed")).toBeInTheDocument();

    rerender(
      <CodingWorkbenchWindow api={api()} projection={CODING_WORKBENCH_PROJECTIONS.completed} />,
    );
    expect(screen.getByText("Ready for issue PR handoff")).toBeInTheDocument();
  });

  it("renders Governed Assist proposed diffs as review-only and blocked actions distinctly", () => {
    const { rerender } = render(
      <CodingWorkbenchWindow
        api={api()}
        projection={CODING_WORKBENCH_PROJECTIONS.governedAssist}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Issue #1991 Governed Assist proposal" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Governed Assist/u })).toBeDisabled();
    expect(screen.getByText("Proposed diff only")).toBeInTheDocument();
    expect(screen.getByText("120 added, 14 deleted")).toBeInTheDocument();
    expect(
      screen.getByText("No file, Git, PR, merge, or external write authority"),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve once" })).not.toBeInTheDocument();

    rerender(
      <CodingWorkbenchWindow
        api={api()}
        projection={CODING_WORKBENCH_PROJECTIONS.governedAssistBlocked}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Issue #1991 Governed Assist blocked action" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Governance holds")).toBeInTheDocument();
    expect(screen.getByText(/workspace-write denied in Governed Assist/iu)).toBeInTheDocument();
    expect(
      screen.getByText(/connector-write denied; external systems stay read-only/iu),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve once" })).not.toBeInTheDocument();
  });

  it("distinguishes managed gateway, OpenAI-through-gateway, and Codex subscription sources", async () => {
    render(<CodingWorkbenchWindow api={api()} projection={CODING_WORKBENCH_PROJECTIONS.running} />);

    expect(screen.getByText("Keiko Gateway providers")).toBeInTheDocument();
    expect(screen.getByText("OpenAI API key through Gateway")).toBeInTheDocument();
    expect(screen.getByText("ChatGPT/Codex subscription profile")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("Connected")).toBeInTheDocument());
  });

  it("passes axe for the running workbench surface", async () => {
    const { container } = render(
      <CodingWorkbenchWindow api={api()} projection={CODING_WORKBENCH_PROJECTIONS.running} />,
    );

    await waitFor(() => expect(screen.getByText("Connected")).toBeInTheDocument());
    expect(await axe(container)).toHaveNoViolations();
  });
});
