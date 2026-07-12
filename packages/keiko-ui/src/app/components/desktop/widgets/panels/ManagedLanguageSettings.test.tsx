import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { axe } from "jest-axe";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  ManagedLspActivationReasonCode,
  ManagedLspEffectiveState,
  ManagedLspLanguage,
} from "@oscharko-dev/keiko-contracts";
import { ApiError, type ManagedLspSettingsResponse } from "@/lib/api";
import { I18nProvider } from "@/lib/i18n";

import { ManagedLanguageSettings } from "./ManagedLanguageSettings";

const fetchSettingsMock = vi.fn();
const mutateSettingsMock = vi.fn();

vi.mock("@/lib/api", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...original,
    fetchManagedLspSettings: (...args: readonly unknown[]): Promise<unknown> =>
      fetchSettingsMock(...args),
    mutateManagedLspSettings: (...args: readonly unknown[]): Promise<unknown> =>
      mutateSettingsMock(...args),
  };
});

function status(
  state: ManagedLspEffectiveState,
  reasonCode: ManagedLspActivationReasonCode,
  language: ManagedLspLanguage = "python",
): ManagedLspSettingsResponse["languages"][number] {
  return {
    ok: true,
    schemaVersion: "1",
    language,
    configurationRevision: 3,
    state,
    reasonCode,
    policyResult: state === "disabledByPolicy" ? "denied" : "allowed",
  };
}

function snapshot(
  state: ManagedLspEffectiveState = "active",
  reason: ManagedLspActivationReasonCode = "ACTIVE",
): ManagedLspSettingsResponse {
  return {
    storeState: "ready",
    revision: 3,
    etag: '"lspcfg-3-abcdefghijklmnop"',
    evidenceCount: 2,
    languages: [status(state, reason)],
    settings: [
      {
        language: "python",
        workspaceActivation: "enabled",
        configured: true,
        restartRequired: state === "restartRequired",
        restartFields: state === "restartRequired" ? ["settings"] : [],
        provenance: {
          activation: "workspace",
          runtime: "operatorProvisioning",
          settings: "workspace",
        },
      },
    ],
    configurations: [
      {
        schemaVersion: "1",
        language: "python",
        revision: 3,
        etag: '"lspcfg-3-abcdefghijklmnop"',
        activation: "enabled",
        runtime: { kind: "operatorApproved", runtimeId: "python-lsp" },
        provenance: {
          activation: "workspace",
          runtime: "operatorProvisioning",
          settings: "workspace",
        },
        restartRequired: false,
        restartFields: [],
        settings: {
          interpreter: { kind: "operatorApproved", runtimeId: "python-lsp" },
          venv: null,
          typeCheckingMode: "standard",
          extraPaths: [],
          configurationPrecedence: ["workspaceConfiguration", "pyproject", "builtInDefault"],
        },
      },
    ],
    providerMetadata: [{ language: "python", configurationSource: "pyproject" }],
    health: [
      {
        schemaVersion: "1",
        managerId: "python-lsp",
        language: "python",
        status: "READY",
        restartCount: 0,
        configurationRevision: 3,
        negotiatedOperations: Array.from({ length: 30 }, (_, index) =>
          index % 2 === 0 ? "completion" : "hover",
        ),
        lastTransitionTimestampMs: 1_000,
        pendingRequestCount: 0,
        requestCount: 5,
        successCount: 5,
        timeoutCount: 0,
        cancellationCount: 0,
        failureCount: 0,
        latency: {
          count: 5,
          totalMs: 50,
          maximumMs: 20,
          lessThanOrEqual10Ms: 3,
          lessThanOrEqual50Ms: 2,
          lessThanOrEqual250Ms: 0,
          lessThanOrEqual1Second: 0,
          greaterThan1Second: 0,
        },
      },
    ],
  };
}

function renderSettings(root = "/workspace/one") {
  return render(
    <I18nProvider>
      <ManagedLanguageSettings root={root} />
    </I18nProvider>,
  );
}

afterEach(() => {
  vi.clearAllMocks();
  document.documentElement.lang = "en";
  document.documentElement.removeAttribute("data-locale");
  window.localStorage.clear();
});

