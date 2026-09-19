import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CodingTaskSessionBar } from "./CodingTaskSessionBar";
import { CodingWorkbenchProgress } from "./CodingWorkbenchProgress";
import type { CodingTaskSession } from "./useCodingTaskSession";

function session(): CodingTaskSession {
  return {
    detail: null,
    conversationId: undefined,
    visibleRun: false,
    pending: false,
    error: false,
    newTask: vi.fn(async () => undefined),
    finish: vi.fn(async () => undefined),
  };
}

describe("quiet coding task chrome", () => {
  it("leaves the empty composer free of redundant task actions and idle banners", () => {
    const { container } = render(
      <>
        <CodingTaskSessionBar session={session()} active={false} onHistory={vi.fn()} />
        <CodingWorkbenchProgress state={undefined} review={false} questions={0} starting={false} />
      </>,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("keeps loading and failure feedback visible without a selected task", () => {
    render(
      <CodingTaskSessionBar
        session={{ ...session(), error: true, pending: true }}
        active={false}
        onHistory={vi.fn()}
      />,
    );
    expect(screen.getByRole("alert")).toBeVisible();
    expect(screen.getByText("Loading task…")).toBeVisible();
  });

  it("keeps real work and pending operator decisions visible", () => {
    const { rerender } = render(
      <CodingWorkbenchProgress state="running" review={false} questions={0} starting={false} />,
    );
    expect(screen.getByText("Working")).toBeVisible();
    rerender(
      <CodingWorkbenchProgress
        state="awaiting-approval"
        review={false}
        questions={0}
        starting={false}
      />,
    );
    expect(screen.getByRole("button", { name: "Review now" })).toBeVisible();
  });
});
