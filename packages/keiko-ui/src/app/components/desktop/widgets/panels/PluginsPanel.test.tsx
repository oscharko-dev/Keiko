import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { PluginsPanel } from "./PluginsPanel";

describe("PluginsPanel", () => {
  it("renders MCP server and connector states and toggles MCP availability", async () => {
    const user = userEvent.setup();
    render(<PluginsPanel />);

    expect(screen.getByText("5/7 active")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Playwright: stopped" })).toHaveAttribute(
      "title",
      "Stopped",
    );
    expect(screen.getByText("PostgreSQL")).toBeInTheDocument();
    expect(screen.getAllByText("Connected")).toHaveLength(3);
    expect(screen.getAllByText("Not connected")).toHaveLength(3);

    await user.click(screen.getByRole("button", { name: "Playwright: stopped" }));

    expect(screen.getByText("6/7 active")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Playwright: running" })).toHaveAttribute(
      "title",
      "Running",
    );

    await user.click(screen.getByRole("button", { name: "Context7: running" }));
    expect(screen.getByText("5/7 active")).toBeInTheDocument();
  });
});
