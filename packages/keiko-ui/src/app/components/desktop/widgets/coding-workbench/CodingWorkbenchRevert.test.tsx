import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { describe, expect, it, vi } from "vitest";
import type { CodingWorkbenchRuntimeRevertState } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime-api";

import { translateCodingWorkbench } from "./coding-workbench-i18n";
import { DE_CODING_WORKBENCH_MESSAGES } from "./coding-workbench-i18n.de";
import { EN_CODING_WORKBENCH_MESSAGES } from "./coding-workbench-i18n.en";
import { CodingWorkbenchRevertBar } from "./CodingWorkbenchRevert";

const NEWEST: CodingWorkbenchRuntimeRevertState = {
  staged: false,
  fileCount: 3,
  additions: 12,
  deletions: 4,
};
const STAGED: CodingWorkbenchRuntimeRevertState = { ...NEWEST, staged: true };

function renderBar(
  revert: CodingWorkbenchRuntimeRevertState | null,
  options: { readonly busy?: boolean } = {},
): ReturnType<typeof vi.fn> & { readonly view: ReturnType<typeof render> } {
  const onRevert = vi.fn();
  const view = render(
    <CodingWorkbenchRevertBar revert={revert} busy={options.busy ?? false} onRevert={onRevert} />,
  );
  return Object.assign(onRevert, { view });
}

