// SonarCloud S8786 remediation — regression coverage for the regex-safety fixes in
// repositoryReferences.tsx. Each vulnerable pattern here had super-linear (quadratic) worst-case
// behavior on adversarial, non-matching input because an unbounded quantifier was retried across
// every character offset (or overlapped with an adjacent quantified atom). The timing assertions
// pin the fixed, linear behavior; the equivalence assertions pin that ordinary valid/invalid inputs
// still parse identically to before.
//
// Adversarial-input sizes and budgets below are deliberately large (not just "big enough to be
// slow on the old code") so the assertions are decisive rather than a coin flip:
//   - The pre-fix (quadratic) implementation takes several SECONDS at these sizes — many times the
//     budget below, on any machine.
//   - The fixed (linear) implementation finishes in a small fraction of the budget — comfortable
//     headroom even on a slow/loaded CI runner.
// Both were verified directly against the pre-fix implementation before picking these numbers (see
// the file history / PR description for the measurements); a test that only clears its budget by a
// few percent proves nothing (a prior revision of these tests had exactly that problem).

import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  RepositoryReferenceInline,
  normalizeReferencePath,
  parseExactRepositoryReference,
  repositoryReferenceTextParts,
  repositoryReferencePathLabels,
  repositoryRootLabel,
  repositoryReferenceRootsForScopes,
  sanitizeRepositoryEvidenceText,
} from "./repositoryReferences";
import { connectedScopeFingerprint } from "./hooks/workspaceScopeIdentity";

import {
  resetClientDiagnosticWriter,
  setClientDiagnosticWriter,
  type ClientDiagnosticWriter,
} from "@/lib/client-diagnostics";

describe("current repository scope navigation identities", () => {
  it("retains all selected scope identities on one root and resolves a legacy project root", () => {
    const scopes = ["src", "manuals"].map((path) => ({
      kind: "directory" as const,
      relativePaths: [path],
      connectedAtMs: 1,
    }));
    const roots = repositoryReferenceRootsForScopes(scopes, "/repo");
    expect(roots).toHaveLength(1);
    expect(roots[0]).toMatchObject({ root: "/repo", label: "repo" });
    expect(roots[0]?.scopeFingerprints).toEqual(
      scopes.map((scope) => connectedScopeFingerprint({ ...scope, root: "/repo" })),
    );
    expect(new Set(roots[0]?.scopeFingerprints).size).toBe(2);
  });
});

describe("explicit repository source choice", () => {
  it("requires an accessible keyboard choice even when only one source remains", async () => {
    const user = userEvent.setup();
    const openReference = vi.fn(() => ({ ok: true as const, windowId: "source" }));
    render(
      <RepositoryReferenceInline
        reference={{ path: "manual/chapter.txt", label: "chapter.txt:9", lineStart: 9 }}
        roots={[{ root: "/repo/manual", label: "Manual" }]}
        sourceLabel={"Archived manual\u202e"}
        requireRootChoice
        openReference={openReference}
      />,
    );
    const trigger = screen.getByRole("button", {
      name: "Open Archived manual · manual/chapter.txt at line 9 in editor",
    });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    trigger.focus();
    await user.keyboard("{Enter}");
    expect(openReference).not.toHaveBeenCalled();
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    const option = screen.getByRole("button", { name: "Select repository source: Manual" });
    expect(option.parentElement).toHaveAttribute("id", trigger.getAttribute("aria-controls"));
    await user.tab();
    expect(option).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(trigger).toHaveFocus();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger).not.toHaveAttribute("aria-controls");
    expect(option).not.toBeInTheDocument();
    expect(openReference).not.toHaveBeenCalled();
    await user.keyboard("{Enter}");
    await user.tab();
    await user.keyboard("{Enter}");
    expect(openReference).toHaveBeenCalledExactlyOnceWith({
      root: "/repo/manual",
      path: "manual/chapter.txt",
      lineStart: 9,
    });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("dismisses a forced picker from the trigger without opening a source", async () => {
    const user = userEvent.setup();
    const openReference = vi.fn(() => ({ ok: true as const, windowId: "source" }));
    render(
      <RepositoryReferenceInline
        reference={{ path: "README.md", label: "README.md" }}
        roots={[{ root: "/repo", label: "Repo" }]}
        requireRootChoice
        openReference={openReference}
      />,
    );
    const trigger = screen.getByRole("button", { name: "Open README.md in editor" });
    trigger.focus();
    await user.keyboard(" ");
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    await user.keyboard("{Escape}");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger).toHaveFocus();
    expect(screen.queryByRole("button", { name: "Select repository source: Repo" })).toBeNull();
    expect(openReference).not.toHaveBeenCalled();
  });
});

