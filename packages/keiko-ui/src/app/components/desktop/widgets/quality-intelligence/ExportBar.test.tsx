// Issue #280 (Epic #270) — ExportBar component tests.
//
// Tests cover:
//   - Renders adapter select with all expected options (csv / json / spreadsheet-safe-csv
//     and jira-issues / qtest / xray / polarion).
//   - "Download" label for local adapters (csv, json, spreadsheet-safe-csv).
//   - "Preview" label for TMS adapters (jira-issues, qtest, xray, polarion).
//   - Local adapter: clicking Download calls exportImpl(runId, adapter, {dryRun:false,...}).
//   - Local adapter: mock returning a local result; asserts exportImpl called dryRun:false.
//   - TMS adapter: clicking Preview calls exportImpl(runId, adapter, {dryRun:true,...}).
//   - TMS adapter: mock returns preview result; qi-export-preview renders preview text.
//   - exportImpl throwing surfaces qi-export-error.
//   - Error from local export surfaces qi-export-error.
//   - After an error the UI allows retrying (button is not disabled).

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ExportBar } from "./ExportBar";
import type { QiExportResult } from "@/lib/quality-intelligence-api";

// ---------------------------------------------------------------------------
// exportImpl seam — bound to the real exportQiRun contract.
//
// exportQiRun(runId, adapter, options?) resolves a QiExportResult: a local-download result for the
// CSV/JSON adapters, or a dry-run preview result for the TMS adapters. The fakes below mirror that
// exact signature and resolve real-shaped results.
// ---------------------------------------------------------------------------

type ExportQiRunFn = (
  runId: string,
  adapter: string,
  options?: { readonly dryRun?: boolean; readonly approvedOnly?: boolean },
) => Promise<QiExportResult>;

/**
 * A fake for a local (non-TMS) export. Returns a resolved local-download result.
 */
function makeLocalExportFake(
  overrides: Partial<{ filename: string; contentType: string; body: string }> = {},
): ExportQiRunFn {
  const body = overrides.body ?? "id,title\n1,Test login";
  return vi.fn().mockResolvedValue({
    dryRun: false,
    adapter: "csv",
    filename: overrides.filename ?? "export.csv",
    contentType: overrides.contentType ?? "text/csv",
    byteLen: body.length,
    body,
  }) as unknown as ExportQiRunFn;
}

/**
 * A fake for a TMS dry-run (Preview) export. Returns a resolved preview result.
 */
function makeTmsPreviewFake(previewText: string): ExportQiRunFn {
  return vi.fn().mockResolvedValue({
    dryRun: true,
    adapter: "jira-issues",
    candidateCount: 3,
    byteLen: previewText.length,
    preview: previewText,
  }) as unknown as ExportQiRunFn;
}

/**
 * A fake that always rejects with the given error.
 */
function makeRejectingFake(error: Error): ExportQiRunFn {
  return vi.fn().mockRejectedValue(error) as unknown as ExportQiRunFn;
}

// ---------------------------------------------------------------------------
// Tests — adapter select contents
// ---------------------------------------------------------------------------

describe("ExportBar — adapter select options", () => {
  it("renders a select for choosing the export adapter", () => {
    render(<ExportBar runId="run-001" />);
    expect(screen.getByRole("combobox", { name: /adapter|format|export/i })).toBeInTheDocument();
  });

  it.each(["csv", "json", "spreadsheet-safe-csv"])(
    "includes local adapter option '%s'",
    (adapter) => {
      render(<ExportBar runId="run-001" />);
      const select = screen.getByRole("combobox", { name: /adapter|format|export/i });
      const options = Array.from(select.querySelectorAll("option")).map((o) => o.value);
      expect(options).toContain(adapter);
    },
  );

  it.each(["jira-issues", "qtest", "xray", "polarion"])(
    "includes TMS adapter option '%s'",
    (adapter) => {
      render(<ExportBar runId="run-001" />);
      const select = screen.getByRole("combobox", { name: /adapter|format|export/i });
      const options = Array.from(select.querySelectorAll("option")).map((o) => o.value);
      expect(options).toContain(adapter);
    },
  );
});