describe("CodingWorkbenchRevertBar", () => {
  it("renders nothing for a run that offers no undo", () => {
    const { view } = renderBar(null);

    expect(view.container).toBeEmptyDOMElement();
  });

  it("offers Undo with the counts of the newest turn, and nothing is sent before a confirmation", async () => {
    const onRevert = renderBar(NEWEST);

    expect(screen.getByRole("region", { name: "Last turn" })).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent(
      "The last turn changed 3 files (+12 / -4).",
    );
    await userEvent.click(screen.getByRole("button", { name: "Undo last turn" }));

    expect(onRevert).not.toHaveBeenCalled();
    expect(screen.getByRole("group", { name: /Undo the last turn\?/u })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Undo last turn" })).toBeNull();
  });

  it("names a single file in the singular", () => {
    renderBar({ ...NEWEST, fileCount: 1 });

    expect(screen.getByRole("status")).toHaveTextContent(
      "The last turn changed 1 file (+12 / -4).",
    );
  });

  it("puts focus on Cancel, so a stray Enter never rewrites the workspace", async () => {
    const onRevert = renderBar(NEWEST);
    await userEvent.click(screen.getByRole("button", { name: "Undo last turn" }));

    const cancel = screen.getByRole("button", { name: "Cancel" });
    expect(cancel).toHaveFocus();
    await userEvent.keyboard("{Enter}");

    expect(onRevert).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Undo last turn" })).toHaveFocus();
  });

  it("cancels with Escape from any control of the confirmation and returns focus to Undo", async () => {
    const onRevert = renderBar(NEWEST);
    await userEvent.click(screen.getByRole("button", { name: "Undo last turn" }));
    await userEvent.tab();
    expect(screen.getByRole("button", { name: "Confirm undo" })).toHaveFocus();

    await userEvent.keyboard("{Escape}");

    expect(onRevert).not.toHaveBeenCalled();
    expect(screen.queryByRole("group")).toBeNull();
    expect(screen.getByRole("button", { name: "Undo last turn" })).toHaveFocus();
  });

  it("sends exactly one undo once it is confirmed from the keyboard", async () => {
    const onRevert = renderBar(NEWEST);
    await userEvent.click(screen.getByRole("button", { name: "Undo last turn" }));
    await userEvent.tab();
    expect(screen.getByRole("button", { name: "Confirm undo" })).toHaveFocus();

    await userEvent.keyboard("{Enter}");

    expect(onRevert).toHaveBeenCalledExactlyOnceWith("undo");
    expect(screen.queryByRole("group")).toBeNull();
  });

  it("offers Restore, not Undo, while an undo is staged, and warns about the blocked new task", async () => {
    const onRevert = renderBar(STAGED);

    expect(screen.getByRole("status")).toHaveTextContent(
      "The last turn is undone: 3 files are back to their earlier content.",
    );
    expect(screen.getByRole("status")).toHaveTextContent("No new task starts in this run");
    expect(screen.queryByRole("button", { name: "Undo last turn" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Restore changes" }));
    expect(screen.getByRole("group", { name: /Restore the undone changes\?/u })).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Confirm restore" }));

    expect(onRevert).toHaveBeenCalledExactlyOnceWith("restore");
  });

  it("explains that a file edited since the undo is never overwritten", async () => {
    renderBar(STAGED);
    await userEvent.click(screen.getByRole("button", { name: "Restore changes" }));

    expect(screen.getByRole("group")).toHaveTextContent(
      "If you edited one of these files since the undo, nothing is overwritten",
    );
  });

  it("disables Undo and says why when the last turn changed no file", () => {
    renderBar({ ...NEWEST, fileCount: 0, additions: 0, deletions: 0 });

    expect(screen.getByRole("status")).toHaveTextContent("nothing to undo");
    expect(screen.getByRole("button", { name: "Undo last turn" })).toBeDisabled();
  });

  it("waits while a runtime mutation is in flight", async () => {
    const onRevert = renderBar(NEWEST, { busy: true });

    expect(screen.getByRole("status")).toHaveTextContent("Applying…");
    expect(screen.getByRole("button", { name: "Undo last turn" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Undo last turn" }));
    expect(onRevert).not.toHaveBeenCalled();
  });

  it("disables the confirmation while a mutation is in flight", async () => {
    const onRevert = vi.fn();
    const view = render(
      <CodingWorkbenchRevertBar revert={NEWEST} busy={false} onRevert={onRevert} />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Undo last turn" }));

    view.rerender(<CodingWorkbenchRevertBar revert={NEWEST} busy onRevert={onRevert} />);

    expect(screen.getByRole("button", { name: "Confirm undo" })).toBeDisabled();
  });

  it("drops a confirmation the server's answer has made obsolete instead of confirming another action", async () => {
    const onRevert = vi.fn();
    const view = render(
      <CodingWorkbenchRevertBar revert={NEWEST} busy={false} onRevert={onRevert} />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Undo last turn" }));

    view.rerender(<CodingWorkbenchRevertBar revert={STAGED} busy={false} onRevert={onRevert} />);

    expect(screen.queryByRole("group")).toBeNull();
    expect(screen.getByRole("button", { name: "Restore changes" })).toBeVisible();
    expect(onRevert).not.toHaveBeenCalled();
  });

  it("keeps Escape inside the confirmation, so it cannot close an enclosing surface", async () => {
    const outer = vi.fn();
    render(
      // eslint-disable-next-line jsx-a11y/no-static-element-interactions -- the wrapper only observes whether Escape escaped.
      <div onKeyDown={outer}>
        <CodingWorkbenchRevertBar revert={NEWEST} busy={false} onRevert={vi.fn()} />
      </div>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Undo last turn" }));
    outer.mockClear();

    fireEvent.keyDown(screen.getByRole("button", { name: "Cancel" }), { key: "Escape" });

    expect(outer).not.toHaveBeenCalled();
  });

  it.each([
    ["an undo that can be made", NEWEST],
    ["a staged undo", STAGED],
    ["a turn without changes", { ...NEWEST, fileCount: 0 }],
  ])("has no accessibility violations for %s", async (_name, revert) => {
    const { view } = renderBar(revert);
    expect(await axe(view.container)).toHaveNoViolations();
  });

  it("has no accessibility violations while a confirmation is open", async () => {
    const { view } = renderBar(NEWEST);
    await userEvent.click(screen.getByRole("button", { name: "Undo last turn" }));

    expect(await axe(view.container)).toHaveNoViolations();
  });
});

describe("revert strings", () => {
  const KEYS = Object.keys(EN_CODING_WORKBENCH_MESSAGES).filter((key) =>
    key.startsWith("codingWorkbench.revert."),
  ) as (keyof typeof EN_CODING_WORKBENCH_MESSAGES)[];

  it("are defined in German beside English, with the same placeholders", () => {
    expect(KEYS.length).toBeGreaterThan(10);
    for (const key of KEYS) {
      const english = EN_CODING_WORKBENCH_MESSAGES[key];
      const german = DE_CODING_WORKBENCH_MESSAGES[key];
      expect(german, key).not.toBe(english);
      expect(german.match(/\{\w+\}/gu)?.toSorted(), key).toEqual(
        english.match(/\{\w+\}/gu)?.toSorted(),
      );
    }
  });

  it("render the counts into the German sentence, singular and plural", () => {
    expect(
      translateCodingWorkbench("de", "codingWorkbench.revert.summary", {
        count: 3,
        additions: 12,
        deletions: 4,
      }),
    ).toBe("Der letzte Durchgang hat 3 Dateien geändert (+12 / -4).");
    expect(
      translateCodingWorkbench("de", "codingWorkbench.revert.summary.one", {
        count: 1,
        additions: 1,
        deletions: 0,
      }),
    ).toBe("Der letzte Durchgang hat 1 Datei geändert (+1 / -0).");
  });
});