describe("repository source path labels", () => {
  it("does not confuse encoded controls with literal glyphs or codepoint notation", () => {
    const paths = ["policy\u202e.ts", "policy.ts", "policy⟦U+202E⟧.ts", "tab\t.ts", "tab␉.ts"];
    const labels = repositoryReferencePathLabels(paths);
    expect(new Set(labels.values()).size).toBe(paths.length);
    for (const label of labels.values()) expect(label).not.toMatch(/[\u202e\t]/u);
  });

  it("compares safe visible suffixes and keeps the original navigation paths", () => {
    const paths = ["alpha/policy\u202e.ts", "beta/policy.ts"];
    const labels = repositoryReferencePathLabels(paths);
    const openReference = vi.fn().mockReturnValue({ ok: true, windowId: "source" });
    render(
      <>
        {paths.map((path) => (
          <RepositoryReferenceInline
            key={path}
            reference={{ path, label: path }}
            roots={[{ root: "/repo", label: "repo" }]}
            rootRelative
            displayPath={labels.get(path)}
            openReference={openReference}
          />
        ))}
      </>,
    );
    const first = screen.getByRole("button", { name: /alpha\/policy\.ts/u });
    const second = screen.getByRole("button", { name: /beta\/policy\.ts/u });
    expect(first).toHaveTextContent("alpha/policy.ts");
    expect(second).toHaveTextContent("beta/policy.ts");
    fireEvent.click(first);
    fireEvent.click(second);
    expect(openReference.mock.calls.map((call) => call[0])).toEqual(
      paths.map((path) => ({ root: "/repo", path })),
    );
  });

  it("visibly distinguishes identical safe paths without leaking controls or changing targets", () => {
    const paths = ["src/policy\u202e.ts", "src/policy.ts"];
    const labels = repositoryReferencePathLabels(paths);
    const openReference = vi.fn().mockReturnValue({ ok: true, windowId: "source" });
    const { container } = render(
      <>
        {paths.map((path) => (
          <RepositoryReferenceInline
            key={path}
            reference={{ path, label: path }}
            roots={[{ root: "/repo", label: "repo" }]}
            rootRelative
            displayPath={labels.get(path)}
            openReference={openReference}
          />
        ))}
      </>,
    );
    const buttons = screen.getAllByRole("button");
    expect(new Set(buttons.map((button) => button.textContent)).size).toBe(2);
    expect(buttons[0]).toHaveTextContent("src/policy⟦U+202E⟧.ts");
    expect(buttons[0]).toHaveAccessibleName(/U\+202E/u);
    expect(buttons[1]).toHaveTextContent("src/policy.ts");
    expect(container.innerHTML).not.toContain("\u202e");
    buttons.forEach((button) => fireEvent.click(button));
    expect(openReference.mock.calls.map((call) => call[0])).toEqual(
      paths.map((path) => ({ root: "/repo", path })),
    );
  });

  it("uses the shortest distinguishing suffix while keeping unique filenames short", () => {
    expect(
      repositoryReferencePathLabels([
        "packages/alpha/src/überprüfung.ts",
        "packages/beta/src/überprüfung.ts",
        "docs/unique manual.html",
        "packages/alpha/src/überprüfung.ts",
      ]),
    ).toEqual(
      new Map([
        ["packages/alpha/src/überprüfung.ts", "alpha/src/überprüfung.ts"],
        ["packages/beta/src/überprüfung.ts", "beta/src/überprüfung.ts"],
        ["docs/unique manual.html", "unique manual.html"],
      ]),
    );
  });

  it("preserves root files, nested suffix collisions, NFD spelling, and repeated paths", () => {
    const decomposed = "u\u0308ber.ts";
    expect(
      repositoryReferencePathLabels([
        "foo.ts",
        "src/foo.ts",
        `alpha/${decomposed}`,
        `beta/${decomposed}`,
        "foo.ts",
      ]),
    ).toEqual(
      new Map([
        ["foo.ts", "foo.ts"],
        ["src/foo.ts", "src/foo.ts"],
        [`alpha/${decomposed}`, `alpha/${decomposed}`],
        [`beta/${decomposed}`, `beta/${decomposed}`],
      ]),
    );
  });
});

