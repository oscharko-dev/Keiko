import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JiraHumanInputView } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import * as inputApi from "@/lib/jira-human-input-api";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";
import { I18N_STORAGE_KEY, I18nProvider, loadLocaleMessages } from "@/lib/i18n";
import { loadOptionalWidgetMessages } from "@/lib/optional-widget-i18n";
import { JiraHumanInput } from "./JiraHumanInput";
import type { ChatToolExchange } from "@oscharko-dev/keiko-contracts/bff-wire";

// The component takes no model-call prop. A caller that still forwards the model's call must not
// influence the reviewed target, so these tests hand it over as an untyped extra prop.
function untrustedModelCall(call: ChatToolExchange["call"]): object {
  return { call };
}
vi.mock("@/lib/jira-human-input-api", () => ({
  getJiraHumanInput: vi.fn(),
  submitJiraHumanInput: vi.fn(),
  cancelJiraHumanInput: vi.fn(),
}));
vi.mock("@/lib/client-diagnostics", () => ({ reportClientDiagnostic: vi.fn() }));
const REVIEW_CONNECTION = {
  jiraBaseUrl: "https://jira.example.invalid/context",
  actorUserKey: "native-operator-key",
  actorUsername: "Native operator",
};
const LOGIN_REVIEW = {
  ...REVIEW_CONNECTION,
  targetKind: "user" as const,
  targetUserKey: REVIEW_CONNECTION.actorUserKey,
  targetUsername: REVIEW_CONNECTION.actorUsername,
};
function view(): JiraHumanInputView {
  return {
    requestId: `jhi_${"a".repeat(64)}`,
    revision: "12345678-1234-4123-8123-123456789abc",
    purpose: "login",
    state: "awaiting-input",
    expiresAt: Date.now() + 60000,
    fields: ["password"],
    optionalFields: [],
    review: LOGIN_REVIEW,
  };
}
function withoutReview(initial: JiraHumanInputView): JiraHumanInputView {
  const legacy = { ...initial };
  delete legacy.review;
  return legacy;
}
beforeEach(() => {
  vi.clearAllMocks();
  localStorage.removeItem(I18N_STORAGE_KEY);
});
afterEach(() => {
  localStorage.removeItem(I18N_STORAGE_KEY);
});
describe("Jira human-only input", () => {
  it("clears the typed value before the one submission settles and never stores it as a draft", async () => {
    const initial = view();
    vi.mocked(inputApi.getJiraHumanInput).mockResolvedValue(initial);
    let complete: ((value: JiraHumanInputView) => void) | undefined;
    vi.mocked(inputApi.submitJiraHumanInput).mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const { container } = render(<JiraHumanInput initial={initial} turnState="pending" />);
    const user = userEvent.setup();
    await waitFor(() => expect(screen.getByLabelText("Password")).toBeEnabled());
    await user.type(screen.getByLabelText("Password"), "synthetic-private-entry");
    await user.click(screen.getByRole("button", { name: "Provide securely" }));
    expect(screen.getByLabelText("Password")).toHaveValue("");
    expect(inputApi.submitJiraHumanInput).toHaveBeenCalledExactlyOnceWith(initial.requestId, {
      expectedRevision: initial.revision,
      values: { password: "synthetic-private-entry" },
    });
    expect(JSON.stringify(localStorage)).not.toContain("synthetic-private-entry");
    expect(container.textContent).not.toContain("synthetic-private-entry");
    await act(async () => {
      complete?.({ ...initial, revision: "87654321-1234-4123-8123-123456789abc", state: "ready" });
    });
    expect(screen.queryByLabelText("Password")).toBeNull();
  });
  it("reconciles an uncertain submission with a state-only read and never repeats it after reload", async () => {
    const initial = view();
    vi.mocked(inputApi.getJiraHumanInput).mockResolvedValue(initial);
    vi.mocked(inputApi.submitJiraHumanInput).mockRejectedValue(
      new TypeError("synthetic transport failure"),
    );
    const user = userEvent.setup();
    const first = render(<JiraHumanInput initial={initial} turnState="pending" />);
    await waitFor(() => expect(screen.getByLabelText("Password")).toBeEnabled());
    await user.type(screen.getByLabelText("Password"), "synthetic-private-entry");
    await user.click(screen.getByRole("button", { name: "Provide securely" }));
    await screen.findByRole("alert");
    expect(screen.getByLabelText("Password")).toHaveValue("");
    expect(screen.getByRole("button", { name: "Provide securely" })).toBeDisabled();
    first.unmount();
    vi.mocked(inputApi.getJiraHumanInput).mockResolvedValue({ ...initial, state: "consumed" });
    render(<JiraHumanInput initial={initial} turnState="pending" />);
    await screen.findByText(
      "Your input was consumed once. The operation result appears in its result card.",
    );
    expect(screen.queryByLabelText("Password")).toBeNull();
    expect(inputApi.submitJiraHumanInput).toHaveBeenCalledTimes(1);
  });
  it.each(["en", "de"] as const)(
    "keeps the protected controls accessible in %s",
    async (locale) => {
      await loadLocaleMessages(locale);
      await loadOptionalWidgetMessages(locale);
      localStorage.setItem(I18N_STORAGE_KEY, locale);
      const initial = view();
      vi.mocked(inputApi.getJiraHumanInput).mockResolvedValue(initial);
      const { container } = render(
        <I18nProvider>
          <JiraHumanInput initial={initial} turnState="pending" />
        </I18nProvider>,
      );
      await waitFor(() =>
        expect(screen.getByLabelText(locale === "de" ? "Passwort" : "Password")).toBeEnabled(),
      );
      expect(await axe(container)).toHaveNoViolations();
      expect(container.textContent).not.toContain('"requestId"');
    },
  );
  it.each(["en", "de"] as const)(
    "shows the trusted Jira destination, purpose and distinct password target in %s",
    async (locale) => {
      await loadLocaleMessages(locale);
      await loadOptionalWidgetMessages(locale);
      localStorage.setItem(I18N_STORAGE_KEY, locale);
      const initial: JiraHumanInputView = {
        ...view(),
        purpose: "update-user-password",
        review: {
          ...REVIEW_CONNECTION,
          targetKind: "user",
          targetUserKey: "native-target-key",
          targetUsername: "Verified target",
        },
      };
      vi.mocked(inputApi.getJiraHumanInput).mockResolvedValue(initial);
      const { container } = render(
        <I18nProvider>
          <JiraHumanInput
            initial={initial}
            turnState="pending"
            {...untrustedModelCall({
              id: "untrusted-call",
              name: "jira_update_user_password",
              arguments: { username: "Model target", baseUrl: "https://untrusted.example.invalid" },
            })}
          />
        </I18nProvider>,
      );
      await waitFor(() =>
        expect(
          screen.getByLabelText(locale === "de" ? "Neues Passwort" : "New password"),
        ).toBeEnabled(),
      );
      expect(screen.getByText(REVIEW_CONNECTION.jiraBaseUrl)).toBeVisible();
      expect(screen.getByText(REVIEW_CONNECTION.actorUsername)).toBeVisible();
      expect(screen.getByText(REVIEW_CONNECTION.actorUserKey)).toBeVisible();
      expect(screen.getByText("Verified target")).toBeVisible();
      expect(screen.getByText("native-target-key")).toBeVisible();
      expect(
        screen.getByText(
          locale === "de"
            ? "Ein neues Passwort für den unten angezeigten geprüften Zielbenutzer setzen."
            : "Set a new password for the verified target user shown below.",
        ),
      ).toBeVisible();
      expect(screen.queryByRole("link")).toBeNull();
      expect(container.textContent).not.toContain("Model target");
      expect(container.textContent).not.toContain("untrusted.example.invalid");
      expect(await axe(container)).toHaveNoViolations();
    },
  );
  it("requires a fresh trusted review before restoring private controls from older history", async () => {
    const initial = withoutReview(view());
    vi.mocked(inputApi.getJiraHumanInput).mockResolvedValue(initial);
    render(<JiraHumanInput initial={initial} turnState="pending" />);
    await waitFor(() => expect(inputApi.getJiraHumanInput).toHaveBeenCalledOnce());
    expect(screen.queryByLabelText("Password")).toBeNull();
    expect(screen.queryByRole("button", { name: "Provide securely" })).toBeNull();
    expect(inputApi.submitJiraHumanInput).not.toHaveBeenCalled();
    vi.mocked(inputApi.getJiraHumanInput).mockResolvedValue({ ...initial, review: LOGIN_REVIEW });
    await userEvent.setup().click(screen.getByRole("button", { name: "Refresh input state" }));
    await waitFor(() => expect(screen.getByLabelText("Password")).toBeEnabled());
    expect(screen.getByText(REVIEW_CONNECTION.jiraBaseUrl)).toBeVisible();
  });
  it.each(["host", "target", "removed"] as const)(
    "refuses a %s review change without retargeting the private entry",
    async (change) => {
      const initial: JiraHumanInputView = {
        ...view(),
        purpose: "update-user-password",
        review: {
          ...REVIEW_CONNECTION,
          targetKind: "user",
          targetUserKey: "native-target-key",
          targetUsername: "Verified target",
        },
      };
      const changed: JiraHumanInputView =
        change === "removed"
          ? withoutReview(initial)
          : {
              ...initial,
              review: {
                ...REVIEW_CONNECTION,
                targetKind: "user",
                targetUserKey: "native-target-key",
                targetUsername: change === "target" ? "Other target" : "Verified target",
                jiraBaseUrl:
                  change === "host"
                    ? "https://other.example.invalid"
                    : REVIEW_CONNECTION.jiraBaseUrl,
              },
            };
      vi.mocked(inputApi.getJiraHumanInput).mockResolvedValue(changed);
      const { container } = render(<JiraHumanInput initial={initial} turnState="pending" />);
      await screen.findByRole("alert");
      expect(screen.getByLabelText("New password")).toBeDisabled();
      expect(screen.getByRole("button", { name: "Provide securely" })).toBeDisabled();
      expect(screen.getByText("Verified target")).toBeVisible();
      expect(container.textContent).not.toContain("other.example.invalid");
      expect(container.textContent).not.toContain("Other target");
      expect(inputApi.submitJiraHumanInput).not.toHaveBeenCalled();
      expect(reportClientDiagnostic).toHaveBeenCalledExactlyOnceWith(
        "jira-human-input-refresh-failed",
        {
          kind: "other",
          failureStage: "jira human input",
          errorKind: "unavailable",
        },
      );
    },
  );
  it("keeps a historical terminal status readable without reopening an input that lacks review metadata", () => {
    const initial = withoutReview({ ...view(), state: "consumed" });
    render(<JiraHumanInput initial={initial} turnState="completed" />);
    expect(
      screen.getByText(
        "Your input was consumed once. The operation result appears in its result card.",
      ),
    ).toBeVisible();
    expect(screen.queryByLabelText("Password")).toBeNull();
    expect(inputApi.getJiraHumanInput).not.toHaveBeenCalled();
    expect(inputApi.submitJiraHumanInput).not.toHaveBeenCalled();
  });
  it("uses masked entry outside a native credential form and sends only from the explicit keyboard-accessible button", async () => {
    const initial = view();
    vi.mocked(inputApi.getJiraHumanInput).mockResolvedValue(initial);
    vi.mocked(inputApi.submitJiraHumanInput).mockResolvedValue({ ...initial, state: "ready" });
    const { container } = render(<JiraHumanInput initial={initial} turnState="pending" />);
    const password = screen.getByLabelText("Password");
    await waitFor(() => expect(password).toBeEnabled());
    expect(password).toHaveAttribute("type", "password");
    expect(password).toHaveAttribute("autocomplete", "off");
    expect(password).toHaveProperty("form", null);
    expect(container.querySelector("form")).toBeNull();
    expect(screen.getByRole("group", { name: "Requested private fields" })).toBeVisible();
    const send = screen.getByRole("button", { name: "Provide securely" });
    expect(send).toHaveAttribute("type", "button");
    const user = userEvent.setup();
    await user.type(password, "synthetic-private-entry{Enter}");
    expect(inputApi.submitJiraHumanInput).not.toHaveBeenCalled();
    await user.tab();
    expect(send).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(inputApi.submitJiraHumanInput).toHaveBeenCalledExactlyOnceWith(initial.requestId, {
      expectedRevision: initial.revision,
      values: { password: "synthetic-private-entry" },
    });
  });
  it("reports a failed refresh through the closed diagnostic stage without reflecting the response body", async () => {
    const initial = view();
    vi.mocked(inputApi.getJiraHumanInput).mockRejectedValue(
      new TypeError(
        `synthetic-private-entry https://private.example.invalid Private User ${initial.requestId}`,
      ),
    );
    render(<JiraHumanInput initial={initial} turnState="pending" />);
    await screen.findByRole("alert");
    expect(reportClientDiagnostic).toHaveBeenCalledExactlyOnceWith(
      "jira-human-input-refresh-failed",
      {
        kind: "other",
        failureStage: "jira human input",
        errorKind: "unavailable",
      },
    );
    expect(screen.getByRole("button", { name: "Provide securely" })).toBeDisabled();
    const reports = JSON.stringify(vi.mocked(reportClientDiagnostic).mock.calls);
    for (const value of [
      "synthetic-private-entry",
      "private.example.invalid",
      "Private User",
      initial.requestId,
    ])
      expect(reports).not.toContain(value);
  });
  it.each(["submit", "cancel"] as const)(
    "reports a failed %s without the entry, target, request ID or error body",
    async (action) => {
      const initial = view();
      vi.mocked(inputApi.getJiraHumanInput).mockResolvedValue(initial);
      const reflected = new TypeError(
        `synthetic-private-entry private.example.invalid Private User ${initial.requestId}`,
      );
      vi.mocked(inputApi.submitJiraHumanInput).mockRejectedValue(reflected);
      vi.mocked(inputApi.cancelJiraHumanInput).mockRejectedValue(reflected);
      render(<JiraHumanInput initial={initial} turnState="pending" />);
      await waitFor(() => expect(screen.getByLabelText("Password")).toBeEnabled());
      const user = userEvent.setup();
      await user.type(screen.getByLabelText("Password"), "synthetic-private-entry");
      await user.click(
        screen.getByRole("button", {
          name: action === "submit" ? "Provide securely" : "Cancel input",
        }),
      );
      await screen.findByRole("alert");
      expect(reportClientDiagnostic).toHaveBeenCalledExactlyOnceWith(
        `jira-human-input-${action}-failed`,
        {
          kind: "other",
          failureStage: "jira human input",
          errorKind: "unavailable",
        },
      );
      expect(screen.getByLabelText("Password")).toHaveValue("");
      expect(screen.getByRole("button", { name: "Provide securely" })).toBeDisabled();
      const reports = JSON.stringify(vi.mocked(reportClientDiagnostic).mock.calls);
      for (const value of [
        "synthetic-private-entry",
        "private.example.invalid",
        "Private User",
        initial.requestId,
      ])
        expect(reports).not.toContain(value);
    },
  );
  it("does not report a deliberate unmount cancellation as a failed state refresh", async () => {
    vi.mocked(inputApi.getJiraHumanInput).mockImplementation(
      (_requestId, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => {
              reject(new DOMException("Private input read stopped", "AbortError"));
            },
            { once: true },
          );
        }),
    );
    const shown = render(<JiraHumanInput initial={view()} turnState="pending" />);
    await act(async () => {
      shown.unmount();
    });
    expect(reportClientDiagnostic).not.toHaveBeenCalled();
    expect(inputApi.submitJiraHumanInput).not.toHaveBeenCalled();
  });
});

