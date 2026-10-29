import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { describe, expect, it, vi } from "vitest";
import { EDITOR_AGENT_CHANGESET_MAX_PATCH_BYTES } from "@oscharko-dev/keiko-contracts/runtime/editor-agent";
import type { CodingWorkbenchChangesetReview } from "@/lib/useCodingWorkbenchEditorBridge";

import { parseUnifiedDiff, type DiffParseResult } from "../cards/shared/diffParser";
import {
  DIFF_WINDOW_PAGE_ROWS,
  DIFF_WINDOW_THRESHOLD_ROWS,
  diffFileMetrics,
} from "../cards/shared/diffWindow";
import { diffLabels } from "./CodingWorkbenchChanges";
import { CodingWorkbenchDiffFiles } from "./CodingWorkbenchWindowedDiff";
import { ChangesetReviewPanel } from "./CodingWorkbenchWindow";
import { translateCodingWorkbench } from "./coding-workbench-i18n";

const labels = diffLabels((key, values) => translateCodingWorkbench("en", key, values));

// A unified diff of `fileCount` files, each `hunksPerFile` hunks of `linesPerHunk` lines (one
// deletion, one context line and the rest additions). Deterministic and self-contained.
function syntheticPatch(
  fileCount: number,
  hunksPerFile: number,
  linesPerHunk: number,
  padding = 24,
): string {
  const out: string[] = [];
  for (let fileIndex = 0; fileIndex < fileCount; fileIndex += 1) {
    const path = `src/generated/module-${String(fileIndex).padStart(3, "0")}.ts`;
    out.push(`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`);
    for (let hunkIndex = 0; hunkIndex < hunksPerFile; hunkIndex += 1) {
      const start = hunkIndex * 1_000 + 1;
      out.push(`@@ -${String(start)},2 +${String(start)},${String(linesPerHunk)} @@`);
      out.push(` const context_${String(hunkIndex)} = ${"c".repeat(padding)};`);
      out.push(`-const removed_${String(hunkIndex)} = ${"r".repeat(padding)};`);
      for (let line = 2; line < linesPerHunk; line += 1) {
        out.push(`+const added_${String(hunkIndex)}_${String(line)} = ${"a".repeat(padding)};`);
      }
    }
  }
  return `${out.join("\n")}\n`;
}

function parse(raw: string, maxBytes = EDITOR_AGENT_CHANGESET_MAX_PATCH_BYTES): DiffParseResult {
  return parseUnifiedDiff(raw, { maxBytes });
}

function visibleRows(container: HTMLElement): number {
  return container.querySelectorAll(".rv-line").length;
}