describe("parseExactRepositoryReference / repositoryReferenceTextParts (S8786 regression)", () => {
  it.each(["chapters/conveyor.html", "文書/運転 手順.html"])(
    "keeps spaced source punctuation out of the actual path %s",
    (path) => {
      const text = `${path}\u202f:\u202f182`;
      expect(parseExactRepositoryReference(text, true)).toMatchObject({
        path,
        lineStart: 182,
        lineEnd: 182,
      });
      const parts = repositoryReferenceTextParts(path.includes(" ") ? `[${text}]` : text);
      expect(parts.filter((part) => part.kind === "reference")).toMatchObject([
        { reference: { path, lineStart: 182, lineEnd: 182 } },
      ]);
    },
  );

  it.each(["-", "\u2010", "\u2011", "\u2012", "\u2013", "\u2014", "\u2212"])(
    "links exact numeric ranges with separator %s without changing the filename",
    (separator) => {
      const text = `src/domain/shipping.ts:1${separator}6`;
      expect(parseExactRepositoryReference(text)).toEqual({
        label: text,
        path: "src/domain/shipping.ts",
        lineStart: 1,
        lineEnd: 6,
      });
      expect(repositoryReferenceTextParts(`[${text}]`)).toEqual([
        {
          kind: "reference",
          reference: { label: text, path: "src/domain/shipping.ts", lineStart: 1, lineEnd: 6 },
        },
      ]);
      expect(parseExactRepositoryReference(`src/part\u2011name.ts:1${separator}2`)?.path).toBe(
        "src/part\u2011name.ts",
      );
    },
  );

  it("rejects malformed and reversed typographic ranges instead of linking a partial endpoint", () => {
    for (const text of [
      "src/a.ts:0\u20112",
      "src/a.ts:9\u20112",
      "src/a.ts:1\u2011wrong",
      "src/a.ts:1\u20119007199254740992",
    ]) {
      expect(parseExactRepositoryReference(text)).toBeNull();
      expect(repositoryReferenceTextParts(text).every((part) => part.kind === "text")).toBe(true);
    }
  });
  it("completes within budget for a slash-run with no valid extension", () => {
    // The former `(?:segment\/)*segment` core let the star and the trailing atom both consume the
    // same characters; retried at every offset of a non-matching string this was O(n^2). At this
    // size the pre-fix implementation takes upwards of 20 SECONDS; the bounded, linear
    // implementation finishes in well under a second.
    const adversarial = "a/".repeat(60000);
    const start = Date.now();
    const parts = repositoryReferenceTextParts(adversarial);
    expect(Date.now() - start).toBeLessThan(5000);
    expect(parts).toEqual([{ kind: "text", text: adversarial }]);
  });

  it("completes within budget for a long extensionless run (no slashes at all)", () => {
    // Even without any "/" the trailing `+\.[ext]` atom alone was retried at every offset. At this
    // size the pre-fix implementation takes upwards of 30 SECONDS.
    const adversarial = "a".repeat(150000);
    const start = Date.now();
    const parts = repositoryReferenceTextParts(adversarial);
    expect(Date.now() - start).toBeLessThan(5000);
    expect(parts).toEqual([{ kind: "text", text: adversarial }]);
  });

  it("still parses representative valid references with capture groups intact", () => {
    expect(parseExactRepositoryReference("src/app/file.ts")).toEqual({
      label: "src/app/file.ts",
      path: "src/app/file.ts",
    });
    expect(parseExactRepositoryReference("src/app/file.ts:12")).toEqual({
      label: "src/app/file.ts:12",
      path: "src/app/file.ts",
      lineStart: 12,
      lineEnd: 12,
    });
    expect(parseExactRepositoryReference("src/app/file.ts:12-34")).toEqual({
      label: "src/app/file.ts:12-34",
      path: "src/app/file.ts",
      lineStart: 12,
      lineEnd: 34,
    });
  });

  it.each([
    "src/überprüfung/status.ts",
    "src/u\u0308berpru\u0308fung/status.ts",
    "Handbücher/Service Anleitung.html",
  ])("preserves the entire Unicode or spaced citation path %s", (path) => {
    const text = `Evidence [${path}:1-2].`;
    expect(parseExactRepositoryReference(`${path}:1-2`, true)).toMatchObject({
      path,
      lineStart: 1,
      lineEnd: 2,
    });
    expect(repositoryReferenceTextParts(text)).toEqual([
      { kind: "text", text: "Evidence " },
      { kind: "reference", reference: { label: `${path}:1-2`, path, lineStart: 1, lineEnd: 2 } },
      { kind: "text", text: "." },
    ]);
  });

  it.each([
    "/private/status.ts",
    "C:/private/status.ts",
    "../private/status.ts",
    "src/../private/status.ts",
    "src/\u0001private/status.ts",
    "src/\u202eprivate/status.ts",
  ])(
    "does not turn a fragment of an invalid bracketed path into a clickable reference: %s",
    (path) => {
      const text = `Evidence [${path}:1-2].`;
      expect(parseExactRepositoryReference(`${path}:1-2`)).toBeNull();
      expect(repositoryReferenceTextParts(text)).toEqual([{ kind: "text", text }]);
    },
  );

  it.each([",", ", ", ",  "])(
    "retains distinct line-numbered citations separated by %j",
    (separator) => {
      const parts = repositoryReferenceTextParts(`Evidence [a.ts:1${separator}b.ts:2].`);
      expect(
        parts.filter((part) => part.kind === "reference").map((part) => part.reference),
      ).toEqual([
        { label: "a.ts:1", path: "a.ts", lineStart: 1, lineEnd: 1 },
        { label: "b.ts:2", path: "b.ts", lineStart: 2, lineEnd: 2 },
      ]);
    },
  );

  it.each([
    "../a.ts:1, b.ts:2",
    "a.ts:1, /private/b.ts:2",
    "a.ts:1, src/\u202eb.ts:2",
    "../a.ts:1,b.ts:2",
    "a.ts:1,/private/b.ts:2",
    "a.ts:1,src/\u202eb.ts:2",
  ])("rejects every link in an invalid citation list: %s", (list) => {
    const source = `Evidence [${list}].`;
    expect(repositoryReferenceTextParts(source)).toEqual([{ kind: "text", text: source }]);
  });

  it.each(["manual/a,b.ts", "manual/a, b.ts"])(
    "keeps a comma inside citation filename %s",
    (path) => {
      const parts = repositoryReferenceTextParts(`Evidence [${path}:1].`);
      expect(
        parts.filter((part) => part.kind === "reference").map((part) => part.reference?.path),
      ).toEqual([path]);
    },
  );

  it("still rejects representative invalid references", () => {
    expect(parseExactRepositoryReference("not-a-path")).toBeNull();
    expect(parseExactRepositoryReference("../escape/file.ts")).toBeNull();
    expect(parseExactRepositoryReference("")).toBeNull();
  });

  it("still extracts an inline reference surrounded by text unchanged", () => {
    expect(repositoryReferenceTextParts("see @src/app/file.ts:1-4 for details")).toEqual([
      { kind: "text", text: "see " },
      {
        kind: "reference",
        reference: {
          label: "@src/app/file.ts:1-4",
          path: "src/app/file.ts",
          lineStart: 1,
          lineEnd: 4,
        },
      },
      { kind: "text", text: " for details" },
    ]);
  });

  it("recognizes an unusually deep, but real, repository path (depth bound headroom)", () => {
    // Path depth is bounded (unlike per-segment length, which is pinned to the real filesystem
    // NAME_MAX of 255) purely as an application-level ReDoS mitigation, so it must clear any
    // realistic nesting depth with room to spare — e.g. a pnpm `.pnpm` store, a Bazel sandbox path,
    // or a deeply nested vendor/cache tree. 71 levels deep (comfortably beyond any of those in
    // practice) must still resolve to a clickable reference, not silently degrade to plain text.
    const deepPath = `${Array.from({ length: 71 }, (_, i) => `dir${String(i)}`).join("/")}/file.ts`;
    expect(parseExactRepositoryReference(deepPath)).toEqual({
      label: deepPath,
      path: deepPath,
    });
    expect(repositoryReferenceTextParts(`see @${deepPath} please`)).toEqual([
      { kind: "text", text: "see " },
      {
        kind: "reference",
        reference: { label: `@${deepPath}`, path: deepPath },
      },
      { kind: "text", text: " please" },
    ]);
  });
});

