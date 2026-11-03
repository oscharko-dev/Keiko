// #3880: the pairing hold keeps a secondary notice of an unpaired window quiet, records the hold
// once with the closed notice only, and leaves a paired window's notice untouched.
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UseCodingWorkbenchMcpResult } from "@/lib/useCodingWorkbenchMcp";
import {
  resetClientDiagnosticWriter,
  setClientDiagnosticWriter,
  type ClientDiagnosticMeta,
} from "@/lib/client-diagnostics";
import { McpServersView } from "./CodingWorkbenchMcpServers";
import { CodingWorkbenchPairingHold } from "./codingWorkbenchPairingHold";

const UNAVAILABLE_MCP: UseCodingWorkbenchMcpResult = {
  status: "unavailable",
  servers: [],
  authorization: undefined,
  authorize: vi.fn(),
  cancel: vi.fn(),
  retry: vi.fn(),
};
const MCP_UNAVAILABLE_TEXT = /The MCP servers could not be read/u;

describe("CodingWorkbenchPairingHold (#3880)", () => {
  const reports: ClientDiagnosticMeta[] = [];

  beforeEach(() => {
    setClientDiagnosticWriter((_message, meta) => {
      if (meta?.codingWorkbenchInteraction !== undefined) reports.push(meta);
    });
  });
  afterEach(() => {
    reports.length = 0;
    resetClientDiagnosticWriter();
  });

  it("holds an unreadable channel's notice in an unpaired window and records it once", () => {
    const { rerender, container } = render(
      <CodingWorkbenchPairingHold unpaired>
        <McpServersView mcp={UNAVAILABLE_MCP} />
      </CodingWorkbenchPairingHold>,
    );
    rerender(
      <CodingWorkbenchPairingHold unpaired>
        <McpServersView mcp={{ ...UNAVAILABLE_MCP, retry: vi.fn() }} />
      </CodingWorkbenchPairingHold>,
    );

    expect(container).toBeEmptyDOMElement();
    expect(reports.map((report) => report.codingWorkbenchInteraction)).toEqual([
      { interaction: "notice-held", notice: "mcp" },
    ]);
  });

  it("shows the notice again once the window is paired", () => {
    const { rerender } = render(
      <CodingWorkbenchPairingHold unpaired>
        <McpServersView mcp={UNAVAILABLE_MCP} />
      </CodingWorkbenchPairingHold>,
    );
    rerender(
      <CodingWorkbenchPairingHold unpaired={false}>
        <McpServersView mcp={UNAVAILABLE_MCP} />
      </CodingWorkbenchPairingHold>,
    );

    expect(screen.getByRole("note")).toHaveTextContent(MCP_UNAVAILABLE_TEXT);
    expect(reports).toHaveLength(1);
  });

  it("holds nothing outside a hold and records nothing", () => {
    render(<McpServersView mcp={UNAVAILABLE_MCP} />);

    expect(screen.getByRole("note")).toHaveTextContent(MCP_UNAVAILABLE_TEXT);
    expect(reports).toEqual([]);
  });
});