it("keeps a consumed transcript view when an older POST ready response arrives later", async () => {
  const initial = view();
  vi.mocked(inputApi.getJiraHumanInput).mockResolvedValue(initial);
  let finishPost: ((value: JiraHumanInputView) => void) | undefined;
  vi.mocked(inputApi.submitJiraHumanInput).mockImplementation(
    () =>
      new Promise((resolve) => {
        finishPost = resolve;
      }),
  );
  const shown = render(<JiraHumanInput initial={initial} turnState="pending" />);
  await waitFor(() => expect(screen.getByLabelText("Password")).toBeEnabled());
  const user = userEvent.setup();
  await user.type(screen.getByLabelText("Password"), "synthetic-entry");
  await user.click(screen.getByRole("button", { name: "Provide securely" }));
  const consumed = {
    ...initial,
    revision: "87654321-1234-4123-8123-123456789abc",
    state: "consumed" as const,
  };
  vi.mocked(inputApi.getJiraHumanInput).mockResolvedValue(consumed);
  shown.rerender(<JiraHumanInput initial={consumed} turnState="pending" />);
  await screen.findByText(
    "Your input was consumed once. The operation result appears in its result card.",
  );
  await act(async () => {
    finishPost?.({ ...consumed, state: "ready" });
  });
  expect(
    screen.getByText(
      "Your input was consumed once. The operation result appears in its result card.",
    ),
  ).toBeVisible();
  expect(screen.queryByLabelText("Password")).toBeNull();
  expect(inputApi.submitJiraHumanInput).toHaveBeenCalledTimes(1);
});
it("accepts authoritative consumption committed before expiry even when its response arrives afterwards", async () => {
  vi.useFakeTimers();
  try {
    let observe: ((value: JiraHumanInputView) => void) | undefined;
    const ready = { ...view(), state: "ready" as const, expiresAt: Date.now() + 10 };
    vi.mocked(inputApi.getJiraHumanInput).mockImplementation(
      () =>
        new Promise((resolve) => {
          observe = resolve;
        }),
    );
    render(<JiraHumanInput initial={ready} turnState="pending" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(11);
    });
    expect(
      screen.getByText(
        "The input window expired. Refresh the operation result before deciding how to continue.",
      ),
    ).toBeVisible();
    await act(async () => {
      observe?.({ ...ready, state: "consumed" });
    });
    expect(
      screen.getByText(
        "Your input was consumed once. The operation result appears in its result card.",
      ),
    ).toBeVisible();
  } finally {
    vi.useRealTimers();
  }
});
it("requires a human checkbox naming the exact reviewed executing node for unlock", async () => {
  const initial: JiraHumanInputView = {
    ...view(),
    purpose: "unlock-user-anonymization",
    fields: ["ownerShutdownConfirmation"],
    review: {
      ...REVIEW_CONNECTION,
      targetKind: "anonymization-task",
      targetUserKey: "native-target-key",
      executingNode: "reviewed-node-2",
    },
  };
  vi.mocked(inputApi.getJiraHumanInput).mockResolvedValue(initial);
  vi.mocked(inputApi.submitJiraHumanInput).mockResolvedValue({ ...initial, state: "ready" });
  render(
    <JiraHumanInput
      initial={initial}
      turnState="pending"
      {...untrustedModelCall({
        id: "unlock-call",
        name: "jira_unlock_user_anonymization",
        arguments: { expectedTask: { executingNode: "untrusted-model-node" } },
      })}
    />,
  );
  const checkbox = screen.getByRole("checkbox", { name: /reviewed-node-2/u });
  await waitFor(() => expect(checkbox).toBeEnabled());
  expect(screen.getByRole("button", { name: "Provide securely" })).toBeDisabled();
  expect(screen.queryByLabelText("Password")).toBeNull();
  expect(screen.queryByText(/untrusted-model-node/u)).toBeNull();
  const user = userEvent.setup();
  await user.click(checkbox);
  await user.click(screen.getByRole("button", { name: "Provide securely" }));
  expect(inputApi.submitJiraHumanInput).toHaveBeenCalledExactlyOnceWith(initial.requestId, {
    expectedRevision: initial.revision,
    values: { ownerShutdownConfirmation: "confirmed" },
  });
});