describe("sanitizeRepositoryEvidenceText (S8786 regression)", () => {
  it("completes within budget for an unterminated [source: ...] label", () => {
    // `\s*` was redundant with (and overlapped) the following `[^\]]+`; with no closing bracket
    // the engine explored every way to split a long whitespace run between the two, which was
    // quadratic. At this size the pre-fix implementation takes upwards of 8 SECONDS.
    const adversarial = `[source:${" ".repeat(150000)}`;
    const start = Date.now();
    const result = sanitizeRepositoryEvidenceText(adversarial);
    expect(Date.now() - start).toBeLessThan(4000);
    // No closing "]" anywhere, so none of the bracket/label patterns match; only the trailing
    // whitespace-collapse pass (tidyEvidenceText) touches the text, collapsing the long run to " ".
    expect(result).toBe("[source: ");
  });

  it("still strips a [source: ...] label", () => {
    expect(sanitizeRepositoryEvidenceText("value [source: api] end")).toBe("value end");
  });

  it("still collapses a bracketed-then-repeated duplicate reference", () => {
    expect(
      sanitizeRepositoryEvidenceText("[src/app/file.ts:1-4] [source: api] src/app/file.ts:1-4"),
    ).toBe("src/app/file.ts:1-4");
  });

  it("still tidies extra whitespace before punctuation", () => {
    expect(sanitizeRepositoryEvidenceText("hello  ,   world  .")).toBe("hello, world.");
  });
});

