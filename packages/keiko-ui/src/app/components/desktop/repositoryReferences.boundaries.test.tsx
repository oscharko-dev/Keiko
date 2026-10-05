import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  RepositoryReferenceInline,
  consumeRepositoryReferenceLineSuffix,
  parseExactRepositoryReference,
  repositoryReferenceTextParts,
} from "./repositoryReferences";

describe("repository reference picker keyboard", () => {
  it("gives identically labelled roots distinct accessible choices and restores focus on Escape", () => {
    const { container } = render(
      <RepositoryReferenceInline
        reference={{ path: "src/a.ts", label: "src/a.ts" }}
        roots={[
          { root: "/alpha/shared/app", label: "app" },
          { root: "/beta/shared/app", label: "app" },
        ]}
        openReference={vi.fn(() => ({ ok: true as const, windowId: "editor" }))}
      />,
    );
    const trigger = screen.getByRole("button", { name: "Open src/a.ts in editor" });
    fireEvent.click(trigger);
    const second = screen.getByRole("button", {
      name: "Select repository source: app · /beta/shared/app",
    });
    expect(
      screen.getByRole("button", { name: "Select repository source: app · /alpha/shared/app" }),
    ).toBeVisible();
    expect(trigger.getAttribute("aria-controls")).toBe(second.parentElement?.id);
    second.focus();
    const parent = container.parentElement;
    expect(parent).not.toBeNull();
    const onParentKeyDown = vi.fn();
    parent?.addEventListener("keydown", onParentKeyDown);
    try {
      fireEvent.keyDown(second, { key: "Escape" });
      expect(onParentKeyDown).not.toHaveBeenCalled();
    } finally {
      parent?.removeEventListener("keydown", onParentKeyDown);
    }
    expect(second).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
});

describe("repository reference prose boundaries", () => {
  it.each([" - ", " – ", " — ", " : "])(
    "retains a complete line reference before explanatory punctuation %j",
    (separator) => {
      const suffix = `:12${separator}validates input`;
      expect(consumeRepositoryReferenceLineSuffix("src/a.ts", suffix)?.reference).toMatchObject({
        path: "src/a.ts",
        lineStart: 12,
      });
      expect(repositoryReferenceTextParts(`src/a.ts${suffix}`)).toMatchObject([
        { kind: "reference", reference: { path: "src/a.ts", lineStart: 12 } },
        { kind: "text", text: `${separator}validates input` },
      ]);
    },
  );

  it.each(["*.test.ts", "src/**/*.ts", "{name}.json", "{a,b}.ts", "$file.ts", '"file.ts"'])(
    "keeps filename patterns and expressions as code: %s",
    (text) => expect(parseExactRepositoryReference(text)).toBeNull(),
  );

  it.each(["<src/a.ts>", "key=src/a.ts", "|src/a.ts|", "->src/a.ts", "src/a.ts✅"])(
    "recognizes a reference beside prose symbols: %s",
    (text) => {
      expect(
        repositoryReferenceTextParts(text).filter((part) => part.kind === "reference"),
      ).toMatchObject([{ reference: { path: "src/a.ts" } }]);
    },
  );

  it.each([": 5 dependencies", ": 12 errors", ": 7 files"])(
    "does not consume a prose count as a code-span line suffix: %s",
    (suffix) => {
      expect(consumeRepositoryReferenceLineSuffix("package.json", suffix)).toBeUndefined();
      const parts = repositoryReferenceTextParts(`package.json${suffix}`);
      expect(
        parts.some((part) => part.kind === "reference" && part.reference?.lineStart !== undefined),
      ).toBe(false);
      expect(
        parts.map((part) => (part.kind === "text" ? part.text : part.reference?.label)).join(""),
      ).toBe(`package.json${suffix}`);
    },
  );

  it.each([":12-", ":12\u2011wrong", ":12 - 9007199254740992", ":12 : 13"])(
    "does not expose an incomplete or malformed numeric reference: %s",
    (suffix) => {
      expect(consumeRepositoryReferenceLineSuffix("src/a.ts", suffix)).toBeUndefined();
      expect(
        repositoryReferenceTextParts(`src/a.ts${suffix}`).every((part) => part.kind === "text"),
      ).toBe(true);
    },
  );
});
