import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetClientDiagnosticWriter, setClientDiagnosticWriter } from "@/lib/client-diagnostics";
import { SafeMarkdown } from "./SafeMarkdown";
import { connectedScopeFingerprint } from "./hooks/workspaceScopeIdentity";
import {
  repositoryReferenceRootsForScopes,
  repositoryReferenceTextParts,
  sanitizeRepositoryEvidenceText,
} from "./repositoryReferences";

const scope = {
  kind: "workspace-root" as const,
  root: "/workspace",
  relativePaths: [],
  connectedAtMs: 1,
};
const roots = repositoryReferenceRootsForScopes([scope], scope.root);

afterEach(() => resetClientDiagnosticWriter());

function evidenceFor(path: string): Parameters<typeof SafeMarkdown>[0]["repositoryEvidence"] {
  return {
    citations: [
      {
        scopePath: path,
        sourceScopeFingerprint: connectedScopeFingerprint(scope),
        stableId: "source-1",
        sourceId: "1",
        lineRange: undefined,
        score: 1,
      },
    ],
    readPaths: [],
  };
}

describe("complete prose source filenames (#4406)", () => {
  it.each([
    ["The entry point — src/index.ts — wires the server.", "src/index.ts"],
    ["Geändert – src/index.ts:12", "src/index.ts"],
    ["Fixed the parser - src/parser.ts", "src/parser.ts"],
  ])("keeps a structured path after ordinary prose punctuation: %s", (source, path) => {
    for (const knownPaths of [[], [path]]) {
      expect(
        repositoryReferenceTextParts(source, knownPaths).flatMap((part) =>
          part.reference === undefined ? [] : [part.reference.path],
        ),
      ).toEqual([path]);
    }
    const open = vi.fn(() => ({ ok: true as const, windowId: "editor" }));
    render(<SafeMarkdown source={source} repositoryRoots={roots} openRepositoryReference={open} />);
    fireEvent.click(screen.getByRole("button"));
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ root: scope.root, path }));
  });

  it.each([
    [String.raw`docs\Release Notes.md`, "docs/Release Notes.md"],
    ["docs/Release Notes.md", String.raw`docs\Release Notes.md`],
    ["docs/Release Notes.md", "./docs/Release Notes.md"],
    ["./docs/Release Notes.md", "docs/Release Notes.md"],
    [String.raw`.\docs\Release Notes.md`, String.raw`.\docs\Release Notes.md`],
  ])("opens the complete canonical spelling %s from evidence %s", (source, knownPath) => {
    const path = "docs/Release Notes.md";
    expect(repositoryReferenceTextParts(source, [knownPath])).toEqual([
      { kind: "reference", reference: { label: source, path } },
    ]);
    const open = vi.fn(() => ({ ok: true as const, windowId: "editor" }));
    const diagnostic = vi.fn();
    setClientDiagnosticWriter(diagnostic);
    render(
      <SafeMarkdown
        source={`See ${source} for details.`}
        repositoryRoots={roots}
        repositoryEvidence={evidenceFor(knownPath)}
        openRepositoryReference={open}
      />,
    );
    fireEvent.click(screen.getByRole("button"));
    expect(open).toHaveBeenCalledExactlyOnceWith({ root: scope.root, path });
    expect(diagnostic).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        citationActivation: { reason: "matched", outcome: "opened", rootCount: 1, matchCount: 1 },
      }),
    );
  });

  it.each([
    "See DOCS/Release Notes.md for details.",
    "See docs/release Notes.md for details.",
    "See docs/Release notes.md for details.",
  ])("never substitutes a guessed basename for a differently cased known path: %s", (source) => {
    const knownPaths = ["docs/Release Notes.md"];
    const sanitized = sanitizeRepositoryEvidenceText(source, knownPaths);
    expect(
      repositoryReferenceTextParts(sanitized, knownPaths).filter(
        (part) => part.kind === "reference",
      ),
    ).toEqual([]);
    render(
      <SafeMarkdown
        source={source}
        repositoryRoots={roots}
        repositoryEvidence={evidenceFor("docs/Release Notes.md")}
        openRepositoryReference={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button")).toBeNull();
    expect(document.body).toHaveTextContent(source);
  });

  it.each(["Notes.md", "notes.md", "Release Notes.md", String.raw`private\Notes.md`])(
    "keeps a proper fragment of a known spaced path inert: %s",
    (fragment) => {
      const source = `See ${fragment} for details.`;
      const knownPaths = ["./docs/Release Notes.md"];
      expect(
        repositoryReferenceTextParts(source, knownPaths).filter(
          (part) => part.kind === "reference",
        ),
      ).toEqual([]);
      render(
        <SafeMarkdown
          source={source}
          repositoryRoots={roots}
          repositoryEvidence={evidenceFor(knownPaths[0] ?? "")}
          openRepositoryReference={vi.fn()}
        />,
      );
      expect(screen.queryByRole("button")).toBeNull();
    },
  );

  it("keeps exact known simple paths and explicit whole expressions selectable", () => {
    const knownPaths = ["docs/Release Notes.md", "Notes.md"];
    expect(repositoryReferenceTextParts("Fixed the parser - Notes.md", knownPaths)).toContainEqual({
      kind: "reference",
      reference: { label: "Notes.md", path: "Notes.md" },
    });
    expect(repositoryReferenceTextParts("See [Notes.md]", [knownPaths[0] ?? ""])).toContainEqual({
      kind: "reference",
      reference: { label: "Notes.md", path: "Notes.md" },
    });
    expect(repositoryReferenceTextParts("See @Notes.md", [knownPaths[0] ?? ""])).toContainEqual({
      kind: "reference",
      reference: { label: "@Notes.md", path: "Notes.md" },
    });
  });

  it("prefers the exact known spelling when differently cased evidence also exists", () => {
    const path = "docs/Release Notes.md";
    expect(repositoryReferenceTextParts(path, ["docs/release Notes.md", path])).toEqual([
      { kind: "reference", reference: { label: path, path } },
    ]);
  });

  it.each(["Pruefdaten - Gruesse.txt", "Prüfdaten  Grüße.txt", "docs/Release Notes.md"])(
    "opens the entire known source %s and records the existing attributed activation",
    (path) => {
      const open = vi.fn(() => ({ ok: true as const, windowId: "editor" }));
      const diagnostic = vi.fn();
      setClientDiagnosticWriter(diagnostic);
      render(
        <SafeMarkdown
          source={`[1] ${path}`}
          repositoryRoots={roots}
          repositoryEvidence={evidenceFor(path)}
          openRepositoryReference={open}
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: /Open .* in editor/ }));
      expect(open).toHaveBeenCalledExactlyOnceWith({ root: scope.root, path });
      expect(diagnostic).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          citationActivation: { reason: "matched", outcome: "opened", rootCount: 1, matchCount: 1 },
        }),
      );
      expect(JSON.stringify(diagnostic.mock.calls)).not.toContain(path);
    },
  );

  it("keeps legacy prose boundaries when no complete path is known", () => {
    for (const source of ["Fixed the parser - parser.ts", "See Release Notes.md for details."]) {
      const path = source.includes("parser") ? "parser.ts" : "Notes.md";
      expect(repositoryReferenceTextParts(source)).toContainEqual({
        kind: "reference",
        reference: { label: path, path },
      });
    }
    expect(repositoryReferenceTextParts("See [Release Notes.md] for details.")).toContainEqual({
      kind: "reference",
      reference: { label: "Release Notes.md", path: "Release Notes.md" },
    });
  });

  it("keeps inline commands unchanged when evidence contains a spaced filename", () => {
    render(
      <SafeMarkdown
        source="`cat Release Notes.md`"
        repositoryRoots={roots}
        repositoryEvidence={evidenceFor("Release Notes.md")}
        openRepositoryReference={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button")).toBeNull();
    expect(document.querySelector("code")).toHaveTextContent("cat Release Notes.md");
  });

  it("recomputes known paths when evidence arrives for an unchanged text node", () => {
    const open = vi.fn(() => ({ ok: true as const, windowId: "editor" }));
    const source = "[1] Pruefdaten - Gruesse.txt";
    const props = { source, repositoryRoots: roots, openRepositoryReference: open };
    const view = render(<SafeMarkdown {...props} />);
    expect(screen.getByRole("button", { name: /Open Gruesse.txt in editor/ })).toBeInTheDocument();
    view.rerender(
      <SafeMarkdown {...props} repositoryEvidence={evidenceFor("Pruefdaten - Gruesse.txt")} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Open .* in editor/ }));
    expect(open).toHaveBeenCalledExactlyOnceWith({
      root: scope.root,
      path: "Pruefdaten - Gruesse.txt",
    });
  });

  it("does not grant a known suffix through an absolute, traversal or longer path", () => {
    for (const prefix of ["/", "../", "C:/", "private/"]) {
      const source = `${prefix}Release Notes.md`;
      const parsed = repositoryReferenceTextParts(source, ["Release Notes.md"]);
      expect(parsed.every((part) => part.kind === "text")).toBe(true);
    }
  });

  it.each([
    "../Release Notes.md",
    "/Release Notes.md",
    "C:/Release Notes.md",
    "$HOME/Release Notes.md",
    "Release\u202e Notes.md",
  ])("does not trust an unsafe complete evidence path %s", (path) => {
    expect(repositoryReferenceTextParts(path, [path]).every((part) => part.kind === "text")).toBe(
      true,
    );
  });

  it("preserves known filename spacing through evidence sanitization", () => {
    const path = "Prüfdaten  Grüße.txt";
    expect(sanitizeRepositoryEvidenceText(`[1] ${path}`, [path])).toBe(`[1] ${path}`);
  });

  it.each([
    "Release - Notes.mdExtra.ts",
    "Release - Notes.mdExtra.ts:1-2",
    "Release - Notes.mdREADME.md",
    "Release - Notes.md.foo.ts",
    "Release - Notes.md/Extra.ts",
    String.raw`Release - Notes.md\Extra.ts`,
    "Release - Notes.md-Extra.ts",
    "Release - Notes.md_Extra.ts",
    "Release - Notes.md@Extra.ts",
    "Release - Notes.md:12Extra.ts",
    "README.mdRelease - Notes.md",
    "README.md/Release - Notes.md",
  ])("does not invent a reference at a rejected known-path boundary: %s", (source) => {
    const path = "Release - Notes.md";
    const sanitized = sanitizeRepositoryEvidenceText(source, [path]);
    expect(sanitized).toBe(source);
    expect(
      repositoryReferenceTextParts(sanitized, [path]).filter((part) => part.kind === "reference"),
    ).toEqual([]);
    render(
      <SafeMarkdown
        source={source}
        repositoryRoots={roots}
        repositoryEvidence={evidenceFor(path)}
        openRepositoryReference={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button")).toBeNull();
    expect(document.body).toHaveTextContent(source);
  });

  it("keeps real neighboring references around a rejected known-path boundary", () => {
    const source = "README.md; Release - Notes.mdExtra.ts; see CONTRIBUTING.md.";
    const parts = repositoryReferenceTextParts(source, ["Release - Notes.md"]);
    expect(
      parts.flatMap((part) => (part.reference === undefined ? [] : [part.reference.path])),
    ).toEqual(["README.md", "CONTRIBUTING.md"]);
    expect(parts.map((part) => part.reference?.label ?? part.text ?? "").join("")).toBe(source);
  });

  it("preserves a bracketed source identity through known-path sanitization and parsing", () => {
    const source = "[source:2|Release  Notes.md]";
    const knownPaths = ["Release  Notes.md"];
    expect(sanitizeRepositoryEvidenceText(source, knownPaths)).toBe(source);
    expect(repositoryReferenceTextParts(source, knownPaths)).toEqual([
      {
        kind: "reference",
        reference: {
          label: "source:2|Release  Notes.md",
          path: "Release  Notes.md",
          sourceId: "2",
        },
      },
    ]);
  });

  it("does not silently attribute a qualified source to another source with the same path", () => {
    const open = vi.fn(() => ({ ok: true as const, windowId: "editor" }));
    render(
      <SafeMarkdown
        source="[source:2|Release Notes.md]"
        repositoryRoots={roots}
        repositoryEvidence={evidenceFor("Release Notes.md")}
        openRepositoryReference={open}
      />,
    );
    fireEvent.click(screen.getByRole("button"));
    expect(open).not.toHaveBeenCalled();
  });

  it.each([
    "[source:0|Release Notes.md]",
    "[../private.txt, Release Notes.md]",
    String.raw`C:\Release Notes.md`,
    String.raw`\\server\share\Release Notes.md`,
    String.raw`private\Release Notes.md`,
    String.raw`Release Notes.md\evil.txt`,
  ])("does not turn an invalid complete expression into a known suffix: %s", (source) => {
    expect(
      repositoryReferenceTextParts(source, ["Release Notes.md"]).every(
        (part) => part.kind === "text",
      ),
    ).toBe(true);
    const open = vi.fn();
    render(
      <SafeMarkdown
        source={source}
        repositoryRoots={roots}
        repositoryEvidence={evidenceFor("Release Notes.md")}
        openRepositoryReference={open}
      />,
    );
    expect(screen.queryByRole("button")).toBeNull();
    expect(open).not.toHaveBeenCalled();
  });
});
