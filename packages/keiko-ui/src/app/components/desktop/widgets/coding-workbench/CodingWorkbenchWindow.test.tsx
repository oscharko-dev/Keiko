import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { describe, expect, it, vi } from "vitest";
import {
  CODING_WORKBENCH_SCHEMA_VERSION,
  validateCodingWorkbenchAuthorityEnvelope,
  validateCodingWorkbenchRuntimeEvent,
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

function unavailableCodexProfile(): CodingWorkbenchCodexSubscriptionProfile {
  return {
    ...codexProfile(),
    status: "redistribution-unapproved",
    runtimeBinarySources: [],
    supportsBrowserLogin: false,
    supportsDeviceCode: false,
    supportsAccessToken: false,
  };
}

function api(): CodingWorkbenchWindowApi {
  return {
    fetchSidecarGatewayProfile: vi.fn(async () => sidecarProfile()),
    fetchCodexSubscriptionProfile: vi.fn(async () => codexProfile()),
  };
}

describe("CodingWorkbenchWindow", () => {
  it("keeps every preview Authority Envelope aligned with the shared contract", () => {
    for (const [name, projection] of Object.entries(CODING_WORKBENCH_PROJECTIONS)) {
      const validation = validateCodingWorkbenchAuthorityEnvelope(projection.authority);
      expect(validation.ok ? [] : validation.errors, name).toEqual([]);
      expect(validation, name).toMatchObject({ ok: true });
    }
  });

  it("keeps every preview runtime event aligned with the shared contract", () => {
    for (const [name, projection] of Object.entries(CODING_WORKBENCH_PROJECTIONS)) {
      for (const event of projection.timeline) {
        const validation = validateCodingWorkbenchRuntimeEvent(event);
        expect(validation.ok ? [] : validation.errors, `${name}:${event.eventId}`).toEqual([]);
        expect(validation, `${name}:${event.eventId}`).toMatchObject({ ok: true });
      }
    }
  });

  it("keeps preview task events inside the Authority Envelope scope", () => {
    for (const [name, projection] of Object.entries(CODING_WORKBENCH_PROJECTIONS)) {
      for (const event of projection.timeline) {
        if (event.kind === "task-submitted") {
          expect(projection.authority.taskRefs, `${name}:${event.eventId}`).toContain(
            event.taskRef,
          );
        }
      }
    }
  });

  it("renders a usable empty workbench surface with visible mode authority", async () => {
    render(<CodingWorkbenchWindow api={api()} />);

    expect(screen.getByRole("region", { name: "Coding Workbench" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Ready for a coding run" })).toBeInTheDocument();
    expect(screen.getByRole("radiogroup", { name: "Coding autonomy mode" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Ask for approval/u })).toBeEnabled();
    expect(screen.getByRole("radio", { name: /Approve for me/u })).toBeEnabled();
    expect(screen.getByRole("radio", { name: /Full access/u })).toBeDisabled();
    expect(screen.getByText("No runtime events yet.")).toBeInTheDocument();
    expect(screen.queryByText(/marketing|documentation card/iu)).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByText("Available").length).toBeGreaterThanOrEqual(1));
  });

  it("announces pending mode changes before server confirmation", async () => {
    const user = userEvent.setup();
    render(<CodingWorkbenchWindow api={api()} />);

    const modeGroup = screen.getByRole("radiogroup", { name: "Coding autonomy mode" });
    expect(modeGroup).toHaveAttribute("aria-busy", "false");

    await user.click(screen.getByRole("radio", { name: /Ask for approval/u }));

    expect(modeGroup).toHaveAttribute("aria-busy", "true");
    expect(screen.getByText("Mode change pending server confirmation.")).toHaveAttribute(
      "role",
      "status",
    );
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

    expect(screen.getByRole("radio", { name: /Approve for me/u })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Stop sidecar" }));
    expect(onStopRun).toHaveBeenCalledWith("run-1990");
    expect(screen.getByRole("status")).toHaveTextContent("Stop requested");
    await user.click(screen.getByRole("button", { name: "Take over manually" }));
    expect(onTakeOver).toHaveBeenCalledWith("run-1990");
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
    expect(screen.getByText("Action kind")).toBeInTheDocument();
    expect(screen.getByText("file-edit")).toBeInTheDocument();
    expect(screen.getByText("workspace-scope")).toBeInTheDocument();
    expect(screen.getByText("approval-required")).toBeInTheDocument();
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
    expect(screen.getByRole("radio", { name: /Ask for approval/u })).toBeDisabled();
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

  it("renders the Supervised Coding approval lifecycle without raw evidence bodies", async () => {
    const onStopRun = vi.fn();
    const user = userEvent.setup();
    const { rerender } = render(
      <CodingWorkbenchWindow
        api={api()}
        projection={CODING_WORKBENCH_PROJECTIONS.supervisedApprovalRequired}
        onStopRun={onStopRun}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Issue #1992 Supervised Coding approval" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Push requires one-time approval")).toBeInTheDocument();
    expect(screen.getByText("push")).toBeInTheDocument();
    expect(screen.getByText("high")).toBeInTheDocument();
    expect(
      screen.queryByText(/stdout|stderr|diff --git|Bearer|\/Users\//u),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Stop sidecar" }));
    expect(onStopRun).toHaveBeenCalledWith("run-1992");
    expect(screen.getByRole("status")).toHaveTextContent("Stop requested");

    rerender(
      <CodingWorkbenchWindow
        api={api()}
        projection={CODING_WORKBENCH_PROJECTIONS.supervisedApproved}
      />,
    );
    expect(screen.getByText("Approved once for this scope")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("No operator override requested");

    rerender(
      <CodingWorkbenchWindow
        api={api()}
        projection={CODING_WORKBENCH_PROJECTIONS.supervisedDenied}
      />,
    );
    expect(screen.getByText("Denied before mutation")).toBeInTheDocument();
    expect(screen.getAllByText("operator-denied").length).toBeGreaterThanOrEqual(1);

    rerender(
      <CodingWorkbenchWindow
        api={api()}
        projection={CODING_WORKBENCH_PROJECTIONS.supervisedStopped}
      />,
    );
    expect(screen.getByText("Stopped before mutation")).toBeInTheDocument();
    expect(screen.getAllByText("operator-stopped").length).toBeGreaterThanOrEqual(1);

    rerender(
      <CodingWorkbenchWindow
        api={api()}
        projection={CODING_WORKBENCH_PROJECTIONS.supervisedFailed}
      />,
    );
    expect(screen.getByText("Verification failed with redacted output")).toBeInTheDocument();
    expect(screen.getAllByText("redacted-failure").length).toBeGreaterThanOrEqual(1);
  });

  it("renders Autonomous Delivery closeout states without exposing raw provider material", () => {
    const { rerender } = render(
      <CodingWorkbenchWindow
        api={api()}
        projection={CODING_WORKBENCH_PROJECTIONS.autonomousConfirmed}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Issue #1994 Autonomous Delivery confirmed envelope" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Full access/u })).toBeChecked();
    expect(screen.getByText("Governed PR gateway handoff pending")).toBeInTheDocument();
    expect(screen.getByText("Delivery runner")).toBeInTheDocument();
    expect(
      screen.queryByText(/Authorization|Bearer|ghp_|diff --git|\/Users\//u),
    ).not.toBeInTheDocument();

    rerender(
      <CodingWorkbenchWindow
        api={api()}
        projection={CODING_WORKBENCH_PROJECTIONS.autonomousPolicyBlocked}
      />,
    );
    expect(screen.getByText("No provider write executed")).toBeInTheDocument();
    expect(screen.getAllByText("authority-expired").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("connector-scope-missing")).toBeInTheDocument();

    rerender(
      <CodingWorkbenchWindow
        api={api()}
        projection={CODING_WORKBENCH_PROJECTIONS.autonomousVerificationFailed}
      />,
    );
    expect(screen.getByText("PR creation blocked by verification")).toBeInTheDocument();
    expect(screen.getAllByText("verification-failed").length).toBeGreaterThanOrEqual(1);

    rerender(
      <CodingWorkbenchWindow
        api={api()}
        projection={CODING_WORKBENCH_PROJECTIONS.autonomousCompleted}
      />,
    );
    expect(screen.getByText("Draft PR created through governed PR gateway")).toBeInTheDocument();
    expect(screen.getByText("pull")).toBeInTheDocument();
  });

  it("distinguishes managed gateway, OpenAI-through-gateway, and Codex subscription sources", async () => {
    render(<CodingWorkbenchWindow api={api()} projection={CODING_WORKBENCH_PROJECTIONS.running} />);

    expect(screen.getByText("Keiko Gateway providers")).toBeInTheDocument();
    expect(screen.getByText("OpenAI API key through Gateway")).toBeInTheDocument();
    expect(screen.getByText("ChatGPT/Codex subscription profile")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("Connected")).toBeInTheDocument());
  });

  it("keeps an unapproved Codex subscription unavailable without setup or local-install controls", async () => {
    const { container } = render(
      <CodingWorkbenchWindow
        api={{
          fetchSidecarGatewayProfile: vi.fn(async () => sidecarProfile()),
          fetchCodexSubscriptionProfile: vi.fn(async () => unavailableCodexProfile()),
        }}
        projection={CODING_WORKBENCH_PROJECTIONS.running}
      />,
    );

    await waitFor(() =>
      expect(screen.getByText("Unavailable in this release")).toBeInTheDocument(),
    );
    expect(
      screen.getByText("Codex subscriptions are not supported in this release."),
    ).toBeInTheDocument();
    expect(screen.queryByText("Needs setup")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /login|local install/u })).not.toBeInTheDocument();
    const availabilityStatus = screen.getByText(
      "ChatGPT/Codex subscription profile unavailable in this release",
    );
    expect(availabilityStatus).toHaveAttribute("role", "status");
    expect(availabilityStatus).toHaveAttribute("aria-live", "polite");
    expect(availabilityStatus).toHaveAttribute("aria-atomic", "true");
    expect(await axe(container)).toHaveNoViolations();
  });

  it("passes axe for the running workbench surface", async () => {
    const { container } = render(
      <CodingWorkbenchWindow api={api()} projection={CODING_WORKBENCH_PROJECTIONS.running} />,
    );

    await waitFor(() => expect(screen.getByText("Connected")).toBeInTheDocument());
    expect(await axe(container)).toHaveNoViolations();
  });
});