describe("ManagedLanguageSettings", () => {
  it.each([
    ["disabled", "WORKSPACE_DISABLED", "Disabled"],
    ["disabledByPolicy", "POLICY_DENIED", "Disabled by policy"],
    ["notProvisioned", "NOT_PROVISIONED", "Not provisioned"],
    ["available", "AVAILABLE", "Available"],
    ["starting", "STARTING", "Starting"],
    ["active", "ACTIVE", "Active"],
    ["degraded", "RUNTIME_DEGRADED", "Degraded"],
    ["unhealthy", "RUNTIME_UNHEALTHY", "Unhealthy"],
    ["restartRequired", "RESTART_REQUIRED", "Restart required"],
  ] as const)("renders %s with localized non-color-only text", async (state, reason, label) => {
    fetchSettingsMock.mockResolvedValue(snapshot(state, reason));
    const { container } = renderSettings();
    expect(await screen.findByText(label)).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it("does not send activation for policy-disabled or unprovisioned providers", async () => {
    fetchSettingsMock.mockResolvedValue(snapshot("disabledByPolicy", "POLICY_DENIED"));
    renderSettings();
    await screen.findByText("Disabled by policy");
    expect(screen.queryByRole("button", { name: "Enable Python" })).toBeNull();
    expect(mutateSettingsMock).not.toHaveBeenCalled();
  });

  it("does not send activation for not-provisioned providers", async () => {
    fetchSettingsMock.mockResolvedValue(snapshot("notProvisioned", "NOT_PROVISIONED"));
    renderSettings();
    await screen.findByText("Not provisioned");
    expect(screen.queryByRole("button", { name: "Enable Python" })).toBeNull();
    expect(mutateSettingsMock).not.toHaveBeenCalled();
  });

  it("confirms disruptive actions, supports cancel, and restores opener focus", async () => {
    fetchSettingsMock.mockResolvedValue(snapshot());
    const { container } = renderSettings();
    const disable = await screen.findByRole("button", { name: "Disable Python" });
    disable.focus();
    fireEvent.click(disable);
    const cancel = screen.getByRole("button", { name: "Cancel" });
    await waitFor(() => expect(cancel).toHaveFocus());
    expect(await axe(container)).toHaveNoViolations();
    expect(mutateSettingsMock).not.toHaveBeenCalled();
    fireEvent.click(cancel);
    await waitFor(() => expect(disable).toHaveFocus());
  });

  it("restores focus to the section title when the opener is removed by a confirmed action", async () => {
    fetchSettingsMock
      .mockResolvedValueOnce(snapshot("active", "ACTIVE"))
      .mockResolvedValueOnce(snapshot("disabled", "WORKSPACE_DISABLED"));
    mutateSettingsMock.mockResolvedValue(undefined);
    renderSettings();
    const deactivate = await screen.findByRole("button", { name: "Disable Python" });
    fireEvent.click(deactivate);
    fireEvent.click(screen.getByRole("button", { name: "Confirm disable" }));

    await screen.findByText("Disabled");
    expect(screen.queryByRole("button", { name: "Disable Python" })).toBeNull();
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Language intelligence" })).toHaveFocus(),
    );
  });

  it("bounds negotiated capabilities and has no axe violations", async () => {
    fetchSettingsMock.mockResolvedValue(snapshot());
    const { container } = renderSettings();
    await screen.findByText("Active");
    expect(screen.getAllByTestId("managed-lsp-capability").length).toBeLessThanOrEqual(12);
    expect(screen.getByText(/18 more capabilities/i)).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it("shows approved Python identities, precedence, and detected project source", async () => {
    fetchSettingsMock.mockResolvedValue(snapshot());
    renderSettings();
    expect(await screen.findByText(/interpreter: python-lsp/i)).toBeInTheDocument();
    expect(screen.getByText(/virtual environment: default/i)).toBeInTheDocument();
    expect(
      screen.getByText(/workspaceConfiguration > pyproject > builtInDefault/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/detected project configuration: pyproject/i)).toBeInTheDocument();
  });

  it("does not show a false active state before the server acknowledges activation", async () => {
    let acknowledge: (() => void) | undefined;
    mutateSettingsMock.mockReturnValue(
      new Promise<void>((resolve) => {
        acknowledge = resolve;
      }),
    );
    fetchSettingsMock
      .mockResolvedValueOnce(snapshot("available", "AVAILABLE"))
      .mockResolvedValueOnce(snapshot("active", "ACTIVE"));
    renderSettings();
    fireEvent.click(await screen.findByRole("button", { name: "Enable Python" }));
    expect(screen.getByText("Available")).toBeInTheDocument();
    expect(screen.queryByText("Active")).toBeNull();
    acknowledge?.();
    expect(await screen.findByText("Active")).toBeInTheDocument();
  });

  it("renders the initial load failure with a working retry control and no axe violations", async () => {
    fetchSettingsMock.mockRejectedValueOnce(new Error("network unreachable"));
    fetchSettingsMock.mockResolvedValueOnce(snapshot());
    const { container } = renderSettings();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Language intelligence could not be loaded.");
    const retry = screen.getByRole("button", { name: "Retry" });
    expect(await axe(container)).toHaveNoViolations();

    fireEvent.click(retry);

    expect(await screen.findByText("Active")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(fetchSettingsMock).toHaveBeenCalledTimes(2);
    expect(mutateSettingsMock).not.toHaveBeenCalled();
  });

  it("reloads a stale revision while preserving the requested action for retry", async () => {
    fetchSettingsMock.mockResolvedValue(snapshot("available", "AVAILABLE"));
    mutateSettingsMock.mockRejectedValue(new ApiError("STALE_REVISION", "stale", 412));
    const { container } = renderSettings();
    fireEvent.click(await screen.findByRole("button", { name: "Enable Python" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/changed on the server/i);
    expect(screen.getByRole("button", { name: /retry requested change/i })).toBeInTheDocument();
    expect(screen.getByText("Available")).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it("preserves validated unsaved runtime settings across a stale revision", async () => {
    fetchSettingsMock.mockResolvedValue(snapshot());
    mutateSettingsMock.mockRejectedValue(new ApiError("STALE_REVISION", "stale", 412));
    renderSettings("/workspace/configuration");
    const mode = await screen.findByRole("combobox", { name: "Type-checking mode" });
    fireEvent.change(mode, { target: { value: "strict" } });
    expect(screen.getByText("Unsaved workspace settings")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/changed on the server/i);
    expect(mode).toHaveValue("strict");
    expect(mutateSettingsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "configure",
        configuration: expect.objectContaining({
          settings: expect.objectContaining({ typeCheckingMode: "strict" }),
        }),
      }),
      expect.any(String),
      expect.any(String),
      expect.any(AbortSignal),
    );
  });

  it("aborts a slow prior workspace read and never renders its late state", async () => {
    let resolveFirst: ((value: ManagedLspSettingsResponse) => void) | undefined;
    let firstSignal: AbortSignal | undefined;
    fetchSettingsMock.mockImplementation((root: string, signal: AbortSignal) => {
      if (root === "/workspace/one") {
        firstSignal = signal;
        return new Promise<ManagedLspSettingsResponse>((resolve) => {
          resolveFirst = resolve;
        });
      }
      return Promise.resolve(snapshot("notProvisioned", "NOT_PROVISIONED"));
    });
    const { rerender } = renderSettings("/workspace/one");
    rerender(
      <I18nProvider>
        <ManagedLanguageSettings root="/workspace/two" />
      </I18nProvider>,
    );

    expect(await screen.findByText("Not provisioned")).toBeInTheDocument();
    expect(firstSignal?.aborted).toBe(true);
    resolveFirst?.(snapshot("active", "ACTIVE"));
    await Promise.resolve();
    expect(screen.queryByText("Active")).toBeNull();
  });

  it("preserves restart intent after a server failure without claiming success", async () => {
    fetchSettingsMock.mockResolvedValue(snapshot("restartRequired", "RESTART_REQUIRED"));
    mutateSettingsMock.mockRejectedValue(new ApiError("STATE_UNAVAILABLE", "failed", 503));
    renderSettings();
    fireEvent.click(await screen.findByRole("button", { name: "Restart Python" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm restart" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/was not applied/i);
    expect(screen.getByText("Restart required")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /retry requested change/i })).toBeInTheDocument();
  });

  it("discards a failed mutation intent when the panel unmounts", async () => {
    fetchSettingsMock.mockResolvedValue(snapshot("restartRequired", "RESTART_REQUIRED"));
    mutateSettingsMock.mockRejectedValue(new ApiError("STATE_UNAVAILABLE", "failed", 503));
    const first = renderSettings("/workspace/discarded-intent");
    fireEvent.click(await screen.findByRole("button", { name: "Restart Python" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm restart" }));
    expect(
      await screen.findByRole("button", { name: /retry requested change/i }),
    ).toBeInTheDocument();

    first.unmount();
    renderSettings("/workspace/discarded-intent");

    expect(await screen.findByText("Restart required")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /retry requested change/i })).toBeNull();
  });

  it("cancels an in-flight mutation when the workspace changes", async () => {
    let mutationSignal: AbortSignal | undefined;
    fetchSettingsMock.mockImplementation((root: string) =>
      Promise.resolve(
        root === "/workspace/one"
          ? snapshot("active", "ACTIVE")
          : snapshot("available", "AVAILABLE"),
      ),
    );
    mutateSettingsMock.mockImplementation(
      (...args: readonly unknown[]) =>
        new Promise(() => {
          mutationSignal = args[3] as AbortSignal;
        }),
    );
    const { rerender } = renderSettings("/workspace/one");
    fireEvent.click(await screen.findByRole("button", { name: "Restart Python" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm restart" }));
    rerender(
      <I18nProvider>
        <ManagedLanguageSettings root="/workspace/two" />
      </I18nProvider>,
    );

    expect(await screen.findByText("Available")).toBeInTheDocument();
    expect(mutationSignal?.aborted).toBe(true);
  });

  it("renders the complete managed-language surface in German", async () => {
    window.localStorage.setItem("keiko.locale", "de");
    fetchSettingsMock.mockResolvedValue(snapshot("restartRequired", "RESTART_REQUIRED"));
    renderSettings("/workspace/de");

    expect(await screen.findByText("Sprachintelligenz")).toBeInTheDocument();
    expect(screen.getByText("Neustart erforderlich")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Python neu starten" })).toBeInTheDocument();
  });
});
