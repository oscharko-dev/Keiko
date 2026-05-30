import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { ProjectRow } from "./ProjectRow";
import * as api from "@/lib/api";
import type { ProjectWithAvailability } from "@/lib/types";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("@/lib/api", () => ({
  updateProject: vi.fn(),
  deleteProject: vi.fn(),
  ApiError: class ApiError extends Error {
    code: string;
    status: number;
    constructor(code: string, msg: string, status: number) {
      super(msg);
      this.name = "ApiError";
      this.code = code;
      this.status = status;
    }
  },
}));

beforeEach(() => {
  if (!HTMLDialogElement.prototype.showModal) {
    HTMLDialogElement.prototype.showModal = function () {
      this.setAttribute("open", "");
    };
  }
  if (!HTMLDialogElement.prototype.close) {
    HTMLDialogElement.prototype.close = function () {
      this.removeAttribute("open");
    };
  }
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const baseProject: ProjectWithAvailability = {
  path: "/workspace/foo",
  name: "Foo Project",
  available: true,
  favorite: false,
  createdAt: 1000,
  lastOpenedAt: 2000,
};

function renderRow(
  overrides: Partial<ProjectWithAvailability> = {},
  props: {
    collapsed?: boolean;
    selected?: boolean;
    onSelect?: (path: string) => void;
    onFavoriteToggled?: () => void;
    onRemoved?: (path: string) => void;
  } = {},
) {
  const project = { ...baseProject, ...overrides };
  return render(
    <ProjectRow
      project={project}
      collapsed={props.collapsed ?? false}
      selected={props.selected ?? false}
      onSelect={props.onSelect ?? vi.fn()}
      onFavoriteToggled={props.onFavoriteToggled ?? vi.fn()}
      onRemoved={props.onRemoved ?? vi.fn()}
    />,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ProjectRow", () => {
  it("renders project name", () => {
    renderRow();
    expect(screen.getByText("Foo Project")).toBeInTheDocument();
  });

  it("renders unavailable indicator when project is unavailable", () => {
    renderRow({ available: false });
    expect(screen.getByLabelText(/project path unavailable/i)).toBeInTheDocument();
  });

  it("calls onSelect with project path when row clicked", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    renderRow({}, { onSelect });
    // The main project button contains the project name
    await user.click(screen.getByText("Foo Project"));
    expect(onSelect).toHaveBeenCalledWith("/workspace/foo");
  });

  it("selected row has aria-current=true", () => {
    renderRow({}, { selected: true });
    // Find the button with aria-current — it's the row button
    const current = document.querySelector('[aria-current="true"]');
    expect(current).not.toBeNull();
  });

  it("non-selected row does not have aria-current", () => {
    renderRow({}, { selected: false });
    const current = document.querySelector('[aria-current="true"]');
    expect(current).toBeNull();
  });

  it("star button label says Toggle favorite when not favorited", () => {
    renderRow({ favorite: false });
    expect(
      screen.getByRole("button", { name: /toggle favorite for foo project/i }),
    ).toBeInTheDocument();
  });

  it("star button label says Untoggle favorite when favorited", () => {
    renderRow({ favorite: true });
    expect(
      screen.getByRole("button", { name: /untoggle favorite for foo project/i }),
    ).toBeInTheDocument();
  });

  it("clicking star calls updateProject and onFavoriteToggled", async () => {
    const user = userEvent.setup();
    const onFavoriteToggled = vi.fn();
    vi.mocked(api.updateProject).mockResolvedValueOnce({
      project: { ...baseProject, favorite: true },
    });
    renderRow({ favorite: false }, { onFavoriteToggled });
    await user.click(screen.getByRole("button", { name: /toggle favorite/i }));
    await waitFor(() => {
      expect(api.updateProject).toHaveBeenCalledWith("/workspace/foo", { favorite: true });
      expect(onFavoriteToggled).toHaveBeenCalledOnce();
    });
  });

  it("remove button opens confirm dialog", async () => {
    const user = userEvent.setup();
    renderRow();
    await user.click(screen.getByRole("button", { name: /remove foo project from sidebar/i }));
    expect(screen.getByRole("heading", { name: /remove foo project/i })).toBeInTheDocument();
  });

  it("confirming remove calls deleteProject and onRemoved", async () => {
    const user = userEvent.setup();
    const onRemoved = vi.fn();
    vi.mocked(api.deleteProject).mockResolvedValueOnce(undefined);
    renderRow({}, { onRemoved });
    await user.click(screen.getByRole("button", { name: /remove foo project/i }));
    // Click the confirm button in the dialog
    await user.click(screen.getByRole("button", { name: /^remove$/i }));
    await waitFor(() => {
      expect(api.deleteProject).toHaveBeenCalledWith("/workspace/foo");
      expect(onRemoved).toHaveBeenCalledWith("/workspace/foo");
    });
  });

  it("cancelling remove does not call deleteProject", async () => {
    const user = userEvent.setup();
    renderRow();
    await user.click(screen.getByRole("button", { name: /remove foo project/i }));
    await user.click(screen.getByRole("button", { name: /cancel/i }));
    expect(api.deleteProject).not.toHaveBeenCalled();
  });

  it("delete failure surfaces an inline error without crashing the dialog", async () => {
    const user = userEvent.setup();
    const onRemoved = vi.fn();
    const ApiErrorClass = (await import("@/lib/api")).ApiError;
    vi.mocked(api.deleteProject).mockRejectedValueOnce(
      new ApiErrorClass("internal", "Persistence layer unavailable", 500),
    );
    renderRow({}, { onRemoved });
    await user.click(screen.getByRole("button", { name: /remove foo project/i }));
    await user.click(screen.getByRole("button", { name: /^remove$/i }));
    await waitFor(() => {
      expect(api.deleteProject).toHaveBeenCalledWith("/workspace/foo");
    });
    // The dialog stays open with an inline alert; onRemoved is not invoked.
    expect(onRemoved).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(/persistence layer unavailable/i);
    expect(screen.getByRole("heading", { name: /remove foo project/i })).toBeInTheDocument();
  });

  it("delete failure with a non-ApiError shows a generic safe message", async () => {
    const user = userEvent.setup();
    vi.mocked(api.deleteProject).mockRejectedValueOnce(new Error("network exploded"));
    renderRow();
    await user.click(screen.getByRole("button", { name: /remove foo project/i }));
    await user.click(screen.getByRole("button", { name: /^remove$/i }));
    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(/could not remove the project/i);
    });
  });

  it("collapsed mode shows only first letter of name", () => {
    renderRow({}, { collapsed: true });
    // Collapsed shows single char, not full name
    expect(screen.queryByText("Foo Project")).toBeNull();
    expect(screen.getByRole("button", { name: "Foo Project" })).toBeInTheDocument();
  });

  it("has no axe-detectable accessibility violations", async () => {
    const { container } = renderRow();
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
