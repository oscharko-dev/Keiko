// Expected component/interaction-test patch shape for the `interaction` style: render the component
// with @testing-library/react, query through the accessibility tree (getByRole), drive a real
// interaction with @testing-library/user-event, and assert the resulting user-visible output. No
// assertion of internal state.
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { Counter } from "../src/Counter.js";

describe("Counter", () => {
  it("renders the label and initial count", () => {
    render(<Counter label="Clicks" initial={2} />);
    expect(screen.getByRole("button", { name: "Clicks: 2" })).toBeInTheDocument();
  });

  it("increments the count when clicked", async () => {
    const user = userEvent.setup();
    render(<Counter label="Clicks" />);
    await user.click(screen.getByRole("button"));
    expect(screen.getByRole("button", { name: "Clicks: 1" })).toBeInTheDocument();
  });
});