describe("CodingWorkbenchDiffFiles (#4108)", () => {
  it("renders a small diff in full with no windowing chrome", () => {
    const { files } = parse(syntheticPatch(2, 2, 20));
    const { container } = render(
      <CodingWorkbenchDiffFiles files={files} idPrefix="t-small" labels={labels} />,
    );
    expect(container.querySelectorAll("section")).toHaveLength(2);
    expect(visibleRows(container)).toBe(2 * 2 * 20);
    expect(screen.queryByRole("group", { name: "Pages of this file" })).toBeNull();
    expect(screen.queryByRole("list", { name: "Files in this diff" })).toBeNull();
  });

  it("shows a large diff one file and one page at a time with a visible notice", () => {
    // 3 files x 3 hunks x 700 lines = 6,300 rows, above the threshold.
    const { files } = parse(syntheticPatch(3, 3, 700));
    const rows = files.reduce((sum, file) => sum + diffFileMetrics(file).rows, 0);
    expect(rows).toBeGreaterThan(DIFF_WINDOW_THRESHOLD_ROWS);
    const { container } = render(
      <CodingWorkbenchDiffFiles files={files} idPrefix="t-large" labels={labels} />,
    );

    expect(container.querySelectorAll("section")).toHaveLength(1);
    expect(visibleRows(container)).toBeLessThanOrEqual(DIFF_WINDOW_PAGE_ROWS + 3);
    // Nothing is hidden silently: the totals, the position and every file are on screen.
    expect(screen.getByText(/This diff is large: 6,300 lines in 3 files/u)).toBeTruthy();
    const list = screen.getByRole("list", { name: "Files in this diff" });
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(3);
    expect(items[0]?.textContent).toMatch(/module-000\.ts/u);
    expect(items[0]?.textContent).toMatch(/\+2,094 −3 · [\d.]+ KiB · 2,100 lines/u);
    expect(screen.getByRole("status").textContent).toBe("File 1 of 3, lines 1 to 1,000 of 2,100");
  });

  it("reaches every line of a file through its pages and never shows more than a page", async () => {
    const user = userEvent.setup();
    const { files } = parse(syntheticPatch(1, 3, 1_000));
    const { container } = render(
      <CodingWorkbenchDiffFiles files={files} idPrefix="t-pages" labels={labels} />,
    );
    let total = 0;
    for (let page = 1; page <= 3; page += 1) {
      expect(screen.getAllByText(`Page ${String(page)} of 3`).length).toBeGreaterThan(0);
      expect(visibleRows(container)).toBeLessThanOrEqual(DIFF_WINDOW_PAGE_ROWS + 3);
      total += container.querySelectorAll(".rv-line.rv-add, .rv-line.rv-del, .rv-line").length;
      const next = screen.getAllByRole("button", { name: "Next lines" })[0];
      if (next === undefined) throw new Error("expected a next control");
      if (page < 3) await user.click(next);
    }
    expect(total).toBeGreaterThanOrEqual(3_000);
  });

  it("keeps keyboard focus on the page control and ignores the exhausted direction", async () => {
    const user = userEvent.setup();
    const { files } = parse(syntheticPatch(1, 3, 1_000));
    render(<CodingWorkbenchDiffFiles files={files} idPrefix="t-key" labels={labels} />);
    const next = screen.getAllByRole("button", { name: "Next lines" })[0];
    const previous = screen.getAllByRole("button", { name: "Previous lines" })[0];
    if (next === undefined || previous === undefined) throw new Error("expected page controls");
    expect(previous.getAttribute("aria-disabled")).toBe("true");

    next.focus();
    await user.keyboard("{Enter}");
    await user.keyboard("{Enter}");
    await user.keyboard("{Enter}");

    expect(document.activeElement).toBe(next);
    expect(screen.getByRole("status").textContent).toBe(
      "File 1 of 1, lines 2,001 to 3,000 of 3,000",
    );
    expect(next.getAttribute("aria-disabled")).toBe("true");
    expect(previous.getAttribute("aria-disabled")).toBe("false");
  });

  it("switches files from the list, resets the page and marks the chosen file", async () => {
    const user = userEvent.setup();
    const { files } = parse(syntheticPatch(3, 1, 2_100));
    const { container } = render(
      <CodingWorkbenchDiffFiles files={files} idPrefix="t-files" labels={labels} />,
    );
    await user.click(screen.getAllByRole("button", { name: "Next lines" })[0] as HTMLElement);
    expect(screen.getByRole("status").textContent).toContain("lines 1,001 to 2,000");

    const second = within(screen.getByRole("list", { name: "Files in this diff" })).getAllByRole(
      "button",
    )[1] as HTMLElement;
    await user.click(second);

    expect(second.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("status").textContent).toBe("File 2 of 3, lines 1 to 1,000 of 2,100");
    expect(container.querySelector("h3")?.textContent).toContain("module-001.ts");
    expect(container.querySelectorAll("section")).toHaveLength(1);
  });

  it("marks a truncated file only on its last page", async () => {
    const user = userEvent.setup();
    const parsed = parse(syntheticPatch(1, 1, 2_500));
    const file = parsed.files[0];
    if (file === undefined) throw new Error("expected a file");
    const truncated = { ...file, truncated: true };
    render(<CodingWorkbenchDiffFiles files={[truncated]} idPrefix="t-trunc" labels={labels} />);
    expect(screen.queryByText(/incomplete/u)).toBeNull();
    await user.click(screen.getAllByRole("button", { name: "Next lines" })[0] as HTMLElement);
    await user.click(screen.getAllByRole("button", { name: "Next lines" })[0] as HTMLElement);
    expect(screen.getByText(/incomplete/u)).toBeTruthy();
  });

  it("has no axe violations in windowed mode", async () => {
    const { files } = parse(syntheticPatch(3, 3, 700));
    const { container } = render(
      <CodingWorkbenchDiffFiles files={files} idPrefix="t-axe" labels={labels} />,
    );
    expect(await axe(container)).toHaveNoViolations();
    // axe walks the full 1,000-row page, which is slow under coverage instrumentation.
  }, 120_000);
});

