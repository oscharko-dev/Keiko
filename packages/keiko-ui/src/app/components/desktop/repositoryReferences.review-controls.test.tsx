import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RepositoryReferenceInline,
  repositoryReferenceTextParts,
  type OpenRepositoryReference,
} from "./repositoryReferences";

const roots = [
  { root: "/alpha/repo", label: "alpha" },
  { root: "/beta/repo", label: "beta" },
];
const reference = { path: "src/a.ts", label: "src/a.ts" };
const singleRoot = { root: "/alpha/repo", label: "alpha" };

function renderPicker(openReference: OpenRepositoryReference): HTMLButtonElement {
  render(
    <RepositoryReferenceInline reference={reference} roots={roots} openReference={openReference} />,
  );
  const trigger = screen.getByRole<HTMLButtonElement>("button", {
    name: "Open src/a.ts in editor",
  });
  fireEvent.click(trigger);
  return trigger;
}

function renderParsed(source: string, openReference: OpenRepositoryReference): void {
  render(
    <>
      {repositoryReferenceTextParts(source).map((part, index) =>
        part.reference === undefined ? (
          <span key={index}>{part.text}</span>
        ) : (
          <RepositoryReferenceInline
            key={index}
            reference={part.reference}
            roots={[singleRoot]}
            openReference={openReference}
          />
        ),
      )}
    </>,
  );
}

describe("lossless repository reference boundaries", () => {
  it.each([
    "$HOME/src/a.ts",
    "$GITHUB_WORKSPACE/packages/x/package.json",
    "${ROOT}/a.ts",
    "$file.ts",
    "a+b.ts",
    "c++build.ts",
    "~/x.ts",
    "file.ts~",
    "^file.ts",
    "`$file.ts`",
  ])("does not invent a clickable suffix of %s", (source) => {
    const openReference = vi.fn<OpenRepositoryReference>();
    renderParsed(source, openReference);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.getByText(source)).toBeVisible();
    expect(openReference).not.toHaveBeenCalled();
  });

  it.each([
    ["Meeting Notes.md:3-9", { path: "Meeting Notes.md", lineStart: 3, lineEnd: 9 }],
    ["My Docs/a.ts:12", { path: "My Docs/a.ts", lineStart: 12, lineEnd: 12 }],
    ["report (final).md", { path: "report (final).md" }],
    ["Release Notes.md", { path: "Release Notes.md" }],
  ] as const)("opens the complete explicit spaced bracket path %s", (contents, request) => {
    const openReference = vi.fn<OpenRepositoryReference>(() => ({
      ok: true,
      windowId: "editor",
    }));
    renderParsed(`[${contents}]`, openReference);
    fireEvent.click(screen.getByRole("button"));
    expect(openReference).toHaveBeenCalledWith({ root: "/alpha/repo", ...request });
  });

  it("retains complete spaced paths in the existing comma citation grammar", () => {
    const openReference = vi.fn<OpenRepositoryReference>(() => ({ ok: true, windowId: "editor" }));
    renderParsed("[Meeting Notes.md:3-9, My Docs/a.ts:12]", openReference);
    screen.getAllByRole("button").forEach((button) => fireEvent.click(button));
    expect(openReference.mock.calls).toEqual([
      [{ root: "/alpha/repo", path: "Meeting Notes.md", lineStart: 3, lineEnd: 9 }],
      [{ root: "/alpha/repo", path: "My Docs/a.ts", lineStart: 12, lineEnd: 12 }],
    ]);
  });
});

describe("repository source picker lifecycle", () => {
  afterEach(() => vi.useRealTimers());

  it("does not let an old opened timer close a reopened picker", () => {
    vi.useFakeTimers();
    const trigger = renderPicker(() => ({ ok: true, windowId: "editor" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Select repository source: alpha · alpha/repo" }),
    );
    expect(trigger).toHaveAttribute("data-state", "opened");
    fireEvent.click(trigger);
    act(() => vi.advanceTimersByTime(1800));
    expect(trigger).toHaveAttribute("data-state", "choosing");
    expect(
      screen.getByRole("button", { name: "Select repository source: beta · beta/repo" }),
    ).toBeVisible();
  });

  it.each([
    { ok: true, key: "{Enter}" },
    { ok: true, key: " " },
    { ok: false, key: "{Enter}" },
    { ok: false, key: " " },
  ])("restores keyboard source selection to its trigger ($ok, $key)", async ({ ok, key }) => {
    const openReference = vi.fn<OpenRepositoryReference>(() =>
      ok ? { ok: true, windowId: "editor" } : { ok: false, message: "Refused" },
    );
    const trigger = renderPicker(openReference);
    const source = screen.getByRole("button", {
      name: "Select repository source: beta · beta/repo",
    });
    source.focus();
    await userEvent.setup().keyboard(key);
    expect(trigger).toHaveFocus();
    expect(openReference).toHaveBeenCalledWith({ root: "/beta/repo", path: "src/a.ts" });
  });

  it("preserves focus moved by the navigation owner", () => {
    const outside = document.createElement("button");
    document.body.append(outside);
    try {
      renderPicker(() => {
        outside.focus();
        return { ok: true, windowId: "editor" };
      });
      const source = screen.getByRole("button", {
        name: "Select repository source: alpha · alpha/repo",
      });
      source.focus();
      fireEvent.click(source);
      expect(outside).toHaveFocus();
    } finally {
      outside.remove();
    }
  });

  it("consumes trigger Escape for an active picker but preserves idle parent Escape", () => {
    const parentKeyDown = vi.fn();
    const { container } = render(
      <RepositoryReferenceInline
        reference={reference}
        roots={roots}
        openReference={() => ({ ok: true, windowId: "editor" })}
      />,
    );
    const parent = container.parentElement;
    if (parent === null) throw new TypeError("The mounted reference requires its parent.");
    parent.addEventListener("keydown", parentKeyDown);
    try {
      const trigger = screen.getByRole("button");
      fireEvent.click(trigger);
      fireEvent.keyDown(trigger, { key: "Escape" });
      expect(trigger).toHaveAttribute("data-state", "idle");
      expect(parentKeyDown).not.toHaveBeenCalled();
      fireEvent.keyDown(trigger, { key: "Escape" });
      expect(parentKeyDown).toHaveBeenCalledOnce();
    } finally {
      parent.removeEventListener("keydown", parentKeyDown);
    }
  });
});

it.each([true, false])("preserves parent Escape after citation navigation settles (%s)", (ok) => {
  const parentKeyDown = vi.fn();
  const { container } = render(
    <RepositoryReferenceInline
      reference={reference}
      roots={[singleRoot]}
      openReference={() =>
        ok ? { ok: true, windowId: "editor" } : { ok: false, message: "Refused" }
      }
    />,
  );
  const parent = container.parentElement;
  if (parent === null) throw new TypeError("Missing mounted parent");
  parent.addEventListener("keydown", parentKeyDown);
  try {
    const trigger = screen.getByRole("button");
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("data-state", ok ? "opened" : "failed");
    const escaped = fireEvent.keyDown(trigger, { key: "Escape" });
    expect(escaped).toBe(true);
    expect(parentKeyDown).toHaveBeenCalledOnce();
    expect(trigger).toHaveAttribute("data-state", "idle");
  } finally {
    parent.removeEventListener("keydown", parentKeyDown);
  }
});
