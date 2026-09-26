// KEIKO-0158 — MCP Servers is an honest placeholder: no process runs behind any row, so the
// availability dot must not impersonate a live switch. Connectors already sets the pattern
// this section now follows (see the "does not expose ... interactive" test below).

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PluginsPanel } from "./PluginsPanel";

describe("PluginsPanel", () => {
  it("renders MCP server rows as honest, non-interactive placeholders", () => {
    render(<PluginsPanel />);

    // The section header no longer counts fake "active" servers; it announces the placeholder
    // state explicitly (Codex review, PR #3089).
    expect(screen.getByText("Preview — no server wired")).toBeInTheDocument();
    expect(screen.getByText("Context7")).toBeInTheDocument();
    expect(screen.getByText("Up-to-date library docs")).toBeInTheDocument();
    expect(screen.getByText("Playwright")).toBeInTheDocument();

    // GEN-UI-INTERACTION-003 (KEIKO-0158): nothing here controls a real running process, so
    // the availability dot may no longer expose switch or button semantics.
    expect(screen.queryAllByRole("switch")).toHaveLength(0);
    expect(screen.queryAllByRole("button")).toHaveLength(0);

    // Every row surfaces "Preview" as its status; the old Running/Stopped copy would have
    // read as a live process state.
    expect(screen.getAllByText("Preview")).toHaveLength(7);
    expect(screen.queryByText("Running")).toBeNull();
    expect(screen.queryByText("Stopped")).toBeNull();
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
    expect(screen.getAllByText("Connected")).toHaveLength(3);
    expect(screen.getAllByText("Not connected")).toHaveLength(3);
  });

  it("exposes no interactive controls anywhere in the panel", () => {
    render(<PluginsPanel />);

    expect(screen.queryAllByRole("switch")).toHaveLength(0);
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });
});