function review(
  patch: string,
  overrides: Partial<CodingWorkbenchChangesetReview> = {},
): CodingWorkbenchChangesetReview {
  return {
    actionId: "action-1",
    diff: parse(patch),
    deciding: false,
    deliveryFailed: false,
    deliveryFailure: null,
    ...overrides,
  } satisfies CodingWorkbenchChangesetReview;
}

describe("changeset review at the 8 MiB limit (#4108)", () => {
  // About 8 MiB: 8 files of 1 MiB. The patch is generated once for the whole describe block.
  const patch = syntheticPatch(8, 120, 100, 58);

  it("is a synthetic changeset of roughly the 8 MiB limit", () => {
    const bytes = Buffer.byteLength(patch, "utf8");
    expect(bytes).toBeGreaterThan(0.9 * EDITOR_AGENT_CHANGESET_MAX_PATCH_BYTES);
    expect(bytes).toBeLessThanOrEqual(EDITOR_AGENT_CHANGESET_MAX_PATCH_BYTES);
  });

  it("mounts one bounded page of an 8 MiB review and keeps Apply and Reject exact", () => {
    const onApprove = vi.fn();
    const onDeny = vi.fn();
    const onRetry = vi.fn();
    const { container } = render(
      <ChangesetReviewPanel
        review={review(patch)}
        onApprove={onApprove}
        onDeny={onDeny}
        onRetry={onRetry}
      />,
    );

    expect(container.querySelectorAll("section section")).toHaveLength(1);
    expect(visibleRows(container)).toBeLessThanOrEqual(DIFF_WINDOW_PAGE_ROWS + 20);
    expect(screen.getByText(/This diff is large: 96,000 lines in 8 files/u)).toBeTruthy();
    expect(
      within(screen.getByRole("list", { name: "Files in this diff" })).getAllByRole("listitem"),
    ).toHaveLength(8);

    fireEvent.click(screen.getByRole("button", { name: "Apply change" }));
    expect(onApprove).toHaveBeenCalledTimes(1);
    expect(onDeny).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Reject change" }));
    expect(onDeny).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("keeps Apply and Reject disabled while a decision is confirmed, however large the diff", () => {
    render(
      <ChangesetReviewPanel
        review={review(patch, { deciding: true })}
        onApprove={vi.fn()}
        onDeny={vi.fn()}
        onRetry={vi.fn()}
      />,
    );
    expect(
      (screen.getByRole("button", { name: "Apply change" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Reject change" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("pages through the review without touching the decision callbacks", async () => {
    const onApprove = vi.fn();
    const onDeny = vi.fn();
    render(
      <ChangesetReviewPanel
        review={review(patch)}
        onApprove={onApprove}
        onDeny={onDeny}
        onRetry={vi.fn()}
      />,
    );
    await act(async () => {
      fireEvent.click(screen.getAllByRole("button", { name: "Next lines" })[0] as HTMLElement);
      await Promise.resolve();
    });
    expect(screen.getByRole("status").textContent).toContain("lines 1,001 to 2,000");
    expect(onApprove).not.toHaveBeenCalled();
    expect(onDeny).not.toHaveBeenCalled();
  });
});
