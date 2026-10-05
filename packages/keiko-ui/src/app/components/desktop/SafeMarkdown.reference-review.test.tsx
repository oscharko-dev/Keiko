import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("./repositoryReferences", async (original) => {
  const actual = await original<typeof import("./repositoryReferences")>();
  return { ...actual, repositoryReferenceTextParts: vi.fn(actual.repositoryReferenceTextParts) };
});
import { repositoryReferenceTextParts } from "./repositoryReferences";
import { SafeMarkdown } from "./SafeMarkdown";
const roots = [{ root: "/workspace", label: "Workspace" }];
afterEach(() => vi.clearAllMocks());

describe("Markdown source boundaries", () => {
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
