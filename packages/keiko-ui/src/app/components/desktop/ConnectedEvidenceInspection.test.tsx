import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { axe } from "jest-axe";
import type { EvidenceManifest } from "@oscharko-dev/keiko-contracts/evidence";
import {
  DEFAULT_EXPLORATION_BUDGET,
  connectedContextOmittedCounts,
} from "@oscharko-dev/keiko-contracts/connected-context";
import type { GroundedAnswerContextPackSummary } from "@/lib/types";
import { fetchEvidenceManifest } from "@/lib/api";
import { resetClientDiagnosticWriter, setClientDiagnosticWriter } from "@/lib/client-diagnostics";
import { ConnectedEvidenceInspection } from "./ConnectedEvidenceInspection";

vi.mock("@/lib/api", () => ({ fetchEvidenceManifest: vi.fn() }));
afterEach(() => {
  vi.clearAllMocks();
  resetClientDiagnosticWriter();
});

const pack: GroundedAnswerContextPackSummary = {
  schemaVersion: "1",
  scopeId: "cs-redacted",
  scopeKind: "directory",
  fileCount: 1,
  queryKind: "natural-language",
  filesInPrompt: 1,
  budget: DEFAULT_EXPLORATION_BUDGET,
  usage: {
    searchCalls: 1,
    filesRead: 3,
    excerptBytes: 60,
    modelInputTokens: 20,
    modelOutputTokens: 0,
    elapsedMs: 1,
    rerankCalls: 0,
  },
  citationCount: 1,
  omittedCount: 2,
  omittedCounts: { ...connectedContextOmittedCounts({ omitted: [] }), "low-relevance": 2 },
  uncertaintyCount: 0,
  elapsedMs: 1,
};

function manifest(runId = "run-1"): EvidenceManifest {
  return {
    evidenceSchemaVersion: "1",
    run: {
      runId,
      fingerprint: "hash",
      harnessVersion: "1",
      taskType: "connected-context",
      outcome: "completed",
      startedAt: 1,
      finishedAt: 2,
      durationMs: 1,
    },
    model: { modelId: "model", costClass: "unknown" },
    usageTotals: { promptTokens: 20, completionTokens: 0, requestCount: 1, totalLatencyMs: 1 },
    stateTransitions: [],
    toolCalls: [],
    commandExecutions: [],
    connectedContext: {
      packSchemaVersion: "1",
      packStableIdHash: "hash",
      chatIdHash: undefined,
      modelRequest: { sentToModel: true, excerptContentPersisted: false },
      scope: {
        schemaVersion: "1",
        scopeIdHash: "hash",
        scopeKind: "directory",
        selectedPathCount: 1,
        selectedPaths: ["src/feature"],
      },
      query: {
        kind: "natural-language",
        queryTextHash: "hash",
        queryTextBytes: 3,
        maxResults: 24,
        caseSensitive: false,
      },
      plan: undefined,
      budget: { usage: {}, limits: {} },
      files: [
        {
          scopePath: "src/feature/read.ts",
          role: "primary",
          selectionReason: "explicit",
          excerptCount: 1,
          excerptBytes: 60,
          excerpts: [
            {
              atomStableId: "atom",
              scopePath: "src/feature/read.ts",
              lineRange: { startLine: 4, endLine: 9 },
              score: 1,
              provenanceKind: "repository",
              tool: "read",
              queryFingerprint: "hash",
              redactionState: "redacted",
              contentBytes: 60,
              contentSha256: "hash",
            },
          ],
        },
      ],
      omitted: [{ scopePath: "src/feature/other.ts", reason: "low-relevance" }],
      uncertainty: [],
      toolsUsed: [],
      summary: {
        fileCount: 1,
        citationCount: 1,
        omittedCount: 2,
        uncertaintyCount: 0,
        elapsedMs: 1,
      },
    },
  };
}

function expand(): void {
  const summary = screen.getByText("Inspect files");
  const details = summary.closest("details");
  if (details === null) throw new TypeError("Missing inspection disclosure");
  details.open = true;
  fireEvent(details, new Event("toggle"));
}

describe("connected evidence inspection", () => {
  it("fetches only on expand and renders manifest metadata without claiming prompt-fit reads", async () => {
    vi.mocked(fetchEvidenceManifest).mockResolvedValue({ manifest: manifest() });
    const writer = vi.fn();
    setClientDiagnosticWriter(writer);
    render(<ConnectedEvidenceInspection contextPack={pack} runIds={["run-1"]} />);
    expect(fetchEvidenceManifest).not.toHaveBeenCalled();
    expand();
    expect(
      await screen.findByRole("table", { name: "Files assembled for this answer" }),
    ).toBeInTheDocument();
    expect(screen.getByText("src/feature/read.ts")).toBeInTheDocument();
    expect(screen.getByText("4–9")).toBeInTheDocument();
    expect(screen.getByText("60 B")).toBeInTheDocument();
    expect(screen.getByRole("table", { name: "Omitted files" })).toHaveTextContent(
      "src/feature/other.ts",
    );
    expect(screen.getByText("Scope: src/feature")).toBeInTheDocument();
    expect(writer).toHaveBeenCalledWith(
      "client.evidence.inspected",
      expect.objectContaining({
        evidenceInspection: { reason: "file-table-opened", readFileCount: 1, omittedFileCount: 1 },
      }),
    );
  });
  it("renders a recoverable error and records a structured body-free fetch failure", async () => {
    vi.mocked(fetchEvidenceManifest).mockRejectedValue(new TypeError("private/path/canary"));
    const writer = vi.fn();
    setClientDiagnosticWriter(writer);
    render(<ConnectedEvidenceInspection contextPack={pack} runIds={["run-1"]} />);
    expand();
    expect(await screen.findByRole("alert")).toHaveTextContent("Unable to load evidence");
    expect(writer).toHaveBeenCalledWith(
      "client.evidence.inspected",
      expect.objectContaining({
        errorKind: "unavailable",
        errorEvidence: expect.objectContaining({ errorClass: "TypeError" }),
        evidenceInspection: { reason: "manifest-fetch-failed" },
      }),
    );
    expect(JSON.stringify(writer.mock.calls)).not.toContain("private/path/canary");
  });
  it("rejects a manifest for another run rather than assigning its read paths to this answer", async () => {
    vi.mocked(fetchEvidenceManifest).mockResolvedValue({ manifest: manifest("different") });
    render(<ConnectedEvidenceInspection contextPack={pack} runIds={["run-1"]} />);
    expand();
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.queryByText("src/feature/read.ts")).toBeNull();
  });
  it("has no axe violations in expanded file tables", async () => {
    vi.mocked(fetchEvidenceManifest).mockResolvedValue({ manifest: manifest() });
    const view = render(<ConnectedEvidenceInspection contextPack={pack} runIds={["run-1"]} />);
    expand();
    await waitFor(() => expect(screen.getAllByRole("table")).toHaveLength(2));
    expect((await axe(view.container)).violations).toEqual([]);
  });
});
