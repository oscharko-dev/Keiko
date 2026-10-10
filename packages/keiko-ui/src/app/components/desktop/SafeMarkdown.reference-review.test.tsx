import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("./repositoryReferences", async (original) => {
  const actual = await original<typeof import("./repositoryReferences")>();
  return { ...actual, repositoryReferenceTextParts: vi.fn(actual.repositoryReferenceTextParts) };
});
import {
  repositoryReferenceTextParts,
  repositoryReferenceRootsForScopes,
} from "./repositoryReferences";
import { connectedScopeFingerprint } from "./hooks/workspaceScopeIdentity";
import { SafeMarkdown } from "./SafeMarkdown";
const roots = [{ root: "/workspace", label: "Workspace" }];
afterEach(() => vi.clearAllMocks());

describe("Markdown source boundaries", () => {
  it("opens a literal bracket path from an inline-code citation", () => {
    const open = vi.fn(() => ({ ok: true as const, windowId: "editor" }));
    render(
      <SafeMarkdown
        source="`app/users/[id]/page.tsx:180–182`"
        repositoryRoots={roots}
        openRepositoryReference={open}
      />,
    );
    fireEvent.click(screen.getByRole("button"));
    expect(open).toHaveBeenCalledExactlyOnceWith({
      root: "/workspace",
      path: "app/users/[id]/page.tsx",
      lineStart: 180,
      lineEnd: 182,
    });
  });
  it.each([
    "/private/[id]/page.tsx",
    "C:/private/[id]/page.tsx",
    "../[id]/page.tsx",
    "app/../[id]/page.tsx",
    "app/[\u202eid]/page.tsx",
    "app/[\u0001id]/page.tsx",
  ])("keeps an unsafe bracket path inert inside inline code: %s", (path) => {
    const open = vi.fn();
    render(
      <SafeMarkdown
        source={`\`${path}:180–182\``}
        repositoryRoots={roots}
        openRepositoryReference={open}
      />,
    );
    expect(screen.queryByRole("button")).toBeNull();
    expect(open).not.toHaveBeenCalled();
  });
  it("uses the persisted source identity for duplicate literal bracket paths", () => {
    const path = "app/users/[id]/page.tsx";
    const scopes = ["/workspace/alpha", "/workspace/beta"].map((root) => ({
      kind: "workspace-root" as const,
      root,
      relativePaths: [],
      connectedAtMs: 1,
    }));
    const open = vi.fn(() => ({ ok: true as const, windowId: "editor" }));
    render(
      <SafeMarkdown
        source={`\`source:2|${path}:180–182\``}
        repositoryRoots={repositoryReferenceRootsForScopes(scopes, scopes[0]?.root ?? "")}
        openRepositoryReference={open}
        repositoryEvidence={{
          citations: scopes.map((scope, index) => ({
            scopePath: path,
            sourceId: String(index + 1),
            lineRange: { startLine: 180, endLine: 182 },
            stableId: `atom-${String(index)}`,
            score: 1,
            sourceScopeFingerprint: connectedScopeFingerprint(scope),
          })),
          readPaths: [],
        }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Cited evidence/ }));
    expect(open).toHaveBeenCalledExactlyOnceWith({
      root: "/workspace/beta",
      path,
      lineStart: 180,
      lineEnd: 182,
    });
  });
  const explicitLocations = {
    code: (location: string): string => `\`${location}\``,
    brackets: (location: string): string => `[${location}]`,
    table: (location: string): string => `| Location |\n|---|\n| ${location} |`,
  };
  describe.each(Object.entries(explicitLocations))("%s explicit references", (_name, format) => {
    it.each([
      "$HOME/src/a.ts",
      "$GITHUB_WORKSPACE/packages/x/package.json",
      "$(pwd)/a.json",
      "${ROOT}/a.ts",
    ])("does not turn the shell expression %s into a repository target", (path) => {
      const open = vi.fn();
      render(
        <SafeMarkdown
          source={format(`${path}:12`)}
          repositoryRoots={roots}
          openRepositoryReference={open}
        />,
      );
      expect(screen.queryByRole("button")).toBeNull();
      expect(document.body).toHaveTextContent(path);
      expect(open).not.toHaveBeenCalled();
    });
    it.each(["app/routes/$userId.tsx", "src/Outer$Inner.java", "manuals/$archive/chapter.md"])(
      "keeps the actual later-segment dollar filename %s",
      (path) => {
        const open = vi.fn(() => ({ ok: true as const, windowId: "editor" }));
        render(
          <SafeMarkdown
            source={format(`${path}:12`)}
            repositoryRoots={roots}
            openRepositoryReference={open}
          />,
        );
        fireEvent.click(screen.getByRole("button"));
        expect(open).toHaveBeenCalledExactlyOnceWith({
          root: "/workspace",
          path,
          lineStart: 12,
          lineEnd: 12,
        });
      },
    );
  });
  it.each(["cat README.md", "git add package.json", "node scripts/build.mjs", "node server.js"])(
    "preserves an inline command as literal code: %s",
    (command) => {
      render(
        <SafeMarkdown
          source={`\`${command}\``}
          repositoryRoots={roots}
          openRepositoryReference={vi.fn()}
        />,
      );
      expect(screen.queryByRole("button")).toBeNull();
      expect(document.querySelector("code")).toHaveTextContent(command);
    },
  );
  it("keeps table prose visible and opens only its actual path", () => {
    const open = vi.fn(() => ({ ok: true as const, windowId: "editor" }));
    render(
      <SafeMarkdown
        source={"| Location |\n|---|\n| Defined in src/config.ts:12 |"}
        repositoryRoots={roots}
        openRepositoryReference={open}
      />,
    );
    expect(screen.getByRole("cell")).toHaveTextContent("Defined in");
    fireEvent.click(
      screen.getByRole("button", { name: "Open src/config.ts at line 12 in editor" }),
    );
    expect(open).toHaveBeenCalledWith({
      root: "/workspace",
      path: "src/config.ts",
      lineStart: 12,
      lineEnd: 12,
    });
  });
  it("retains two separate source locations in one table cell", () => {
    render(
      <SafeMarkdown
        source={"| Location |\n|---|\n| src/a.ts:1, src/b.ts:2 |"}
        repositoryRoots={roots}
        openRepositoryReference={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Open src/a.ts at line 1 in editor" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Open src/b.ts at line 2 in editor" })).toBeVisible();
  });
});

describe("repository parsing work", () => {
  it.each([false, true])(
    "skips path-label discovery without an opener (literal %s)",
    (literalUserInput) => {
      render(<SafeMarkdown source="Look at src/a.ts:12" literalUserInput={literalUserInput} />);
      expect(repositoryReferenceTextParts).not.toHaveBeenCalled();
    },
  );
  it("parses a text node once for both labels and rendering", () => {
    render(
      <SafeMarkdown
        source="Look at src/a.ts:12"
        repositoryRoots={roots}
        openRepositoryReference={vi.fn()}
      />,
    );
    expect(repositoryReferenceTextParts).toHaveBeenCalledExactlyOnceWith("Look at src/a.ts:12");
  });
});
