// @vitest-environment jsdom
import "../../vitest.setup";

import { render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";

import { KeikoDiffEditor } from "./KeikoDiffEditor.js";
import { baseDiffProps } from "./test-harness.js";

// Minimal mock: only the accessible chrome matters here, so the fake renders a labelled region and
// never needs to drive onMount.
vi.mock("@monaco-editor/react", () => {
  const DiffEditorMock = (props: { options?: { ariaLabel?: string } }): ReactElement => (
    <div aria-label={props.options?.ariaLabel ?? "Diff"} data-testid="mock-diff" />
  );
  const EditorMock = (): ReactElement => <textarea />;
  return { DiffEditor: DiffEditorMock, Editor: EditorMock, default: EditorMock };
});

describe("KeikoDiffEditor accessibility", () => {
  it("exposes a polite change-summary status region by default", () => {
    render(<KeikoDiffEditor {...baseDiffProps()} />);
    const summary = screen.getByTestId("keiko-diff-summary");
    expect(summary).toHaveAttribute("role", "status");
    expect(summary).toHaveAttribute("aria-live", "polite");
  });

  it("flips the summary to an assertive alert when the runtime fails to load", () => {
    render(
      <KeikoDiffEditor
        {...baseDiffProps({ loadState: { status: "error", message: "boot failed" } })}
      />,
    );
    const summary = screen.getByTestId("keiko-diff-summary");
    expect(summary).toHaveAttribute("role", "alert");
    expect(summary).toHaveAttribute("aria-live", "assertive");
  });

  it("labels the changed-file list and the review toolbar", () => {
    render(<KeikoDiffEditor {...baseDiffProps()} />);
    expect(screen.getByTestId("keiko-diff-file-list")).toHaveAttribute(
      "aria-label",
      "Changed files",
    );
    expect(screen.getByRole("toolbar", { name: "Diff review actions" })).toBeInTheDocument();
  });

  it("marks the selected file with aria-current", () => {
    render(<KeikoDiffEditor {...baseDiffProps()} />);
    const selected = screen.getByRole("button", { name: /keiko:\/\/doc\/new\.ts/ });
    expect(selected).toHaveAttribute("aria-current", "true");
  });

  it("labels the diff editor with the reviewed file path for screen readers", () => {
    render(<KeikoDiffEditor {...baseDiffProps()} />);
    expect(screen.getByLabelText("Diff: keiko://doc/new.ts")).toBeInTheDocument();
  });

  it("does not place raw diff content in the summary (AC4)", () => {
    render(<KeikoDiffEditor {...baseDiffProps()} />);
    const summary = screen.getByTestId("keiko-diff-summary");
    // The summary reports counts and the file path/status only — never the patched source text.
    expect(summary).not.toHaveTextContent("export const a");
    expect(summary).toHaveTextContent("Reviewing 3 changed file(s)");
  });
});
