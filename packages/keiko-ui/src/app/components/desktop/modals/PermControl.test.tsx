import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { PermControl } from "./PermControl";

describe("PermControl", () => {
  it("defaults to Keiko governance and toggles into legacy approval modes", async () => {
    const set = vi.fn();
    const user = userEvent.setup();

    const { rerender } = render(<PermControl cfg={{}} set={set} />);

    // The master control is a switch (on/off), not a toggle button (GEN-UI-A11Y-021).
    expect(screen.getByRole("switch", { name: /keiko-mode/i })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.getByText(/No rights by default. You approve while manual/i)).toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: "Full access" })).toBeNull();

    await user.click(screen.getByRole("switch", { name: /keiko-mode/i }));
    expect(set).toHaveBeenCalledWith("keikoMode", false);

    rerender(<PermControl cfg={{ keikoMode: false, access: "ask" }} set={set} />);
    // The two mutually-exclusive legacy modes are a labelled radio group.
    expect(screen.getByRole("radiogroup", { name: /legacy access mode/i })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Ask every action" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.getByRole("radio", { name: "Full access" })).toHaveAttribute(
      "aria-checked",
      "false",
    );
    expect(screen.getByText("Legacy: you approve each privileged action.")).toBeInTheDocument();

    await user.click(screen.getByRole("radio", { name: "Full access" }));
    expect(set).toHaveBeenCalledWith("access", "full");

    rerender(<PermControl cfg={{ keikoMode: false, access: "full" }} set={set} />);
    expect(screen.getByRole("radio", { name: "Full access" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.getByText("Legacy: agent acts without prompts.")).toBeInTheDocument();
  });
});
