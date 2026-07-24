import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { axe } from "jest-axe";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  ManagedLspActivationReasonCode,
  ManagedLspEffectiveState,
  ManagedLspLanguage,
  ManagedLspRuntimeConfiguration,
} from "@oscharko-dev/keiko-contracts";
import { ApiError, type ManagedLspSettingsResponse } from "@/lib/api";
import { I18nProvider } from "@/lib/i18n";
import {
  managedLspTestConfiguration,
  managedLspTestConfigurationDefaults,
} from "@/test-utils/managed-lsp-settings-fixture";

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

vi.mock("../../workspace-trust/useWorkspaceTrust", () => ({
  useWorkspaceTrust: (projectId: string | undefined) => ({
    status:
      projectId === undefined
        ? undefined
        : {
            kind: "workspace-trust-status",
            schemaVersion: 1,
            projectId,
            trust: "trusted",
            decidedBy: "server",
            reason: "human-grant",
            revision: 1,
          },
    loading: false,
    mutating: false,
    issue: undefined,
    refresh: async () => undefined,
    grant: async () => true,
    revoke: async () => true,
  }),
}));

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
      managedLspTestConfiguration("python", "workspace", 3, '"lspcfg-3-abcdefghijklmnop"'),
    ],
    configurationDefaults: managedLspTestConfigurationDefaults(3, '"lspcfg-3-abcdefghijklmnop"'),
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

function initialConfigurationSnapshot(
  language: ManagedLspLanguage = "python",
): ManagedLspSettingsResponse & {
  readonly configurationDefaults: readonly ManagedLspRuntimeConfiguration[];
} {
  const current = snapshot("available", "AVAILABLE");
  return {
    ...current,
    languages: [status("available", "AVAILABLE", language)],
    settings: [
      {
        language,
        workspaceActivation: "enabled",
        configured: false,
        restartRequired: false,
        restartFields: [],
        provenance: null,
      },
    ],
    configurations: [],
    configurationDefaults: managedLspTestConfigurationDefaults(3, '"lspcfg-3-abcdefghijklmnop"'),
    providerMetadata:
      language === "python" ? [{ language: "python", configurationSource: "pyproject" }] : [],
    health: [],
  };
}

function configuredLanguageSnapshot(
  language: ManagedLspLanguage,
  state: ManagedLspEffectiveState,
  reason: ManagedLspActivationReasonCode,
): ManagedLspSettingsResponse {
  const current = snapshot(state, reason);
  return {
    ...current,
    languages: [status(state, reason, language)],
    settings: [
      {
        language,
        workspaceActivation: "enabled",
        configured: true,
        restartRequired: state === "restartRequired",
        restartFields: state === "restartRequired" ? ["runtime", "settings"] : [],
        provenance: {
          activation: "workspace",
          runtime: "operatorProvisioning",
          settings: "workspace",
        },
      },
    ],
    configurations: [
      managedLspTestConfiguration(language, "workspace", 3, '"lspcfg-3-abcdefghijklmnop"'),
    ],
    configurationDefaults: managedLspTestConfigurationDefaults(3, '"lspcfg-3-abcdefghijklmnop"'),
    providerMetadata:
      language === "python" ? [{ language: "python", configurationSource: "pyproject" }] : [],
    health: [],
  };
}

