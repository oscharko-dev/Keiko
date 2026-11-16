import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { LocationBindingNotices, locationBlockerKey } from "./CodingWorkbenchLocationNotices";
import type { WorkbenchExecutionLocationState } from "./useWorkbenchExecutionLocation";

function state(
  overrides: Partial<WorkbenchExecutionLocationState>,
): WorkbenchExecutionLocationState {
  return {
    ready: false,
    pending: false,
    error: false,
    denied: false,
    retry: vi.fn(),
    ...overrides,
  };
}

const PREPARING = "Preparing the selected checkout…";
const FAILED = "The selected checkout could not be opened. Choose a branch in Git, then try again.";

describe("LocationBindingNotices", () => {
  it("shows nothing for a ready location", () => {
    const { container } = render(<LocationBindingNotices locationState={state({ ready: true })} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("says the checkout is being prepared while it binds", () => {
    render(<LocationBindingNotices locationState={state({ pending: true })} />);
    expect(screen.getByText(PREPARING)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows the error and Retry alone while a reload runs (#4349 Firefox reflow)", () => {
    const retry = vi.fn();
    render(<LocationBindingNotices locationState={state({ pending: true, error: true, retry })} />);
    expect(screen.getByRole("alert")).toHaveTextContent(FAILED);
    expect(screen.queryByText(PREPARING)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("keeps the same notice when the reload ends, so the selector does not move", () => {
    const { container, rerender } = render(
      <LocationBindingNotices locationState={state({ pending: true, error: true })} />,
    );
    const during = container.innerHTML;
    rerender(<LocationBindingNotices locationState={state({ pending: false, error: true })} />);
    expect(container.innerHTML).toBe(during);
  });
});

// #4371: a refused folder is explained once (by the selector's own help, with its way out); the
// notice neither repeats it nor adds the generic sentence that guesses a different cause.
describe("a checkout refused by the server", () => {
  it("adds no second sentence beside the selector's own explanation", () => {
    const { container } = render(
      <LocationBindingNotices locationState={state({ error: true, denied: true })} />,
    );
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByText(/Choose a branch in Git/u)).not.toBeInTheDocument();
  });

  it("names the one cause the start blocker reports", () => {
    expect(locationBlockerKey({ error: true, denied: true })).toBe(
      "codingWorkbench.repository.deniedBlocker",
    );
    expect(locationBlockerKey({ error: true, denied: false })).toBe(
      "codingWorkbench.repository.locationError",
    );
    expect(locationBlockerKey({ error: false, denied: false })).toBe(
      "codingWorkbench.repository.locationBinding",
    );
  });
});
