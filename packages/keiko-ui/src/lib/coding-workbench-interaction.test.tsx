import { cleanup, fireEvent, render } from "@testing-library/react";
import type { MouseEvent } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { resetClientDiagnosticWriter, setClientDiagnosticWriter } from "./client-diagnostics";
import { reportCodingWorkbenchSummaryActivated } from "./coding-workbench-interaction";

afterEach(() => {
  cleanup();
  resetClientDiagnosticWriter();
});

function activate(
  summary: HTMLElement | null,
  writer: ReturnType<typeof vi.fn>,
): readonly unknown[][] {
  if (summary === null) throw new Error("summary missing");
  fireEvent.click(summary);
  return writer.mock.calls;
}

describe("reportCodingWorkbenchSummaryActivated", () => {
  const report = (event: MouseEvent<HTMLElement>): void => {
    reportCodingWorkbenchSummaryActivated("plan", event);
  };

  it("reports the state the reader's activation leads to", () => {
    const writer = vi.fn();
    setClientDiagnosticWriter(writer);
    const { container } = render(
      <details open>
        <summary onClick={report}>Plan</summary>
      </details>,
    );
    expect(activate(container.querySelector("summary"), writer)).toEqual([
      [
        "[keiko] coding workbench interaction: details-toggled",
        {
          codingWorkbenchInteraction: {
            interaction: "details-toggled",
            section: "plan",
            expanded: false,
          },
          correlationId: undefined,
        },
      ],
    ]);
  });

  it("reports nothing when the activation was cancelled and the disclosure stays as it is", () => {
    const writer = vi.fn();
    setClientDiagnosticWriter(writer);
    const { container } = render(
      <details>
        <summary
          onClick={(event) => {
            event.preventDefault();
            report(event);
          }}
        >
          Plan
        </summary>
      </details>,
    );
    expect(activate(container.querySelector("summary"), writer)).toEqual([]);
  });

  it("reports nothing for an element that does not control a disclosure", () => {
    const writer = vi.fn();
    setClientDiagnosticWriter(writer);
    const { container } = render(
      <div>
        <button type="button" onClick={report}>
          Plan
        </button>
      </div>,
    );
    expect(activate(container.querySelector("button"), writer)).toEqual([]);
  });
});
