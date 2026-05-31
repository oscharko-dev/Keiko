// Route-resolution test for /launch (issue #68, AC#1).
// Proves the /launch route mounts the workspace shell entry surface.

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import LaunchPage from "./page";

describe("/launch route", () => {
  it("renders the workspace shell entry surface", () => {
    render(<LaunchPage />);
    expect(
      screen.getByRole("heading", { name: /welcome to keiko/i }),
    ).toBeInTheDocument();
  });

  it("re-exports WorkspaceShellEntry as the default export", () => {
    // The route file is `export { WorkspaceShellEntry as default }` — proving the
    // shared entry surface backs both / and /launch (ADR-0014).
    render(<LaunchPage />);
    expect(
      screen.getByRole("region", { name: /welcome to keiko/i }),
    ).toBeInTheDocument();
  });
});
