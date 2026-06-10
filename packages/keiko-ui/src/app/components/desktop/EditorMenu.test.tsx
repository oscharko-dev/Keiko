import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { EditorMenu } from "./EditorMenu";

describe("EditorMenu", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("renders an honest preference label and explicit accessible name", async () => {
    const user = userEvent.setup();

    render(<EditorMenu project="projSem" />);

    const trigger = screen.getByRole("button", {
      name: "Preferred editor for projSem: IntelliJ IDEA",
    });
    expect(trigger).toBeInTheDocument();
    expect(screen.getByText("Editor: IntelliJ IDEA")).toBeInTheDocument();

    await user.click(trigger);
    await user.click(screen.getByRole("menuitemradio", { name: "Finder" }));

    expect(
      screen.getByRole("button", { name: "Preferred editor for projSem: Finder" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Editor: Finder")).toBeInTheDocument();
    // Regression (uiux-fix F011 C080): no copy may promise an "Open …" action —
    // choosing an editor only stores a preference, it never launches anything.
    expect(screen.queryByText(/^Open\b/)).not.toBeInTheDocument();
  });

  it("focuses the selected item on open, supports arrow navigation and Escape (C168)", async () => {
    const user = userEvent.setup();

    render(<EditorMenu project="projSem" />);

    const trigger = screen.getByRole("button", { name: /Preferred editor for projSem/ });
    await user.click(trigger);

    // The selected item receives focus when the menu opens.
    expect(screen.getByRole("menuitemradio", { name: "IntelliJ IDEA" })).toHaveFocus();

    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitemradio", { name: "GoLand" })).toHaveFocus();

    await user.keyboard("{ArrowUp}{ArrowUp}");
    expect(screen.getByRole("menuitemradio", { name: "VS Code" })).toHaveFocus();

    await user.keyboard("{End}");
    expect(screen.getByRole("menuitemradio", { name: "WebStorm" })).toHaveFocus();
    await user.keyboard("{Home}");
    expect(screen.getByRole("menuitemradio", { name: "Finder" })).toHaveFocus();

    // Escape closes without selection and restores focus to the trigger.
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("returns focus to the trigger after choosing an editor (C168)", async () => {
    const user = userEvent.setup();

    render(<EditorMenu project="projSem" />);

    await user.click(screen.getByRole("button", { name: /Preferred editor for projSem/ }));
    await user.click(screen.getByRole("menuitemradio", { name: "Finder" }));

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Preferred editor for projSem: Finder" }),
    ).toHaveFocus();
  });
});
