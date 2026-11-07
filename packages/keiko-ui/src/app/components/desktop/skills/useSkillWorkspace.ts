"use client";

import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type {
  MarkdownSkillDocument,
  MarkdownSkillMetadata,
} from "@oscharko-dev/keiko-contracts/bff-wire";
import { skillTextFits } from "./useMarkdownSkillAuthor";
import type { MarkdownSkillLibrary } from "./useMarkdownSkillLibrary";

/** One Markdown file open in the editor: a stored skill, or a new one not saved yet. */
export interface SkillDocument {
  /** The editor's document key: a new revision or a new draft opens a new document. */
  readonly key: string;
  /** The stored skill this text belongs to; undefined until a new skill is saved. */
  readonly stored: MarkdownSkillMetadata | undefined;
  readonly fileName: string;
  readonly saved: string;
  readonly text: string;
}

/** What the right-hand side shows: nothing yet, a file, or one of the two ways to draft one. */
type SkillWorkspaceView =
  | { readonly kind: "empty" }
  | { readonly kind: "document"; readonly document: SkillDocument }
  | { readonly kind: "author" }
  | { readonly kind: "propose" };

export interface SkillWorkspace {
  readonly view: SkillWorkspaceView;
  readonly dirty: boolean;
  readonly canSave: boolean;
  /** A change waits for the person to discard the unsaved text first. */
  readonly confirming: boolean;
  readonly open: (skill: MarkdownSkillMetadata) => void;
  readonly create: (text: string, fileName: string) => void;
  /** Stores an uploaded Markdown file and opens it. */
  readonly importFile: (file: File) => void;
  readonly show: (kind: "author" | "propose" | "empty") => void;
  readonly edit: (text: string) => void;
  readonly save: () => void;
  readonly discard: () => void;
  readonly keepEditing: () => void;
  /** Runs the action now, or after the person agreed to discard unsaved text. */
  readonly guard: (action: () => void) => void;
}

/** The first `# ` heading names a skill on the server; the file name only matters without one. */
export function skillHeading(text: string): string | undefined {
  const line = text.split("\n").find((entry) => entry.startsWith("# "));
  const heading = line?.slice(2).trim();
  return heading === undefined || heading.length === 0 ? undefined : heading;
}

function newFileName(text: string, fallback: string): string {
  const slug = (skillHeading(text) ?? "")
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 60);
  return slug.length > 0 ? `${slug.toLowerCase()}.md` : fallback;
}

type Expectation =
  | { readonly kind: "open"; readonly id: string; readonly key: string }
  | { readonly kind: "import"; readonly key: string }
  | { readonly kind: "save"; readonly key: string; readonly sent: string };

type SetView = Dispatch<SetStateAction<SkillWorkspaceView>>;

function storedDocument(
  key: string,
  preview: MarkdownSkillDocument,
  text: string,
): SkillWorkspaceView {
  return {
    kind: "document",
    document: {
      key,
      stored: preview,
      fileName: newFileName(preview.body, "skill.md"),
      saved: preview.body,
      text,
    },
  };
}

/**
 * Applies a stored file that arrived for an expectation. An opened or imported file starts its
 * document. A save only confirms the saved baseline of the document that asked for it, and keeps
 * whatever the person typed since; a document that was left in the meantime is not touched.
 */
function applyArrival(
  expectation: Expectation,
  preview: MarkdownSkillDocument,
  current: SkillWorkspaceView,
): SkillWorkspaceView {
  if (expectation.kind !== "save") return storedDocument(expectation.key, preview, preview.body);
  if (current.kind !== "document" || current.document.key !== expectation.key) return current;
  // The server stores normalized text (line endings, BOM): text still equal to what was sent
  // adopts the stored body, newer typing stays and is dirty against the new baseline.
  const unchanged = current.document.text === expectation.sent;
  return storedDocument(expectation.key, preview, unchanged ? preview.body : current.document.text);
}

/**
 * A stored file arrives through the library preview, after opening or saving it. Leaving the
 * document (a new draft, another view) withdraws the expectation, so a late reply is ignored.
 */
