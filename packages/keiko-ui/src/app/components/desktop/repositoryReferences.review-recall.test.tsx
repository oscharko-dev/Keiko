import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  RepositoryReferenceInline,
  consumeRepositoryReferenceLineSuffix,
  parseExactRepositoryReference,
  repositoryReferencePathLabels,
  repositoryReferenceTextParts,
} from "./repositoryReferences";

describe("explicit repository reference recall", () => {
  it.each(["src/a.ts: 12", "src/a.ts: 12 - 14"])(
    "retains ordinary spacing within a closed reference: %s",
    (text) => {
      expect(parseExactRepositoryReference(text)).toMatchObject({
        path: "src/a.ts",
        lineStart: 12,
      });
      expect(repositoryReferenceTextParts(`[${text}]`)).toMatchObject([
        { kind: "reference", reference: { path: "src/a.ts", lineStart: 12 } },
      ]);
    },
  );
  it.each(["app/routes/$userId.tsx", "src/Outer$Inner.java", "src/file~.ts", "src/file^.ts"])(
    "keeps real metacharacter filenames in explicit citations: %s",
    (path) => {
      expect(parseExactRepositoryReference(`${path}:12`)).toMatchObject({ path, lineStart: 12 });
      expect(repositoryReferenceTextParts(`[${path}:12]`)).toMatchObject([
        { kind: "reference", reference: { path, lineStart: 12 } },
      ]);
    },
  );
  it.each([": ", "- ", "– "])(
    "keeps a numeric reference before tight explanatory punctuation %j",
    (separator) => {
      const tail = `:12${separator}describes this function`;
      expect(consumeRepositoryReferenceLineSuffix("src/a.ts", tail)?.reference).toMatchObject({
        path: "src/a.ts",
        lineStart: 12,
      });
      expect(repositoryReferenceTextParts(`src/a.ts${tail}`)).toMatchObject([
        { kind: "reference", reference: { path: "src/a.ts", lineStart: 12 } },
        { kind: "text", text: `${separator}describes this function` },
      ]);
    },
  );
});

describe("repository reference choice presentation", () => {
  it("includes each visible unique-root suffix in its accessible choice name", () => {
    render(
      <RepositoryReferenceInline
        reference={{ path: "src/a.ts", label: "src/a.ts" }}
        roots={[
          { root: "/work/project", label: "Project" },
          { root: "/work/other", label: "Other" },
        ]}
        openReference={vi.fn(() => ({ ok: true as const, windowId: "editor" }))}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Open src/a.ts in editor" }));
    const project = screen.getByRole("button", {
      name: "Select repository source: Project · work/project",
    });
    expect(project).toHaveTextContent("Project");
    expect(project.querySelector(".repo-ref-root-path")).toHaveTextContent("work/project");
    expect(
      screen.getByRole("button", { name: "Select repository source: Other · work/other" }),
    ).toBeVisible();
  });

  it("omits a redundant suffix from both the visible and accessible root choice", () => {
    render(
      <RepositoryReferenceInline
        reference={{ path: "src/a.ts", label: "src/a.ts" }}
        roots={[
          { root: "/alpha", label: "alpha" },
          { root: "/beta", label: "beta" },
        ]}
        openReference={vi.fn(() => ({ ok: true as const, windowId: "editor" }))}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Open src/a.ts in editor" }));
    const alpha = screen.getByRole("button", { name: "Select repository source: alpha" });
    expect(alpha).toHaveTextContent(/^alpha$/);
    expect(alpha.querySelector(".repo-ref-root-path")).toBeNull();
  });

  it("visibly distinguishes roots with identical short suffixes", () => {
    render(
      <RepositoryReferenceInline
        reference={{ path: "src/a.ts", label: "src/a.ts" }}
        roots={[
          { root: "/alpha/shared/app", label: "app" },
          { root: "/beta/shared/app", label: "app" },
        ]}
        openReference={vi.fn(() => ({ ok: true as const, windowId: "editor" }))}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Open src/a.ts in editor" }));
    const first = screen.getByRole("button", {
      name: "Select repository source: app · /alpha/shared/app",
    });
    const second = screen.getByRole("button", {
      name: "Select repository source: app · /beta/shared/app",
    });
    expect(first).toHaveTextContent("/alpha/shared/app");
    expect(second).toHaveTextContent("/beta/shared/app");
    expect(first.textContent).not.toBe(second.textContent);
  });
  it("does not repeat a unique filename after removing unsafe display controls", () => {
    const path = "alpha/policy\u202e.ts";
    render(
      <RepositoryReferenceInline
        reference={{ path, label: path }}
        displayPath={repositoryReferencePathLabels([path]).get(path)}
        roots={[{ root: "/workspace", label: "workspace" }]}
        openReference={vi.fn(() => ({ ok: true as const, windowId: "editor" }))}
      />,
    );
    expect(screen.getByRole("button")).toHaveAccessibleName("Open alpha/policy.ts in editor");
  });
});
