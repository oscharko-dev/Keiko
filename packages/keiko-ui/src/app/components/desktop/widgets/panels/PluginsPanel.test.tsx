import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { PluginsPanel } from "./PluginsPanel";

describe("PluginsPanel", () => {
  it("renders MCP server and connector states and toggles MCP availability", async () => {
    const user = userEvent.setup();
    render(<PluginsPanel />);

    expect(screen.getByText("5/7 active")).toBeInTheDocument();
    // GEN-UI-A11Y-009: the availability dot is an on/off switch, so it is exposed
    // as role="switch" (no longer a bare button).
    expect(screen.getByRole("switch", { name: "Playwright: stopped" })).toHaveAttribute(
      "title",
      "Stopped",
    );
    expect(screen.getByText("PostgreSQL")).toBeInTheDocument();
    expect(screen.getAllByText("Connected")).toHaveLength(3);
    expect(screen.getAllByText("Not connected")).toHaveLength(3);

    await user.click(screen.getByRole("switch", { name: "Playwright: stopped" }));

    expect(screen.getByText("6/7 active")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Playwright: running" })).toHaveAttribute(
      "title",
      "Running",
    );

    await user.click(screen.getByRole("switch", { name: "Context7: running" }));
    expect(screen.getByText("5/7 active")).toBeInTheDocument();
  });

  // GEN-UI-A11Y-009 / test-plan #39: the MCP availability dot advertises switch
  // semantics and its aria-checked mirrors the on/off state, flipping on toggle.
  it("exposes each MCP availability control as a switch with aria-checked reflecting state", async () => {
    const user = userEvent.setup();
    render(<PluginsPanel />);

    const playwright = screen.getByRole("switch", { name: "Playwright: stopped" });
    expect(playwright).toHaveAttribute("aria-checked", "false");

    const context7 = screen.getByRole("switch", { name: "Context7: running" });
    expect(context7).toHaveAttribute("aria-checked", "true");

    await user.click(playwright);
    expect(screen.getByRole("switch", { name: "Playwright: running" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.getByText("6/7 active")).toBeInTheDocument();
  });

  // GEN-UI-INTERACTION-001 / test-plan #38: connectors are unwired placeholders, so
  // they must NOT be focusable buttons that mislead — no button exposes a connector.
  it("does not expose placeholder connectors as interactive buttons", () => {
    render(<PluginsPanel />);

    expect(screen.queryByRole("button", { name: /PostgreSQL/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Sentry/ })).not.toBeInTheDocument();
    // The connectors carry only status copy, not a role/name that advertises action.
    expect(screen.getByText("PostgreSQL")).toBeInTheDocument();
    expect(screen.getByText("Sentry")).toBeInTheDocument();
  });
});
