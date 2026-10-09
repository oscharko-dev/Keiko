import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { axe } from "jest-axe";
import { fetchEvidenceManifest } from "@/lib/api";
import { resetClientDiagnosticWriter, setClientDiagnosticWriter } from "@/lib/client-diagnostics";
import {
  INSPECTION_PACK as pack,
  connectedInspectionManifest as manifest,
} from "./connectedEvidenceInspection.test-fixtures";
import { ConnectedEvidenceInspection } from "./ConnectedEvidenceInspection";

vi.mock("@/lib/api", () => ({ fetchEvidenceManifest: vi.fn() }));
afterEach(() => {
  vi.clearAllMocks();
  resetClientDiagnosticWriter();
});

function expand(): void {
  const summary = screen.getByText("Inspect files");
  const details = summary.closest("details");
  if (details === null) throw new TypeError("Missing inspection disclosure");
  details.open = true;
  fireEvent(details, new Event("toggle"));
}

describe("connected evidence inspection", () => {
  it("discards a delayed manifest after the displayed answer changes", async () => {
    let complete:
      ((response: Awaited<ReturnType<typeof fetchEvidenceManifest>>) => void) | undefined;
    vi.mocked(fetchEvidenceManifest)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            complete = resolve;
          }),
      )
      .mockResolvedValueOnce({ manifest: manifest("run-2") });
    const onRead = vi.fn();
    const view = render(
      <ConnectedEvidenceInspection contextPack={pack} runIds={["run-1"]} onReadPaths={onRead} />,
    );
    expand();
    view.rerender(
      <ConnectedEvidenceInspection contextPack={pack} runIds={["run-2"]} onReadPaths={onRead} />,
    );
    expand();
    await screen.findByRole("table", { name: "Files assembled for this answer" });
    complete?.({ manifest: manifest() });
    await waitFor(() => expect(onRead).toHaveBeenCalledTimes(1));
    expect(onRead).toHaveBeenCalledWith("run-2", ["src/feature/read.ts"], ["src/feature"]);
  });
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
