import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { EditorMenu } from "./EditorMenu";

describe("EditorMenu", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("renders a visible launcher label and explicit accessible name", async () => {
    const user = userEvent.setup();

    render(<EditorMenu project="projSem" />);

    const trigger = screen.getByRole("button", { name: "Open projSem in IntelliJ IDEA" });
    expect(trigger).toBeInTheDocument();
    expect(screen.getByText("Open in IntelliJ IDEA")).toBeInTheDocument();

    await user.click(trigger);
    await user.click(screen.getByRole("menuitemradio", { name: "Finder" }));

    expect(screen.getByRole("button", { name: "Open projSem in Finder" })).toBeInTheDocument();
    expect(screen.getByText("Open in Finder")).toBeInTheDocument();
  });
});