// ---------------------------------------------------------------------------
// Tests — button label changes with adapter type
// ---------------------------------------------------------------------------

describe("ExportBar — button label by adapter type", () => {
  it("shows a 'Download' button when a local adapter (csv) is selected", async () => {
    render(<ExportBar runId="run-001" />);
    // csv should be the default or we select it explicitly.
    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: /adapter|format|export/i }),
      "csv",
    );
    expect(screen.getByRole("button", { name: /download/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /preview/i })).not.toBeInTheDocument();
  });

  it("shows a 'Download' button when 'json' adapter is selected", async () => {
    render(<ExportBar runId="run-001" />);
    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: /adapter|format|export/i }),
      "json",
    );
    expect(screen.getByRole("button", { name: /download/i })).toBeInTheDocument();
  });

  it("shows a 'Download' button when 'spreadsheet-safe-csv' adapter is selected", async () => {
    render(<ExportBar runId="run-001" />);
    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: /adapter|format|export/i }),
      "spreadsheet-safe-csv",
    );
    expect(screen.getByRole("button", { name: /download/i })).toBeInTheDocument();
  });

  it("shows a 'Preview' button when the 'jira-issues' TMS adapter is selected", async () => {
    render(<ExportBar runId="run-001" />);
    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: /adapter|format|export/i }),
      "jira-issues",
    );
    expect(screen.getByRole("button", { name: /preview/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /download/i })).not.toBeInTheDocument();
  });

  it.each(["qtest", "xray", "polarion"])(
    "shows a 'Preview' button when the '%s' TMS adapter is selected",
    async (adapter) => {
      render(<ExportBar runId="run-001" />);
      await userEvent.selectOptions(
        screen.getByRole("combobox", { name: /adapter|format|export/i }),
        adapter,
      );
      expect(screen.getByRole("button", { name: /preview/i })).toBeInTheDocument();
    },
  );
});

// ---------------------------------------------------------------------------
// Tests — local adapter export (Download)
// ---------------------------------------------------------------------------

