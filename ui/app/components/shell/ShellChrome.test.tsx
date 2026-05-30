import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { ShellChrome } from "./ShellChrome";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
    [key: string]: unknown;
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

vi.mock("@/lib/api", () => ({
  fetchProjects: vi.fn().mockResolvedValue({ projects: [] }),
  fetchChats: vi.fn().mockResolvedValue({ chats: [] }),
  createProject: vi.fn(),
  updateProject: vi.fn(),
  deleteProject: vi.fn(),
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

// ---------------------------------------------------------------------------
// localStorage mock
// ---------------------------------------------------------------------------

let storage: Record<string, string> = {};

beforeEach(() => {
  storage = {};
  vi.spyOn(window, "localStorage", "get").mockReturnValue({
    getItem: (k: string) => storage[k] ?? null,
    setItem: (k: string, v: string) => { storage[k] = v; },
    removeItem: (k: string) => { delete storage[k]; },
    clear: () => { storage = {}; },
    length: 0,
    key: () => null,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ShellChrome", () => {
  it("renders <main id=main-content> with children", async () => {
    render(<ShellChrome><p>Hello world</p></ShellChrome>);
    await waitFor(() => {
      expect(screen.getByRole("main")).toBeInTheDocument();
    });
    expect(screen.getByText("Hello world")).toBeInTheDocument();
    expect(document.getElementById("main-content")).not.toBeNull();
  });

  it("renders the banner landmark", async () => {
    render(<ShellChrome><p>content</p></ShellChrome>);
    await waitFor(() => {
      expect(screen.getByRole("banner")).toBeInTheDocument();
    });
  });

  it("renders skip link targeting #main-content", () => {
    render(<ShellChrome><p>x</p></ShellChrome>);
    const skip = screen.getByText(/skip to main content/i);
    expect(skip).toHaveAttribute("href", "#main-content");
  });

  it("sidebar toggle flips aria-expanded and persists to localStorage", async () => {
    const user = userEvent.setup();
    render(<ShellChrome><p>x</p></ShellChrome>);

    // Wait for mount effect to set initial state
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /collapse sidebar|expand sidebar/i })).toBeInTheDocument();
    });

    const toggleBtn = screen.getByRole("button", { name: /collapse sidebar|expand sidebar/i });
    const initialExpanded = toggleBtn.getAttribute("aria-expanded");

    await user.click(toggleBtn);

    await waitFor(() => {
      const newExpanded = screen.getByRole("button", { name: /collapse sidebar|expand sidebar/i }).getAttribute("aria-expanded");
      expect(newExpanded).not.toBe(initialExpanded);
    });

    // localStorage should have been written
    expect(storage["keiko.shell.sidebarCollapsed"]).toBeDefined();
  });

  it("toggle button retains focus after click (does not displace)", async () => {
    const user = userEvent.setup();
    render(<ShellChrome><p>x</p></ShellChrome>);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /collapse sidebar|expand sidebar/i })).toBeInTheDocument();
    });
    const btn = screen.getByRole("button", { name: /collapse sidebar|expand sidebar/i });
    await user.click(btn);
    expect(document.activeElement).toBe(btn);
  });

  it("does not throw when localStorage is read during mount (SSR-safety)", () => {
    // Render without pre-existing key — should not throw
    expect(() => render(<ShellChrome><p>x</p></ShellChrome>)).not.toThrow();
  });

  it("has no axe-detectable accessibility violations", async () => {
    const { container } = render(<ShellChrome><p>content</p></ShellChrome>);
    // Wait for mount effects to complete
    await waitFor(() => {
      expect(screen.getByRole("main")).toBeInTheDocument();
    });
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
