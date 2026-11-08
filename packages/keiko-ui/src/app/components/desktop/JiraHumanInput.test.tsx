import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JiraHumanInputView } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import * as inputApi from "@/lib/jira-human-input-api";
import { I18N_STORAGE_KEY, I18nProvider, loadLocaleMessages } from "@/lib/i18n";
import { loadOptionalWidgetMessages } from "@/lib/optional-widget-i18n";
import { JiraHumanInput } from "./JiraHumanInput";
vi.mock("@/lib/jira-human-input-api", () => ({ getJiraHumanInput: vi.fn(), submitJiraHumanInput: vi.fn(), cancelJiraHumanInput: vi.fn() }));
function view(): JiraHumanInputView {
  return { requestId: `jhi_${"a".repeat(64)}`, revision: "12345678-1234-4123-8123-123456789abc", purpose: "login",
    state: "awaiting-input", expiresAt: Date.now() + 60000, fields: ["password"], optionalFields: [] };
}
beforeEach(() => { vi.clearAllMocks(); localStorage.removeItem(I18N_STORAGE_KEY); });
afterEach(() => { localStorage.removeItem(I18N_STORAGE_KEY); });
describe("Jira human-only input", () => {
  it("clears the typed value before the one submission settles and never stores it as a draft", async () => {
    const initial = view(); vi.mocked(inputApi.getJiraHumanInput).mockResolvedValue(initial);
    let complete: ((value: JiraHumanInputView) => void) | undefined;
    vi.mocked(inputApi.submitJiraHumanInput).mockImplementation(() => new Promise((resolve) => { complete = resolve; }));
    const { container } = render(<JiraHumanInput initial={initial} turnState="pending" />);
    const user = userEvent.setup();
    await waitFor(() => expect(screen.getByLabelText("Password")).toBeEnabled());
    await user.type(screen.getByLabelText("Password"), "synthetic-private-entry");
    await user.click(screen.getByRole("button", { name: "Provide securely" }));
    expect(screen.getByLabelText("Password")).toHaveValue("");
    expect(inputApi.submitJiraHumanInput).toHaveBeenCalledExactlyOnceWith(initial.requestId,
      { expectedRevision: initial.revision, values: { password: "synthetic-private-entry" } });
    expect(JSON.stringify(localStorage)).not.toContain("synthetic-private-entry");
    expect(container.textContent).not.toContain("synthetic-private-entry");
    await act(async () => { complete?.({ ...initial, revision: "87654321-1234-4123-8123-123456789abc", state: "ready" }); });
    expect(screen.queryByLabelText("Password")).toBeNull();
  });
  it("reconciles an uncertain submission with a state-only read and never repeats it after reload", async () => {
    const initial = view(); vi.mocked(inputApi.getJiraHumanInput).mockResolvedValue(initial);
    vi.mocked(inputApi.submitJiraHumanInput).mockRejectedValue(new TypeError("synthetic transport failure"));
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
    await screen.findByText("Your input was consumed once. The operation result appears in its result card.");
    expect(screen.queryByLabelText("Password")).toBeNull();
    expect(inputApi.submitJiraHumanInput).toHaveBeenCalledTimes(1);
  });
  it.each(["en", "de"] as const)("keeps the protected form accessible in %s", async (locale) => {
    await loadLocaleMessages(locale); await loadOptionalWidgetMessages(locale);
    localStorage.setItem(I18N_STORAGE_KEY, locale);
    const initial = view(); vi.mocked(inputApi.getJiraHumanInput).mockResolvedValue(initial);
    const { container } = render(<I18nProvider><JiraHumanInput initial={initial} turnState="pending" /></I18nProvider>);
    await waitFor(() => expect(screen.getByLabelText(locale === "de" ? "Passwort" : "Password")).toBeEnabled());
    expect(await axe(container)).toHaveNoViolations();
    expect(container.textContent).not.toContain('"requestId"');
  });
});

