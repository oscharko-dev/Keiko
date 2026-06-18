import { render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";

import { KeikoCodeEditor } from "./KeikoCodeEditor.js";
import { baseProps, dirtyFileModel } from "./test-harness.js";

// Minimal Monaco mock: only the accessible chrome matters for these assertions, so the fake just
// renders the labelled textarea and never needs to drive onMount.
vi.mock("@monaco-editor/react", () => {
  const EditorMock = (props: {
    value?: string;
    options?: { ariaLabel?: string; readOnly?: boolean };
  }): ReactElement => (
    <textarea
      aria-label={props.options?.ariaLabel ?? "Editor"}
      readOnly={props.options?.readOnly ?? true}
      value={props.value ?? ""}
      onChange={() => undefined}
    />
  );
  return { Editor: EditorMock, default: EditorMock };
});

describe("KeikoCodeEditor accessibility", () => {
  it("exposes a polite status region by default", () => {
    render(<KeikoCodeEditor {...baseProps()} />);
    const status = screen.getByTestId("keiko-editor-status");
    expect(status).toHaveAttribute("role", "status");
  });

  it("flips the status region to an assertive alert on a save error", () => {
    render(
      <KeikoCodeEditor
        {...baseProps({ saveStatus: "error", saveError: "disk full", fileModel: dirtyFileModel() })}
      />,
    );
    const region = screen.getByTestId("keiko-editor-status");
    expect(region).toHaveAttribute("role", "alert");
    expect(region).toHaveTextContent("disk full");
  });

  it("flips the status region to an alert on a save conflict", () => {
    render(
      <KeikoCodeEditor {...baseProps({ saveStatus: "conflict", fileModel: dirtyFileModel() })} />,
    );
    const region = screen.getByTestId("keiko-editor-status");
    expect(region).toHaveAttribute("role", "alert");
    expect(region).toHaveTextContent(/conflict/i);
  });

  it("surfaces a load failure as an assertive alert", () => {
    render(
      <KeikoCodeEditor
        {...baseProps({ loadState: { status: "error", message: "worker boot failed" } })}
      />,
    );
    const region = screen.getByTestId("keiko-editor-status");
    expect(region).toHaveAttribute("role", "alert");
    expect(region).toHaveTextContent("worker boot failed");
  });

  it("labels the editor with the file path for screen readers", () => {
    render(<KeikoCodeEditor {...baseProps()} />);
    expect(screen.getByLabelText("Editor: src/a.ts")).toBeInTheDocument();
  });
});
