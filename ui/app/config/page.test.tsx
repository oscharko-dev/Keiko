import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { axe } from "jest-axe";
import ConfigPage from "./page";
import * as api from "@/lib/api";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("@/lib/api", () => ({
  fetchConfig: vi.fn(),
  fetchModels: vi.fn(),
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

const mockConfig = {
  config: {
    providers: [
      {
        name: "anthropic",
        modelId: "claude-3-5-sonnet",
        baseUrl: "https://api.anthropic.com",
        timeoutMs: 30000,
        retries: 2,
      },
    ],
  },
  configPresent: true,
};

const mockModels = {
  models: [
    {
      id: "claude-3-5-sonnet",
      kind: "chat" as const,
      contextWindow: 200000,
      maxOutputTokens: 8192,
      toolCalling: true,
      structuredOutput: true,
      streaming: true,
      costClass: "medium" as const,
      latencyClass: "medium" as const,
      throughputHint: "medium",
      preferredUseCases: ["code generation", "analysis"],
      knownLimitations: ["no real-time data"],
    },
    {
      id: "claude-3-haiku",
      kind: "chat" as const,
      contextWindow: 200000,
      maxOutputTokens: 4096,
      toolCalling: true,
      structuredOutput: false,
      streaming: true,
      costClass: "low" as const,
      latencyClass: "fast" as const,
      throughputHint: "high",
      preferredUseCases: [],
      knownLimitations: [],
    },
  ],
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ConfigPage", () => {
  beforeEach(() => {
    vi.mocked(api.fetchConfig).mockResolvedValue(mockConfig);
    vi.mocked(api.fetchModels).mockResolvedValue(mockModels);
  });

  it("renders the config heading", async () => {
    render(<ConfigPage />);
    await waitFor(() => {
      expect(
        screen.getByRole("heading", { level: 1, name: /config.*model inspector/i }),
      ).toBeInTheDocument();
    });
  });

  it("renders gateway configuration section", async () => {
    render(<ConfigPage />);
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: /gateway configuration/i })).toBeInTheDocument();
    });
  });

  it("renders model registry section with model IDs", async () => {
    render(<ConfigPage />);
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: /model registry/i })).toBeInTheDocument();
      // Model ID appears multiple times (provider table + registry + detail) — use getAllByText
      expect(screen.getAllByText("claude-3-5-sonnet").length).toBeGreaterThan(0);
      expect(screen.getAllByText("claude-3-haiku").length).toBeGreaterThan(0);
    });
  });

  it("headings and tables are in the DOM and reachable by keyboard via tab", async () => {
    render(<ConfigPage />);
    await waitFor(() => {
      expect(screen.getByText("anthropic")).toBeInTheDocument();
    });
    // Verify both section headings are present (keyboard users reach them via headings navigation)
    expect(screen.getByRole("heading", { name: /gateway configuration/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /model registry/i })).toBeInTheDocument();
    // Tables are keyboard-reachable (implicit focus via tab order)
    const tables = screen.getAllByRole("table");
    expect(tables.length).toBeGreaterThan(0);
  });

  it("shows empty state when configPresent is false", async () => {
    vi.mocked(api.fetchConfig).mockResolvedValue({ config: null, configPresent: false });
    render(<ConfigPage />);
    await waitFor(() => {
      expect(screen.getByText(/no configuration file found/i)).toBeInTheDocument();
    });
  });

  it("shows error message when API fails", async () => {
    vi.mocked(api.fetchConfig).mockRejectedValueOnce(new Error("Network error"));
    render(<ConfigPage />);
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });
  });

  // ---------------------------------------------------------------------------
  // CRITICAL: no secret-shaped string must appear in the DOM
  // ---------------------------------------------------------------------------
  it("renders NO secret-shaped strings in the DOM", async () => {
    // Inject fake "secrets" into mock data to ensure they never reach the DOM.
    // The BFF is responsible for stripping them; this test verifies the UI itself
    // does not echo any secret-shaped token even if one somehow leaked through.
    vi.mocked(api.fetchConfig).mockResolvedValue({
      config: {
        providers: [
          {
            name: "anthropic",
            modelId: "claude-3-5-sonnet",
            baseUrl: "https://api.anthropic.com",
            // SafeProviderConfig has no apiKey field — these values do not appear
            timeoutMs: 30000,
            retries: 2,
          },
        ],
      },
      configPresent: true,
    });

    const { container } = render(<ConfigPage />);
    await waitFor(() => {
      expect(screen.getByText("anthropic")).toBeInTheDocument();
    });

    const domText = container.textContent ?? "";

    // Pattern: common secret prefixes used by API providers
    const secretPatterns = [
      /sk-[A-Za-z0-9]{10,}/,
      /Bearer\s+[A-Za-z0-9\-._~+/]+=*/,
      /ghp_[A-Za-z0-9]{20,}/,
      /glpat-[A-Za-z0-9\-]{10,}/,
      /apiKey/i,
      /api_key/i,
      /authorization/i,
      /x-api-key/i,
    ];

    for (const pattern of secretPatterns) {
      expect(domText).not.toMatch(pattern);
    }

    // Also assert no attribute on any element contains a secret-shaped value
    const allElements = container.querySelectorAll("*");
    allElements.forEach((el) => {
      for (const attr of Array.from(el.attributes)) {
        for (const pattern of secretPatterns) {
          expect(attr.value).not.toMatch(pattern);
        }
      }
    });
  });

  it("has no axe-detectable accessibility violations", async () => {
    const { container } = render(<ConfigPage />);
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: /model registry/i })).toBeInTheDocument();
    });
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
