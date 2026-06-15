import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { PermControl } from "./PermControl";

describe("PermControl", () => {
  it("defaults to Keiko governance and toggles into legacy approval modes", async () => {
    const set = vi.fn();
    const user = userEvent.setup();

    const { rerender } = render(<PermControl cfg={{}} set={set} />);

    expect(screen.getByRole("button", { name: /keiko-mode/i })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByText(/No rights by default. You approve while manual/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Full access" })).toBeNull();

    await user.click(screen.getByRole("button", { name: /keiko-mode/i }));
    expect(set).toHaveBeenCalledWith("keikoMode", false);

    rerender(<PermControl cfg={{ keikoMode: false, access: "ask" }} set={set} />);
    expect(screen.getByRole("button", { name: "Ask every action" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByText("Legacy: you approve each privileged action.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Full access" }));
    expect(set).toHaveBeenCalledWith("access", "full");

    rerender(<PermControl cfg={{ keikoMode: false, access: "full" }} set={set} />);
    expect(screen.getByRole("button", { name: "Full access" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByText("Legacy: agent acts without prompts.")).toBeInTheDocument();
  });
});