describe("repositoryRootLabel (S8786 regression)", () => {
  it("completes within budget for a long slash run with no trailing match", () => {
    // The former `.replace(/\/+$/u, "")` had no start anchor, so a string that is almost all "/"
    // but does not end in one forces the engine to retry the trailing `+` scan from every offset.
    // At this size the pre-fix implementation takes upwards of 8 SECONDS.
    const adversarial = `${"/".repeat(150000)}a`;
    const start = Date.now();
    const result = repositoryRootLabel(adversarial);
    expect(Date.now() - start).toBeLessThan(4000);
    expect(result).toBe("a");
  });

  it("still converts backslashes and trims trailing slashes for the last path segment", () => {
    expect(repositoryRootLabel("C:\\repo\\project\\")).toBe("project");
    expect(repositoryRootLabel("/a/b///")).toBe("b");
    expect(repositoryRootLabel("solo")).toBe("solo");
  });
});

describe("normalizeReferencePath (S8786 regression)", () => {
  it("completes within budget for an interior slash run before a trailing one", () => {
    // A long interior run of "/" (not just a leading one) plus a trailing run reproduces the same
    // O(n^2) retry pattern in the trailing-slash strip even after the leading strip runs first. At
    // this size the pre-fix implementation takes upwards of 8 SECONDS.
    const adversarial = `a${"/".repeat(150000)}${"b".repeat(150000)}${"/".repeat(150000)}`;
    const start = Date.now();
    const result = normalizeReferencePath(adversarial);
    expect(Date.now() - start).toBeLessThan(4000);
    expect(result).toBe(`a${"/".repeat(150000)}${"b".repeat(150000)}`);
  });

  it("still normalizes separators and strips leading/trailing slashes", () => {
    expect(normalizeReferencePath("\\src\\a.ts\\")).toBe("src/a.ts");
    expect(normalizeReferencePath("/src/a.ts")).toBe("src/a.ts");
    expect(normalizeReferencePath("src/a.ts")).toBe("src/a.ts");
  });
});

