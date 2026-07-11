// Issue #2245 — scope selection: valid keys become removable chips, invalid/duplicate keys are
// rejected inline, Jira exposes the JQL field with the honest own-permissions hint, and the item
// bound is surfaced. Every emitted scope value flows through onChange.

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { describe, expect, it, vi } from "vitest";
import { ConnectorScopeForm, type ConnectorScopeValue } from "./ConnectorScopeForm";

async function addKey(
  user: ReturnType<typeof userEvent.setup>,
  label: string,
  key: string,
): Promise<void> {
  await user.type(screen.getByLabelText(label), key);
  await user.click(screen.getByRole("button", { name: "Add key" }));
}

describe("ConnectorScopeForm — Confluence", () => {
  it("adds a valid space key as a removable chip and emits the scope", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn<(value: ConnectorScopeValue) => void>();
    render(<ConnectorScopeForm provider="confluence" onChange={onChange} />);
    await addKey(user, "Confluence space keys", "ENG");
    const chips = screen.getByTestId("acx-scope-keys");
    expect(within(chips).getByText("ENG")).toBeInTheDocument();
    expect(onChange).toHaveBeenLastCalledWith({ keys: ["ENG"], jql: "" });

    await user.click(screen.getByRole("button", { name: "Remove key ENG" }));
    expect(screen.queryByTestId("acx-scope-keys")).toBeNull();
    expect(onChange).toHaveBeenLastCalledWith({ keys: [], jql: "" });
  });

  it("rejects an invalid key and a duplicate with inline errors", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<ConnectorScopeForm provider="confluence" onChange={onChange} />);
    await addKey(user, "Confluence space keys", "bad key!");
    expect(screen.getByRole("alert")).toHaveTextContent(/not valid for this provider/i);

    await user.clear(screen.getByLabelText("Confluence space keys"));
    await addKey(user, "Confluence space keys", "ENG");
    await addKey(user, "Confluence space keys", "ENG");
    expect(screen.getByRole("alert")).toHaveTextContent(/already added/i);
  });

  it("does not render the JQL field for Confluence", () => {
    render(<ConnectorScopeForm provider="confluence" onChange={vi.fn()} />);
    expect(screen.queryByLabelText(/JQL filter/i)).toBeNull();
  });
});

describe("ConnectorScopeForm — Jira", () => {
  it("adds a project key, exposes the JQL field with the own-permissions hint, and emits jql", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn<(value: ConnectorScopeValue) => void>();
    render(<ConnectorScopeForm provider="jira" onChange={onChange} />);
    await addKey(user, "Jira project keys", "PROJ");
    expect(onChange).toHaveBeenLastCalledWith({ keys: ["PROJ"], jql: "" });

    const jql = screen.getByLabelText("JQL filter (optional)");
    expect(screen.getByText(/runs under your own Atlassian permissions/i)).toBeInTheDocument();
    await user.type(jql, "updated >= -30d");
    expect(onChange).toHaveBeenLastCalledWith({ keys: ["PROJ"], jql: "updated >= -30d" });
  });

  it("surfaces the per-run item bound and has no axe violations (light and dark)", async () => {
    for (const theme of ["light", "dark"] as const) {
      document.documentElement.setAttribute("data-theme", theme);
      const { container, unmount } = render(
        <ConnectorScopeForm provider="jira" onChange={vi.fn()} />,
      );
      expect(screen.getByText(/at most 2000 items/i)).toBeInTheDocument();
      expect(await axe(container)).toHaveNoViolations();
      unmount();
    }
    document.documentElement.removeAttribute("data-theme");
  });
});