function inactiveSnapshot(): ManagedLspSettingsResponse {
  const current = snapshot("disabled", "WORKSPACE_ACTIVATION_UNSET");
  return {
    ...current,
    settings: [
      {
        language: "python",
        workspaceActivation: "unset",
        configured: false,
        restartRequired: false,
        restartFields: [],
        provenance: null,
      },
    ],
    configurations: [],
    health: [],
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
    expect(screen.queryByRole("button", { name: "Save settings" })).toBeNull();
    expect(mutateSettingsMock).not.toHaveBeenCalled();
  });

  it("explains Restricted Mode without offering an activation bypass", async () => {
    fetchSettingsMock.mockResolvedValue(snapshot("disabledByPolicy", "WORKSPACE_UNTRUSTED"));
    renderSettings();
    expect(
      await screen.findByText(
        "Restricted Mode prevents this workspace from starting managed language servers.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Enable Python" })).toBeNull();
    expect(mutateSettingsMock).not.toHaveBeenCalled();
  });

  it("does not send activation for not-provisioned providers", async () => {
    fetchSettingsMock.mockResolvedValue(snapshot("notProvisioned", "NOT_PROVISIONED"));
    renderSettings();
    await screen.findByText("Not provisioned");
    expect(screen.queryByRole("button", { name: "Enable Python" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Save settings" })).toBeNull();
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

  it("restores focus to the section title immediately when the opener is already disconnected", async () => {
    fetchSettingsMock.mockResolvedValue(snapshot());
    renderSettings();
    const disable = await screen.findByRole("button", { name: "Disable Python" });
    fireEvent.click(disable);
    const cancel = screen.getByRole("button", { name: "Cancel" });
    await waitFor(() => expect(cancel).toHaveFocus());
    disable.remove();
    fireEvent.click(cancel);
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Language intelligence" })).toHaveFocus(),
    );
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

  it.each([
    ["python", "Python"],
    ["go", "Go"],
    ["shell", "Shell"],
    ["java", "Java"],
    ["rust", "Rust"],
  ] as const)(
    "accepts the server-owned initial %s configuration without inventing browser runtime identities",
    async (language, _label): Promise<void> => {
      fetchSettingsMock
        .mockResolvedValueOnce(initialConfigurationSnapshot(language))
        .mockResolvedValueOnce(
          configuredLanguageSnapshot(language, "restartRequired", "RESTART_REQUIRED"),
        );
      mutateSettingsMock.mockResolvedValue(undefined);
      renderSettings(`/workspace/initial-${language}`);

      const save = await screen.findByRole("button", { name: "Save settings" });
      expect(save).toBeEnabled();
      fireEvent.click(save);

      await screen.findByText("Restart required");
      expect(mutateSettingsMock).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "configure",
          configuration: expect.objectContaining({
            language,
            runtime: { kind: "operatorApproved", runtimeId: `${language}-lsp` },
            provenance: {
              activation: "workspace",
              runtime: "operatorProvisioning",
              settings: "workspace",
            },
          }),
        }),
        expect.any(String),
        expect.any(String),
        expect.any(AbortSignal),
      );
    },
  );

  it.each(["python", "go", "shell", "java", "rust"] as const)(
    "preserves the initial %s configuration intent across a stale revision",
    async (language): Promise<void> => {
      fetchSettingsMock.mockResolvedValue(initialConfigurationSnapshot(language));
      mutateSettingsMock.mockRejectedValue(new ApiError("STALE_REVISION", "stale", 412));
      renderSettings(`/workspace/initial-stale-${language}`);

      fireEvent.click(await screen.findByRole("button", { name: "Save settings" }));

      expect(await screen.findByRole("alert")).toHaveTextContent(/changed on the server/i);
      expect(screen.getByRole("button", { name: "Save settings" })).toBeEnabled();
      expect(screen.getByRole("button", { name: /retry requested change/i })).toBeInTheDocument();
    },
  );

  it("blocks an invalid initial Rust target before any mutation", async (): Promise<void> => {
    fetchSettingsMock.mockResolvedValue(initialConfigurationSnapshot("rust"));
    renderSettings("/workspace/initial-invalid-rust");

    const target = await screen.findByRole("textbox", { name: "Rust target triple" });
    fireEvent.change(target, { target: { value: "-unapproved" } });

    expect(screen.getByRole("alert")).toHaveTextContent(/use an empty target/i);
    expect(screen.getByRole("button", { name: "Save settings" })).toBeDisabled();
    expect(mutateSettingsMock).not.toHaveBeenCalled();
  });

  it("blocks incompatible initial Java source and target levels before any mutation", async (): Promise<void> => {
    fetchSettingsMock.mockResolvedValue(initialConfigurationSnapshot("java"));
    renderSettings("/workspace/initial-invalid-java");

    const source = await screen.findByRole("combobox", { name: "Java source level" });
    const target = screen.getByRole("combobox", { name: "Java target level" });
    fireEvent.change(source, { target: { value: "25" } });
    fireEvent.change(target, { target: { value: "17" } });

    expect(screen.getByRole("alert")).toHaveTextContent(/source level cannot be newer/i);
    expect(screen.getByRole("button", { name: "Save settings" })).toBeDisabled();
    expect(mutateSettingsMock).not.toHaveBeenCalled();
  });

  it("ignores a stale configured draft when accepting a server-owned initial default", async (): Promise<void> => {
    const root = "/workspace/stale-initial-draft";
    fetchSettingsMock.mockResolvedValue(snapshot());
    const configured = renderSettings(root);
    const configuredMode = await screen.findByRole("combobox", { name: "Type-checking mode" });
    fireEvent.change(configuredMode, { target: { value: "strict" } });
    expect(configuredMode).toHaveValue("strict");
    configured.unmount();

    fetchSettingsMock.mockResolvedValue(initialConfigurationSnapshot("python"));
    mutateSettingsMock.mockResolvedValue(undefined);
    renderSettings(root);

    const initialMode = await screen.findByRole("combobox", { name: "Type-checking mode" });
    expect(initialMode).toHaveValue("standard");
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    expect(mutateSettingsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        configuration: expect.objectContaining({
          settings: expect.objectContaining({ typeCheckingMode: "standard" }),
        }),
      }),
      expect.any(String),
      expect.any(String),
      expect.any(AbortSignal),
    );
  });

  it("does not show a false active state before the server acknowledges activation", async () => {
    let acknowledge: (() => void) | undefined;
    mutateSettingsMock.mockReturnValue(
      new Promise<void>((resolve) => {
        acknowledge = resolve;
      }),
    );
    fetchSettingsMock
      .mockResolvedValueOnce(inactiveSnapshot())
      .mockResolvedValueOnce(snapshot("active", "ACTIVE"));
    renderSettings();
    fireEvent.click(await screen.findByRole("button", { name: "Enable Python" }));
    expect(screen.getByText("Disabled")).toBeInTheDocument();
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
    fetchSettingsMock.mockResolvedValue(inactiveSnapshot());
    mutateSettingsMock.mockRejectedValue(new ApiError("STALE_REVISION", "stale", 412));
    const { container } = renderSettings();
    fireEvent.click(await screen.findByRole("button", { name: "Enable Python" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/changed on the server/i);
    expect(screen.getByRole("button", { name: /retry requested change/i })).toBeInTheDocument();
    expect(screen.getByText("Disabled")).toBeInTheDocument();
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