// The "opened" confirmation returns to idle after 1.8 s. That timer used to be left pending on
// unmount: a test file finishing inside the delay let it fire after jsdom was torn down, React threw
// "window is not defined", and the required keiko-ui coverage job went red on #3573 — a pull request
// that had not touched this file.
describe("RepositoryReferenceInline opened-confirmation timer", () => {
  const reference = parseExactRepositoryReference("src/app.ts:12");
  const roots = [{ root: "/work/repo", label: "repo" }];
  const opened = (): { readonly ok: true; readonly windowId: string } => ({
    ok: true,
    windowId: "editor-1",
  });

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function renderOpened(): ReturnType<typeof render> {
    if (reference === null) throw new Error("expected a parsable repository reference");
    const view = render(
      <RepositoryReferenceInline reference={reference} roots={roots} openReference={opened} />,
    );
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByRole("button")).toHaveAttribute("data-state", "opened");
    return view;
  }

  it("leaves no pending timer behind when it unmounts inside the confirmation delay", () => {
    const view = renderOpened();
    expect(vi.getTimerCount()).toBe(1);

    view.unmount();

    expect(vi.getTimerCount()).toBe(0);
  });

  it("replaces the pending timer instead of stacking one per activation", () => {
    renderOpened();
    fireEvent.click(screen.getByRole("button"));

    expect(vi.getTimerCount()).toBe(1);
  });

  it("still returns to idle once the confirmation delay has passed", () => {
    renderOpened();

    act(() => {
      vi.advanceTimersByTime(1_800);
    });

    expect(screen.getByRole("button")).toHaveAttribute("data-state", "idle");
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("citation activation navigation evidence", () => {
  afterEach(resetClientDiagnosticWriter);
  it("records unavailable root refusal without opening or leaking target text", () => {
    const writer = vi.fn<ClientDiagnosticWriter>();
    setClientDiagnosticWriter(writer);
    const opened = vi.fn(() => ({ ok: true as const, windowId: "editor-1" }));
    render(
      <RepositoryReferenceInline
        reference={{ path: "private/file.ts", label: "private/file.ts" }}
        roots={[]}
        openReference={opened}
        citationActivation={{ reason: "absent", rootCount: 0, matchCount: 0 }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Open private\/file.ts/ }));
    expect(opened).not.toHaveBeenCalled();
    expect(writer).toHaveBeenCalledWith("[keiko] citation activation settled", {
      correlationId: expect.any(String),
      citationActivation: { reason: "absent", outcome: "refused", rootCount: 0, matchCount: 0 },
    });
    expect(JSON.stringify(writer.mock.calls)).not.toContain("private/file.ts");
  });
  it("does not invent citation attribution for ordinary inline file links", () => {
    const writer = vi.fn<ClientDiagnosticWriter>();
    setClientDiagnosticWriter(writer);
    const opened = vi.fn(() => ({ ok: true as const, windowId: "editor-1" }));
    render(
      <RepositoryReferenceInline
        reference={{ path: "src/file.ts", label: "src/file.ts" }}
        roots={[{ root: "/repo", label: "Repo" }]}
        openReference={opened}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Open src\/file.ts/ }));
    expect(opened).toHaveBeenCalledWith({ root: "/repo", path: "src/file.ts" });
    expect(writer).not.toHaveBeenCalled();
  });
});