it("keeps a consumed transcript view when an older POST ready response arrives later", async () => {
  const initial = view(); vi.mocked(inputApi.getJiraHumanInput).mockResolvedValue(initial);
  let finishPost: ((value: JiraHumanInputView) => void) | undefined;
  vi.mocked(inputApi.submitJiraHumanInput).mockImplementation(() => new Promise((resolve) => { finishPost = resolve; }));
  const shown = render(<JiraHumanInput initial={initial} turnState="pending" />);
  await waitFor(() => expect(screen.getByLabelText("Password")).toBeEnabled());
  const user = userEvent.setup();
  await user.type(screen.getByLabelText("Password"), "synthetic-entry");
  await user.click(screen.getByRole("button", { name: "Provide securely" }));
  const consumed = { ...initial, revision: "87654321-1234-4123-8123-123456789abc", state: "consumed" as const };
  vi.mocked(inputApi.getJiraHumanInput).mockResolvedValue(consumed);
  shown.rerender(<JiraHumanInput initial={consumed} turnState="pending" />);
  await screen.findByText("Your input was consumed once. The operation result appears in its result card.");
  await act(async () => { finishPost?.({ ...consumed, state: "ready" }); });
  expect(screen.getByText("Your input was consumed once. The operation result appears in its result card.")).toBeVisible();
  expect(screen.queryByLabelText("Password")).toBeNull();
  expect(inputApi.submitJiraHumanInput).toHaveBeenCalledTimes(1);
});
it("accepts authoritative consumption committed before expiry even when its response arrives afterwards", async () => {
  vi.useFakeTimers();
  try {
    let observe: ((value: JiraHumanInputView) => void) | undefined;
    const ready = { ...view(), state: "ready" as const, expiresAt: Date.now() + 10 };
    vi.mocked(inputApi.getJiraHumanInput).mockImplementation(() => new Promise((resolve) => { observe = resolve; }));
    render(<JiraHumanInput initial={ready} turnState="pending" />);
    await act(async () => { await vi.advanceTimersByTimeAsync(11); });
    expect(screen.getByText("The input window expired. Refresh the operation result before deciding how to continue.")).toBeVisible();
    await act(async () => { observe?.({ ...ready, state: "consumed" }); });
    expect(screen.getByText("Your input was consumed once. The operation result appears in its result card.")).toBeVisible();
  } finally { vi.useRealTimers(); }
});
it("requires a human checkbox naming the exact reviewed executing node for unlock", async () => {
  const initial: JiraHumanInputView = { ...view(), purpose: "unlock-user-anonymization", fields: ["ownerShutdownConfirmation"] };
  vi.mocked(inputApi.getJiraHumanInput).mockResolvedValue(initial);
  vi.mocked(inputApi.submitJiraHumanInput).mockResolvedValue({ ...initial, state: "ready" });
  render(<JiraHumanInput initial={initial} turnState="pending"
    call={{ id: "unlock-call", name: "jira_unlock_user_anonymization", arguments: { expectedTask: { executingNode: "reviewed-node-2" } } }} />);
  const checkbox = screen.getByRole("checkbox", { name: /reviewed-node-2/u });
  await waitFor(() => expect(checkbox).toBeEnabled());
  expect(screen.getByRole("button", { name: "Provide securely" })).toBeDisabled();
  expect(screen.queryByLabelText("Password")).toBeNull();
  const user = userEvent.setup(); await user.click(checkbox);
  await user.click(screen.getByRole("button", { name: "Provide securely" }));
  expect(inputApi.submitJiraHumanInput).toHaveBeenCalledExactlyOnceWith(initial.requestId,
    { expectedRevision: initial.revision, values: { ownerShutdownConfirmation: "confirmed" } });
});

it("keeps a new consumed history projection when its expired vault record can no longer be read", async () => {
  const initial = view(); vi.mocked(inputApi.getJiraHumanInput).mockResolvedValue(initial);
  const shown = render(<JiraHumanInput initial={initial} turnState="pending" />);
  await waitFor(() => expect(screen.getByLabelText("Password")).toBeEnabled());
  vi.mocked(inputApi.getJiraHumanInput).mockRejectedValue(new TypeError("Input no longer retained"));
  shown.rerender(<JiraHumanInput initial={{ ...initial, state: "consumed" }} turnState="completed" />);
  await screen.findByText("Your input was consumed once. The operation result appears in its result card.");
  expect(screen.queryByLabelText("Password")).toBeNull();
  expect(inputApi.submitJiraHumanInput).not.toHaveBeenCalled();
});

it("distinguishes current and new passwords without changing their private native field binding", async () => {
  const initial: JiraHumanInputView = { ...view(), purpose: "update-my-password", fields: ["currentPassword", "password"] };
  vi.mocked(inputApi.getJiraHumanInput).mockResolvedValue(initial);
  render(<JiraHumanInput initial={initial} turnState="pending" />);
  await waitFor(() => expect(screen.getByLabelText("Current password")).toBeEnabled());
  expect(screen.getByLabelText("New password")).toBeEnabled();
  expect(screen.getByLabelText("Current password")).toHaveAttribute("type", "password");
  expect(screen.getByLabelText("New password")).toHaveAttribute("type", "password");
});