it("keeps a new consumed history projection when its expired vault record can no longer be read", async () => {
  const initial = view();
  vi.mocked(inputApi.getJiraHumanInput).mockResolvedValue(initial);
  const shown = render(<JiraHumanInput initial={initial} turnState="pending" />);
  await waitFor(() => expect(screen.getByLabelText("Password")).toBeEnabled());
  vi.mocked(inputApi.getJiraHumanInput).mockRejectedValue(
    new TypeError("Input no longer retained"),
  );
  shown.rerender(
    <JiraHumanInput initial={{ ...initial, state: "consumed" }} turnState="completed" />,
  );
  await screen.findByText(
    "Your input was consumed once. The operation result appears in its result card.",
  );
  expect(screen.queryByLabelText("Password")).toBeNull();
  expect(inputApi.submitJiraHumanInput).not.toHaveBeenCalled();
});

it("distinguishes current and new passwords without changing their private native field binding", async () => {
  const initial: JiraHumanInputView = {
    ...view(),
    purpose: "update-my-password",
    fields: ["currentPassword", "password"],
  };
  vi.mocked(inputApi.getJiraHumanInput).mockResolvedValue(initial);
  render(<JiraHumanInput initial={initial} turnState="pending" />);
  await waitFor(() => expect(screen.getByLabelText("Current password")).toBeEnabled());
  expect(screen.getByLabelText("New password")).toBeEnabled();
  expect(screen.getByLabelText("Current password")).toHaveAttribute("type", "password");
  expect(screen.getByLabelText("New password")).toHaveAttribute("type", "password");
});
