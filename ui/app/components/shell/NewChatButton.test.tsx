// Accessibility tests for NewChatButton (issue #68).
// Covers: axe-clean in both collapsed and expanded layouts, with and without an
// active project (the disabled-no-project state), plus the focus-visible ring.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { NewChatButton } from "./NewChatButton";
import * as api from "@/lib/api";

const mockSearchParams = new URLSearchParams();
const mockReplace = vi.fn();
let mockPathname = "/";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mockReplace }),
  useSearchParams: () => mockSearchParams,
  usePathname: () => mockPathname,
}));

vi.mock("@/lib/api", () => ({
  createChat: vi.fn(),
  ApiError: class ApiError extends Error {
    code: string;
    status: number;
    constructor(code: string, msg: string, status: number) {
      super(msg);
      this.code = code;
      this.status = status;
    }
  },
}));

describe("NewChatButton", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSearchParams.delete("project");
    mockPathname = "/";
  });

  it("is disabled when no project is selected", () => {
    render(<NewChatButton collapsed={false} />);
    expect(screen.getByRole("button")).toBeDisabled();
  });

  it("is enabled when a project is selected", () => {
    mockSearchParams.set("project", "/workspace/foo");
    render(<NewChatButton collapsed={false} />);
    expect(screen.getByRole("button")).not.toBeDisabled();
  });

  it("stays disabled when the parent has not validated an available selected project", () => {
    mockSearchParams.set("project", "/workspace/missing");
    render(<NewChatButton collapsed={false} projectPath={null} />);
    expect(screen.getByRole("button")).toBeDisabled();
    expect(screen.getByRole("button")).toHaveAttribute(
      "title",
      "Select an available local project before starting a new chat.",
    );
  });

  it("has a visible focus ring (expanded layout)", () => {
    mockSearchParams.set("project", "/workspace/foo");
    render(<NewChatButton collapsed={false} />);
    expect(screen.getByRole("button")).toHaveClass("focus-visible:ring-2");
  });

  it("preserves /launch after creating a chat from the /launch route", async () => {
    const user = userEvent.setup();
    mockPathname = "/launch";
    mockSearchParams.set("project", "/workspace/foo");
    vi.mocked(api.createChat).mockResolvedValue({
      chat: {
        id: "chat-123",
        projectPath: "/workspace/foo",
        title: "New chat",
        selectedModel: "Mistral-Small-3.1-24B-Instruct-2503",
        status: "open",
        createdAt: 1000,
        updatedAt: 1000,
      },
    });

    render(<NewChatButton collapsed={false} />);
    await user.click(screen.getByRole("button", { name: /\+ new chat/i }));

    expect(mockReplace).toHaveBeenCalledWith(expect.stringMatching(/^\/launch\?project=/));
    expect(mockReplace).toHaveBeenCalledWith(expect.stringContaining("chat=chat-123"));
  });

  it("collapsed layout exposes an accessible name", () => {
    mockSearchParams.set("project", "/workspace/foo");
    render(<NewChatButton collapsed />);
    expect(screen.getByRole("button", { name: /new chat/i })).toBeInTheDocument();
  });

  it("has no axe violations (expanded, no project)", async () => {
    const { container } = render(<NewChatButton collapsed={false} />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it("has no axe violations (collapsed, project selected)", async () => {
    mockSearchParams.set("project", "/workspace/foo");
    const { container } = render(<NewChatButton collapsed />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