function useArrivals(
  library: MarkdownSkillLibrary,
  setView: SetView,
): { current: Expectation | undefined } {
  const expected = useRef<Expectation | undefined>(undefined);
  const preview = library.preview;
  useEffect(() => {
    const expectation = expected.current;
    if (preview === undefined || expectation === undefined) return;
    if (expectation.kind === "open" && expectation.id !== preview.id) return;
    expected.current = undefined;
    setView((current) => applyArrival(expectation, preview, current));
  }, [preview, setView]);
  return expected;
}

/** A file deleted here, or elsewhere, closes; a failed delete keeps it open. */
function useClosedOnRemoval(
  library: MarkdownSkillLibrary,
  view: SkillWorkspaceView,
  setView: (view: SkillWorkspaceView) => void,
): void {
  const storedId = view.kind === "document" ? view.document.stored?.id : undefined;
  const present = library.skills.some((skill) => skill.id === storedId);
  useEffect(() => {
    if (storedId !== undefined && library.available && !library.busy && !present)
      setView({ kind: "empty" });
  }, [storedId, present, library.available, library.busy, setView]);
}

export function useSkillWorkspace(library: MarkdownSkillLibrary): SkillWorkspace {
  const [view, setView] = useState<SkillWorkspaceView>({ kind: "empty" });
  const [pending, setPending] = useState<() => void>();
  const drafts = useRef(0);
  const expected = useArrivals(library, setView);
  useClosedOnRemoval(library, view, setView);
  const document = view.kind === "document" ? view.document : undefined;
  const dirty = document !== undefined && document.text !== document.saved;
  const guard = (action: () => void): void => {
    if (dirty) setPending(() => action);
    else action();
  };
  return {
    view,
    dirty,
    canSave:
      document !== undefined &&
      (dirty || document.stored === undefined) &&
      skillTextFits(document.text) &&
      library.available &&
      !library.busy,
    confirming: pending !== undefined,
    guard,
    ...workspaceActions({ library, document, expected, drafts, setView, setPending, pending }),
  };
}

interface ActionContext {
  readonly library: MarkdownSkillLibrary;
  readonly document: SkillDocument | undefined;
  readonly expected: { current: Expectation | undefined };
  readonly drafts: { current: number };
  readonly setView: SetView;
  readonly setPending: (action: (() => void) | undefined) => void;
  readonly pending: (() => void) | undefined;
}

function nextKey(drafts: { current: number }, prefix: string): string {
  drafts.current += 1;
  return `${prefix}:${String(drafts.current)}`;
}

/** Opening, importing and saving go through the library; the result arrives as its preview. */
function libraryActions({
  library,
  document,
  expected,
  drafts,
}: ActionContext): Pick<SkillWorkspace, "open" | "importFile" | "save"> {
  return {
    open: (skill): void => {
      expected.current = { kind: "open", id: skill.id, key: nextKey(drafts, skill.id) };
      void library.inspect(skill);
    },
    importFile: (file): void => {
      expected.current = { kind: "import", key: nextKey(drafts, "import") };
      void library.upload(file);
    },
    save: (): void => {
      if (document === undefined) return;
      expected.current = { kind: "save", key: document.key, sent: document.text };
      const fileName =
        document.stored === undefined
          ? newFileName(document.text, document.fileName)
          : document.fileName;
      void library.upload(
        new File([document.text], fileName, { type: "text/markdown" }),
        document.stored,
      );
    },
  };
}

function workspaceActions(
  context: ActionContext,
): Pick<
  SkillWorkspace,
  "open" | "create" | "importFile" | "show" | "edit" | "save" | "discard" | "keepEditing"
> {
  const { document, drafts, expected, setView, setPending, pending } = context;
  return {
    ...libraryActions(context),
    create: (text, fileName): void => {
      const key = nextKey(drafts, "draft");
      expected.current = undefined;
      setView({
        kind: "document",
        document: { key, stored: undefined, fileName, saved: "", text },
      });
    },
    show: (kind): void => {
      expected.current = undefined;
      setView({ kind });
    },
    edit: (text): void => {
      // Against the latest document, so an edit never resurrects one a reply has since replaced.
      setView((current) =>
        current.kind === "document"
          ? { kind: "document", document: { ...current.document, text } }
          : current,
      );
    },
    discard: (): void => {
      setPending(undefined);
      pending?.();
    },
    keepEditing: (): void => setPending(undefined),
  };
}
