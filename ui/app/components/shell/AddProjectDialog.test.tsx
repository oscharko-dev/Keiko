import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { AddProjectDialog } from "./AddProjectDialog";
import * as api from "@/lib/api";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("@/lib/api", () => ({
  createProject: vi.fn(),
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

// jsdom does not implement HTMLDialogElement.showModal — provide a minimal mock
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
// Helpers
// ---------------------------------------------------------------------------

function renderDialog(onSuccess = vi.fn(), onClose = vi.fn()) {
  return render(<AddProjectDialog onSuccess={onSuccess} onClose={onClose} />);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AddProjectDialog", () => {
  it("renders the dialog title", () => {
    renderDialog();
    expect(screen.getByRole("heading", { name: /add a local project directory/i })).toBeInTheDocument();
  });

  it("has a path input and name input", () => {
    renderDialog();
    expect(screen.getByLabelText(/directory path/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/display name/i)).toBeInTheDocument();
  });

  it("submit button is labeled Add project", () => {
    renderDialog();
    expect(screen.getByRole("button", { name: /add project/i })).toBeInTheDocument();
  });

  it("cancel button calls onClose", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderDialog(vi.fn(), onClose);
    await user.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("shows error when path is empty on submit", async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByRole("button", { name: /add project/i }));
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
      expect(screen.getByRole("alert")).toHaveTextContent(/path is required/i);
    });
  });

  it("calls createProject with the entered path and name", async () => {
    const user = userEvent.setup();
    const onSuccess = vi.fn();
    vi.mocked(api.createProject).mockResolvedValueOnce({
      project: {
        path: "/home/user/project",
        name: "My Project",
        available: true,
        favorite: false,
        createdAt: 1000,
        lastOpenedAt: 1000,
      },
    });
    renderDialog(onSuccess);
    await user.type(screen.getByLabelText(/directory path/i), "/home/user/project");
    await user.type(screen.getByLabelText(/display name/i), "My Project");
    await user.click(screen.getByRole("button", { name: /add project/i }));
    await waitFor(() => {
      expect(api.createProject).toHaveBeenCalledWith({
        path: "/home/user/project",
        name: "My Project",
      });
    });
    expect(onSuccess).toHaveBeenCalledOnce();
  });

  it("omits name when display name is empty", async () => {
    const user = userEvent.setup();
    vi.mocked(api.createProject).mockResolvedValueOnce({
      project: {
        path: "/home/user/project",
        name: "/home/user/project",
        available: true,
        favorite: false,
        createdAt: 1000,
        lastOpenedAt: 1000,
      },
    });
    renderDialog();
    await user.type(screen.getByLabelText(/directory path/i), "/home/user/project");
    await user.click(screen.getByRole("button", { name: /add project/i }));
    await waitFor(() => {
      expect(api.createProject).toHaveBeenCalledWith({ path: "/home/user/project" });
    });
  });

  // Error code mapping tests (D3)
  const errorCodes: Array<[string, string]> = [
    ["invalid_path", "not a valid absolute local directory"],
    ["path_not_directory", "not a directory"],
    ["path_not_found", "No directory exists"],
    ["project_exists", "already in your sidebar"],
    ["invalid_request", "Could not validate"],
    ["payload_too_large", "too long"],
  ];

  for (const [code, expectedText] of errorCodes) {
    it(`maps error code ${code} to human message`, async () => {
      const user = userEvent.setup();
      const ApiErrorClass = (await import("@/lib/api")).ApiError;
      vi.mocked(api.createProject).mockRejectedValueOnce(
        new ApiErrorClass(code, "Server message", 400),
      );
      renderDialog();
      await user.type(screen.getByLabelText(/directory path/i), "/some/path");
      await user.click(screen.getByRole("button", { name: /add project/i }));
      await waitFor(() => {
        expect(screen.getByRole("alert")).toHaveTextContent(new RegExp(expectedText, "i"));
      });
    });
  }

  it("shows fallback message for unknown error codes", async () => {
    const user = userEvent.setup();
    const ApiErrorClass = (await import("@/lib/api")).ApiError;
    vi.mocked(api.createProject).mockRejectedValueOnce(
      new ApiErrorClass("unknown_code", "Custom server message", 500),
    );
    renderDialog();
    await user.type(screen.getByLabelText(/directory path/i), "/some/path");
    await user.click(screen.getByRole("button", { name: /add project/i }));
    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("Custom server message");
    });
  });

  it("disables inputs while submitting", async () => {
    const user = userEvent.setup();
    let resolveCreate!: () => void;
    vi.mocked(api.createProject).mockReturnValueOnce(
      new Promise((res) => {
        resolveCreate = () => res({
          project: {
            path: "/p",
            name: "p",
            available: true,
            favorite: false,
            createdAt: 1,
            lastOpenedAt: 1,
          },
        });
      }),
    );
    renderDialog();
    await user.type(screen.getByLabelText(/directory path/i), "/some/path");
    await user.click(screen.getByRole("button", { name: /add project/i }));
    // While pending
    expect(screen.getByLabelText(/directory path/i)).toBeDisabled();
    expect(screen.getByRole("button", { name: /adding/i })).toBeDisabled();
    resolveCreate();
  });

  it("has no axe-detectable accessibility violations", async () => {
    const { container } = renderDialog();
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
