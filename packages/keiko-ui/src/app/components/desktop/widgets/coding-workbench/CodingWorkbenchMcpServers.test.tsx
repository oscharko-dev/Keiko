import { render, screen } from "@testing-library/react";
import { axe } from "jest-axe";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { UseCodingWorkbenchMcpResult } from "@/lib/useCodingWorkbenchMcp";
import { McpServersView } from "./CodingWorkbenchMcpServers";

const URL_ = "https://login.example.test/tenant/authorize?response_type=code";

function mcp(overrides: Partial<UseCodingWorkbenchMcpResult> = {}): UseCodingWorkbenchMcpResult {
  return {
    status: "ready",
    servers: [
      { name: "issues", status: "needs-authorization", authorization: "oauth" },
      { name: "docs", status: "connected", authorization: "none" },
    ],
    authorization: undefined,
    authorize: vi.fn(),
    cancel: vi.fn(),
    retry: vi.fn(),
    ...overrides,
  };
}

describe("CodingWorkbenchMcpServers (#3903 AC3)", () => {
  it("lists the run's servers and offers authorization only where it is needed", async () => {
    const state = mcp();
    const { container } = render(<McpServersView mcp={state} />);
    expect(screen.getByText("MCP servers (2)")).toBeInTheDocument();
    expect(screen.getByText("Needs authorization")).toBeInTheDocument();
    expect(screen.getByText("Connected")).toBeInTheDocument();
    const authorize = screen.getAllByRole("button", { name: "Authorize the MCP server issues" });
    expect(authorize).toHaveLength(1);
    await userEvent.click(authorize[0] as HTMLElement);
    expect(state.authorize).toHaveBeenCalledWith("issues");
    expect(await axe(container)).toHaveNoViolations();
  });

  it("links the validated authorization page in a new tab and lets the human cancel", async () => {
    const state = mcp({
      authorization: {
        phase: "waiting",
        server: "issues",
        attemptId: "con_abc",
        authorizationUrl: URL_,
        expiresAtMs: 1,
      },
    });
    const { container } = render(<McpServersView mcp={state} />);
    const link = screen.getByRole("link", { name: "Open the authorization page" });
    expect(link).toHaveAttribute("href", URL_);
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(screen.getByRole("status")).toHaveTextContent(/Waiting for the authorization/u);
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(state.cancel).toHaveBeenCalledOnce();
    expect(await axe(container)).toHaveNoViolations();
  });

  it.each([
    ["complete", "Authorized. The server connects now."],
    [
      "url-refused",
      "Keiko withheld an authorization page that does not belong to the expected issuer.",
    ],
    ["expired", "The authorization expired. Try again."],
  ] as const)("names a settled %s outcome", (outcome, text) => {
    render(
      <McpServersView
        mcp={mcp({ authorization: { phase: "settled", server: "issues", outcome } })}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(text);
  });

  it("names an unreadable channel with a retry and keeps an empty run silent", async () => {
    const state = mcp({ status: "unavailable", servers: [] });
    render(<McpServersView mcp={state} />);
    expect(screen.getByRole("note")).toHaveTextContent("The MCP servers could not be read.");
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(state.retry).toHaveBeenCalledOnce();
    const { container } = render(<McpServersView mcp={mcp({ servers: [] })} />);
    expect(container).toBeEmptyDOMElement();
  });
});
