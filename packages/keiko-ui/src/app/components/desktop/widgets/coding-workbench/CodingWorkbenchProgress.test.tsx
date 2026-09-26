import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { CodingWorkbenchProgress } from "./CodingWorkbenchProgress";
import { PanelTitle } from "./CodingWorkbenchPanelTitle";

// #3637: `focusDecision` (CodingWorkbenchProgress.tsx) scrolls the target heading into view and
// calls `.focus()` on it by a fixed id, but an ordinary `<h3>` is never focusable. Reproduces each
// decision card's actual heading (`PanelTitle`) beside the progress bar, exactly as
// `CodingWorkbenchWindow` mounts them, instead of a hand-rolled heading — the bug is specifically
// in the contract between the two, so both must be exercised together.
function renderScene(props: {
  readonly state: "awaiting-approval" | "running";
  readonly review: boolean;
  readonly questions: number;
  readonly headingId: string;
  readonly headingText: string;
}): void {
  render(
    <>
      <CodingWorkbenchProgress
        state={props.state}
        review={props.review}
        questions={props.questions}
        starting={false}
      />
      <PanelTitle eyebrow="Eyebrow" id={props.headingId} focusable>
        {props.headingText}
      </PanelTitle>
    </>,
  );
}

describe("CodingWorkbenchProgress decision focus (#3637)", () => {
  it("moves focus to the pending-approval heading when Review is activated", async () => {
    const user = userEvent.setup();
    renderScene({
      state: "awaiting-approval",
      review: false,
      questions: 0,
      headingId: "permission-title",
      headingText: "Confirm this action",
    });

    await user.click(screen.getByRole("button", { name: "Review now" }));

    expect(screen.getByRole("heading", { name: "Confirm this action" })).toHaveFocus();
  });

  it("moves focus to the changeset-review heading when Review is activated", async () => {
    const user = userEvent.setup();
    renderScene({
      state: "running",
      review: true,
      questions: 0,
      headingId: "changeset-review-title",
      headingText: "Review the proposed file change",
    });

    await user.click(screen.getByRole("button", { name: "Review now" }));

    expect(screen.getByRole("heading", { name: "Review the proposed file change" })).toHaveFocus();
  });

  it("moves focus to the question heading when Answer is activated", async () => {
    const user = userEvent.setup();
    renderScene({
      state: "running",
      review: false,
      questions: 1,
      headingId: "coding-workbench-questions-title",
      headingText: "Question from the run",
    });

    await user.click(screen.getByRole("button", { name: "Answer question" }));

    expect(screen.getByRole("heading", { name: "Question from the run" })).toHaveFocus();
  });
});
