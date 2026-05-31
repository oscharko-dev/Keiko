import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import Page from "./page";
import LaunchPage from "./launch/page";
import { ShellChrome } from "./components/shell/ShellChrome";
import { clearSelectedProjectCacheForTests } from "./components/shell/useSelectedProject";
import * as api from "@/lib/api";

const mockSearchParams = new URLSearchParams();
let mockPathname = "/";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => mockSearchParams,
  usePathname: () => mockPathname,
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

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof api>("@/lib/api");
  return {
    ...actual,
    fetchProjects: vi.fn(),
    fetchChats: vi.fn(),
    createProject: vi.fn(),
    updateProject: vi.fn(),
    deleteProject: vi.fn(),
    createChat: vi.fn(),
    fetchWorkspaceSummary: vi.fn(),
    ApiError: class ApiError extends Error {
      code: string;
      status: number;
      constructor(code: string, msg: string, status: number) {
        super(msg);
        this.code = code;
        this.status = status;
      }
    },
  };
});

let storage: Record<string, string> = {};

function makeStorage(): Storage {
  return {
    getItem: (key: string) => storage[key] ?? null,
    setItem: (key: string, value: string) => {
      storage[key] = value;
    },
    removeItem: (key: string) => {
      delete storage[key];
    },
    clear: () => {
      storage = {};
    },
    length: 0,
    key: () => null,
  };
}

function renderShellRoute(route: "/" | "/launch"): void {
  mockPathname = route;
  const Route = route === "/" ? Page : LaunchPage;
  render(
    <ShellChrome>
      <Route />
    </ShellChrome>,
  );
}

describe("workspace shell route integration", () => {
  beforeEach(() => {
    storage = {};
    mockSearchParams.delete("project");
    mockSearchParams.delete("chat");
    mockSearchParams.delete("tool");
    clearSelectedProjectCacheForTests();
    vi.spyOn(window, "localStorage", "get").mockReturnValue(makeStorage());
    vi.mocked(api.fetchProjects).mockResolvedValue({ projects: [] });
    vi.mocked(api.fetchChats).mockResolvedValue({ chats: [] });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(["/", "/launch"] as const)(
    "renders %s inside ShellChrome with Config and Evidence as secondary navigation",
    async (route) => {
      renderShellRoute(route);

      await waitFor(() => {
        expect(screen.getByRole("main")).toBeInTheDocument();
      });
      expect(
        screen.getByRole("heading", { name: /welcome to keiko/i }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("navigation", { name: /secondary navigation/i }),
      ).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Config" })).toHaveAttribute("href", "/config");
      expect(screen.getByRole("link", { name: "Evidence" })).toHaveAttribute(
        "href",
        "/evidence",
      );
      expect(
        screen.getByRole("complementary", { name: /workspace tools/i }),
      ).toBeInTheDocument();
    },
  );
});