describe("ExportBar — local adapter export", () => {
  it("calls exportImpl with the runId, adapter, and dryRun:false when Download is clicked", async () => {
    const user = userEvent.setup();
    const exportImpl = makeLocalExportFake();
    render(<ExportBar runId="run-xyz" exportImpl={exportImpl} />);

    await user.selectOptions(
      screen.getByRole("combobox", { name: /adapter|format|export/i }),
      "csv",
    );
    await user.click(screen.getByRole("button", { name: /download/i }));

    await waitFor(() => {
      expect(exportImpl).toHaveBeenCalledOnce();
    });

    const [calledRunId, calledAdapter, calledOptions] = (exportImpl as ReturnType<typeof vi.fn>)
      .mock.calls[0] as [string, string, { dryRun: boolean }];

    expect(calledRunId).toBe("run-xyz");
    expect(calledAdapter).toBe("csv");
    expect(calledOptions.dryRun).toBe(false);
  });

  it("calls exportImpl with dryRun:false for the 'json' adapter", async () => {
    const user = userEvent.setup();
    const exportImpl = makeLocalExportFake();
    render(<ExportBar runId="run-json" exportImpl={exportImpl} />);

    await user.selectOptions(
      screen.getByRole("combobox", { name: /adapter|format|export/i }),
      "json",
    );
    await user.click(screen.getByRole("button", { name: /download/i }));

    await waitFor(() => {
      expect(exportImpl).toHaveBeenCalledOnce();
    });
    const [, , options] = (exportImpl as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      string,
      { dryRun: boolean },
    ];
    expect(options.dryRun).toBe(false);
  });

  it("calls exportImpl with dryRun:false for the 'spreadsheet-safe-csv' adapter", async () => {
    const user = userEvent.setup();
    const exportImpl = makeLocalExportFake();
    render(<ExportBar runId="run-ssc" exportImpl={exportImpl} />);

    await user.selectOptions(
      screen.getByRole("combobox", { name: /adapter|format|export/i }),
      "spreadsheet-safe-csv",
    );
    await user.click(screen.getByRole("button", { name: /download/i }));

    await waitFor(() => {
      expect(exportImpl).toHaveBeenCalledOnce();
    });
    const [, , options] = (exportImpl as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      string,
      { dryRun: boolean },
    ];
    expect(options.dryRun).toBe(false);
  });

  it("does not render qi-export-preview after a successful local export", async () => {
    const user = userEvent.setup();
    const exportImpl = makeLocalExportFake({ body: "id,title\n1,TC-001" });
    render(<ExportBar runId="run-001" exportImpl={exportImpl} />);

    await user.selectOptions(
      screen.getByRole("combobox", { name: /adapter|format|export/i }),
      "csv",
    );
    await user.click(screen.getByRole("button", { name: /download/i }));

    await waitFor(() => {
      expect(exportImpl).toHaveBeenCalledOnce();
    });

    expect(screen.queryByTestId("qi-export-preview")).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Tests — TMS adapter preview (Preview)
// ---------------------------------------------------------------------------

describe("ExportBar — TMS adapter preview", () => {
  it("calls exportImpl with dryRun:true when Preview is clicked for jira-issues", async () => {
    const user = userEvent.setup();
    const exportImpl = makeTmsPreviewFake("3 candidates would be created in Jira.");
    render(<ExportBar runId="run-jira" exportImpl={exportImpl} />);

    await user.selectOptions(
      screen.getByRole("combobox", { name: /adapter|format|export/i }),
      "jira-issues",
    );
    await user.click(screen.getByRole("button", { name: /preview/i }));

    await waitFor(() => {
      expect(exportImpl).toHaveBeenCalledOnce();
    });

    const [calledRunId, calledAdapter, calledOptions] = (exportImpl as ReturnType<typeof vi.fn>)
      .mock.calls[0] as [string, string, { dryRun: boolean }];

    expect(calledRunId).toBe("run-jira");
    expect(calledAdapter).toBe("jira-issues");
    expect(calledOptions.dryRun).toBe(true);
  });

  it("renders the preview text in qi-export-preview after a successful TMS preview", async () => {
    const user = userEvent.setup();
    const previewText = "3 candidates would be created in Jira.";
    const exportImpl = makeTmsPreviewFake(previewText);
    render(<ExportBar runId="run-jira" exportImpl={exportImpl} />);

    await user.selectOptions(
      screen.getByRole("combobox", { name: /adapter|format|export/i }),
      "jira-issues",
    );
    await user.click(screen.getByRole("button", { name: /preview/i }));

    await waitFor(() => {
      expect(screen.getByTestId("qi-export-preview")).toBeInTheDocument();
    });
    expect(screen.getByTestId("qi-export-preview")).toHaveTextContent(previewText);
  });

  it("renders candidateCount information in the preview region", async () => {
    const user = userEvent.setup();
    const exportImpl = makeTmsPreviewFake("2 test cases queued for xray.");
    render(<ExportBar runId="run-xray" exportImpl={exportImpl} />);

    await user.selectOptions(
      screen.getByRole("combobox", { name: /adapter|format|export/i }),
      "xray",
    );
    await user.click(screen.getByRole("button", { name: /preview/i }));

    await waitFor(() => {
      expect(screen.getByTestId("qi-export-preview")).toBeInTheDocument();
    });
  });

  it("clears a previous preview when the adapter is changed and Preview clicked again", async () => {
    const user = userEvent.setup();
    const firstPreview = "First preview result.";
    const secondPreview = "Second preview result.";
    const exportImpl = vi
      .fn()
      .mockResolvedValueOnce({
        dryRun: true,
        candidateCount: 1,
        byteLen: 20,
        preview: firstPreview,
      })
      .mockResolvedValueOnce({
        dryRun: true,
        candidateCount: 2,
        byteLen: 21,
        preview: secondPreview,
      }) as unknown as ExportQiRunFn;

    render(<ExportBar runId="run-001" exportImpl={exportImpl} />);

    await user.selectOptions(
      screen.getByRole("combobox", { name: /adapter|format|export/i }),
      "jira-issues",
    );
    await user.click(screen.getByRole("button", { name: /preview/i }));
    await waitFor(() => {
      expect(screen.getByTestId("qi-export-preview")).toHaveTextContent(firstPreview);
    });

    // Switch adapter and click Preview again.
    await user.selectOptions(
      screen.getByRole("combobox", { name: /adapter|format|export/i }),
      "xray",
    );
    await user.click(screen.getByRole("button", { name: /preview/i }));
    await waitFor(() => {
      expect(screen.getByTestId("qi-export-preview")).toHaveTextContent(secondPreview);
    });

    expect(screen.queryByText(firstPreview)).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Tests — error path
// ---------------------------------------------------------------------------

describe("ExportBar — error handling", () => {
  it("surfaces qi-export-error when exportImpl rejects during a local export", async () => {
    const user = userEvent.setup();
    const exportImpl = makeRejectingFake(new Error("S3 upload failed"));
    render(<ExportBar runId="run-001" exportImpl={exportImpl} />);

    await user.selectOptions(
      screen.getByRole("combobox", { name: /adapter|format|export/i }),
      "csv",
    );
    await user.click(screen.getByRole("button", { name: /download/i }));

    await waitFor(() => {
      expect(screen.getByTestId("qi-export-error")).toBeInTheDocument();
    });
    expect(screen.getByTestId("qi-export-error")).toHaveTextContent(/S3 upload failed|error/i);
  });

  it("surfaces qi-export-error when exportImpl rejects during a TMS preview", async () => {
    const user = userEvent.setup();
    const exportImpl = makeRejectingFake(new Error("Jira auth failed: 401"));
    render(<ExportBar runId="run-001" exportImpl={exportImpl} />);

    await user.selectOptions(
      screen.getByRole("combobox", { name: /adapter|format|export/i }),
      "jira-issues",
    );
    await user.click(screen.getByRole("button", { name: /preview/i }));

    await waitFor(() => {
      expect(screen.getByTestId("qi-export-error")).toBeInTheDocument();
    });
    expect(screen.getByTestId("qi-export-error")).toHaveTextContent(/Jira auth|401|error/i);
  });

  it("does not render qi-export-preview when exportImpl rejects", async () => {
    const user = userEvent.setup();
    const exportImpl = makeRejectingFake(new Error("network error"));
    render(<ExportBar runId="run-001" exportImpl={exportImpl} />);

    await user.selectOptions(
      screen.getByRole("combobox", { name: /adapter|format|export/i }),
      "jira-issues",
    );
    await user.click(screen.getByRole("button", { name: /preview/i }));

    await waitFor(() => {
      expect(screen.getByTestId("qi-export-error")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("qi-export-preview")).not.toBeInTheDocument();
  });

  it("re-enables the export button after an error so the user can retry", async () => {
    const user = userEvent.setup();
    const exportImpl = makeRejectingFake(new Error("timeout"));
    render(<ExportBar runId="run-001" exportImpl={exportImpl} />);

    await user.selectOptions(
      screen.getByRole("combobox", { name: /adapter|format|export/i }),
      "csv",
    );
    await user.click(screen.getByRole("button", { name: /download/i }));

    await waitFor(() => {
      expect(screen.getByTestId("qi-export-error")).toBeInTheDocument();
    });

    expect(screen.getByRole("button", { name: /download/i })).not.toBeDisabled();
  });

  it("clears a previous error when a subsequent export succeeds", async () => {
    const user = userEvent.setup();
    const exportImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error("first attempt failed"))
      .mockResolvedValueOnce({
        dryRun: false,
        filename: "export.csv",
        contentType: "text/csv",
        body: "ok",
      }) as unknown as ExportQiRunFn;

    render(<ExportBar runId="run-001" exportImpl={exportImpl} />);

    await user.selectOptions(
      screen.getByRole("combobox", { name: /adapter|format|export/i }),
      "csv",
    );
    await user.click(screen.getByRole("button", { name: /download/i }));

    await waitFor(() => {
      expect(screen.getByTestId("qi-export-error")).toBeInTheDocument();
    });

    // Second attempt succeeds.
    await user.click(screen.getByRole("button", { name: /download/i }));

    await waitFor(() => {
      expect(screen.queryByTestId("qi-export-error")).not.toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// Tests — runId prop is forwarded correctly
// ---------------------------------------------------------------------------

describe("ExportBar — runId forwarding", () => {
  it("passes the correct runId to exportImpl regardless of which adapter is selected", async () => {
    const user = userEvent.setup();
    const exportImpl = makeLocalExportFake();
    const specificRunId = "run-deadbeef-1234";
    render(<ExportBar runId={specificRunId} exportImpl={exportImpl} />);

    await user.selectOptions(
      screen.getByRole("combobox", { name: /adapter|format|export/i }),
      "json",
    );
    await user.click(screen.getByRole("button", { name: /download/i }));

    await waitFor(() => {
      expect(exportImpl).toHaveBeenCalledOnce();
    });

    const [calledRunId] = (exportImpl as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(calledRunId).toBe(specificRunId);
  });
});

// ---------------------------------------------------------------------------
// Tests — Epic #711 multi-format adapters (Markdown / plain-text / PDF / ZIP / Quality Center)
// ---------------------------------------------------------------------------

describe("ExportBar — Epic #711 multi-format adapters", () => {
  it.each(["markdown", "plain-text", "pdf", "zip-bundle"])(
    "includes the new local format option '%s'",
    (adapter) => {
      render(<ExportBar runId="run-001" />);
      const select = screen.getByRole("combobox", { name: /adapter|format|export/i });
      const options = Array.from(select.querySelectorAll("option")).map((o) => o.value);
      expect(options).toContain(adapter);
    },
  );

  it("offers Quality Center as a disabled, preview-only (TMS) adapter", async () => {
    render(<ExportBar runId="run-001" />);
    const select = screen.getByRole("combobox", { name: /adapter|format|export/i });
    const options = Array.from(select.querySelectorAll("option")).map((o) => o.value);
    expect(options).toContain("quality-center");
    await userEvent.selectOptions(select, "quality-center");
    expect(screen.getByRole("button", { name: /preview/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /download/i })).not.toBeInTheDocument();
  });

  it("downloads a PDF through the binary (base64) path without surfacing an error", async () => {
    const user = userEvent.setup();
    const exportImpl = vi.fn().mockResolvedValue({
      dryRun: false,
      adapter: "pdf",
      filename: "run-001.pdf",
      contentType: "application/pdf",
      byteLen: 16,
      encoding: "base64",
      body: btoa("%PDF-1.4 minimal"),
    }) as unknown as ExportQiRunFn;
    render(<ExportBar runId="run-001" exportImpl={exportImpl} />);
    await user.selectOptions(
      screen.getByRole("combobox", { name: /adapter|format|export/i }),
      "pdf",
    );
    await user.click(screen.getByRole("button", { name: /download/i }));
    await waitFor(() => {
      expect(exportImpl).toHaveBeenCalledWith(
        "run-001",
        "pdf",
        expect.objectContaining({ dryRun: false }),
      );
    });
    expect(screen.queryByTestId("qi-export-error")).not.toBeInTheDocument();
  });
});
