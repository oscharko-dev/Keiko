/* eslint-disable jsx-a11y/no-noninteractive-tabindex -- A formula or diff wider or taller than its frame scrolls; the frame is a named group so it stays reachable by keyboard. */
"use client";

import {
  memo,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { GitEditorDiffFile, GitEditorDiffLine } from "@oscharko-dev/keiko-contracts";

import type { SafeMarkdownNode } from "@/lib/safe-markdown";
import type { SafeMarkdownRichContent } from "../../SafeMarkdown";
import { parseUnifiedDiff, UNKNOWN_DIFF_PATH } from "../cards/shared/diffParser";
import type { DiffViewLabels } from "../cards/shared/diffView";
import { CodingWorkbenchDiffFiles } from "./CodingWorkbenchWindowedDiff";
import { diffLabels } from "./CodingWorkbenchChanges";
import { useCodingWorkbenchTranslate } from "./coding-workbench-i18n";
import {
  drawDiagram,
  loadMermaid,
  readLoadedMermaid,
  type DiagramDrawing,
  type MermaidRenderer,
} from "./codingWorkbenchDiagram";
import {
  loadKatex,
  mathFenceSource,
  readLoadedKatex,
  typesetMath,
  type KatexRenderer,
  type MathTypesetting,
} from "./codingWorkbenchMath";
import styles from "./CodingWorkbenchRichContent.module.css";

// Rich rendering of model answers in the Workbench timeline (parity row S19). It is injected into
// the shared Markdown renderer (`SafeMarkdownRichContent`), so there is one Markdown pipeline, the
// diff view is the Changes panel's own `DiffFileSection`, and nothing here adds a stylesheet.
// Every construct falls back to the unchanged code view, the formula or the diagram as written.

const MATH_FENCES: ReadonlySet<string> = new Set(["math", "latex", "tex", "katex"]);
const DIFF_FENCES: ReadonlySet<string> = new Set(["diff", "patch"]);
const DIAGRAM_FENCE = "mermaid";
// A diff with no file or hunk headers (`-old` / `+new` lines alone) is common in a model answer.
const MAX_PLAIN_DIFF_LINES = 2000;

// ---------------------------------------------------------------------------
// Math
// ---------------------------------------------------------------------------

type KatexState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly katex: KatexRenderer }
  | { readonly status: "failed" };

type MathView =
  MathTypesetting | { readonly status: "pending" } | { readonly status: "unavailable" };

function initialKatexState(): KatexState {
  const katex = readLoadedKatex();
  return katex === undefined ? { status: "loading" } : { status: "ready", katex };
}

// KaTeX is a lazy chunk. A failed load was already reported once by the loader, body-free; here it
// only decides what to show: the formulas as written.
function useKatex(): KatexState {
  const [state, setState] = useState<KatexState>(initialKatexState);
  useEffect(() => {
    if (state.status !== "loading") return undefined;
    let current = true;
    loadKatex().then(
      (katex) => {
        if (current) setState({ status: "ready", katex });
      },
      () => {
        if (current) setState({ status: "failed" });
      },
    );
    return (): void => {
      current = false;
    };
  }, [state.status]);
  return state;
}

// Typesetting is memoized on the formula itself, so a streamed answer that re-renders for every new
// token does not typeset an already complete formula again.
function useMathView(tex: string, display: boolean): MathView {
  const katex = useKatex();
  return useMemo((): MathView => {
    if (katex.status === "loading") return { status: "pending" };
    if (katex.status === "failed") return { status: "unavailable" };
    return typesetMath(katex.katex, tex, display);
  }, [katex, tex, display]);
}

// The checked nodes are adopted as they are (cloned, so the memoized result stays reusable); the
// markup string is never parsed a second time and never reaches `innerHTML`.
function TypesetMath({
  nodes,
  className,
}: {
  readonly nodes: readonly Node[];
  readonly className: string | undefined;
}): ReactNode {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    ref.current?.replaceChildren(...nodes.map((node) => node.cloneNode(true)));
  }, [nodes]);
  return <span ref={ref} className={className} data-math-state="typeset" />;
}

function MathFrame({
  nodes,
  block,
}: {
  readonly nodes: readonly Node[];
  readonly block: boolean;
}): ReactNode {
  const t = useCodingWorkbenchTranslate();
  const Frame = block ? "div" : "span";
  return (
    <Frame
      className={block ? styles.cmpMathBlock : styles.cmpMathDisplay}
      role="group"
      aria-label={t("codingWorkbench.richContent.math.region")}
      tabIndex={0}
    >
      <TypesetMath nodes={nodes} className={styles.cmpMathInline} />
    </Frame>
  );
}

interface MathSpanProps {
  readonly tex: string;
  readonly raw: string;
  readonly display: boolean;
}

function MathSpanImpl({ tex, raw, display }: MathSpanProps): ReactNode {
  const view = useMathView(tex, display);
  if (view.status !== "typeset") {
    return (
      <span className={styles.cmpMathSource} data-math-state={view.status}>
        {raw}
      </span>
    );
  }
  return display ? (
    <MathFrame nodes={view.nodes} block={false} />
  ) : (
    <TypesetMath nodes={view.nodes} className={styles.cmpMathInline} />
  );
}

const MathSpan = memo(MathSpanImpl);

function MathBlockView({
  text,
  standard,
}: {
  readonly text: string;
  readonly standard: ReactNode;
}): ReactNode {
  const view = useMathView(mathFenceSource(text), true);
  return view.status === "typeset" ? <MathFrame nodes={view.nodes} block /> : standard;
}

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

function plainDiffLine(line: string): GitEditorDiffLine {
  const none = { oldLine: null, newLine: null } as const;
  if (line.startsWith("+")) return { kind: "add", ...none, text: line.slice(1) };
  if (line.startsWith("-")) return { kind: "del", ...none, text: line.slice(1) };
  if (line.startsWith(String.raw`\ `)) return { kind: "meta", ...none, text: line };
  return { kind: "ctx", ...none, text: line.startsWith(" ") ? line.slice(1) : line };
}

// `-old` / `+new` lines without any header: the added and removed lines are the diff. Null when
// there are none, so ordinary prose or code in a ```diff fence keeps its code view.
function plainDiffFile(text: string, path: string): GitEditorDiffFile | null {
  const rows = text.split("\n");
  const lines = rows.slice(0, MAX_PLAIN_DIFF_LINES).map(plainDiffLine);
  const addedLines = lines.filter((line) => line.kind === "add").length;
  const removedLines = lines.filter((line) => line.kind === "del").length;
  if (addedLines + removedLines === 0) return null;
  const truncated = rows.length > MAX_PLAIN_DIFF_LINES;
  return {
    path,
    layer: "worktree",
    status: "modified",
    binary: false,
    hunks: [{ header: "@@", oldStart: 0, oldCount: 0, newStart: 0, newCount: 0, lines, truncated }],
    addedLines,
    removedLines,
    truncated,
  };
}

// The files a model-written diff shows. A diff whose headers parse but carry no hunk (a mode change,
// a bare rename) has nothing to review and keeps its code view; so does anything that is not a diff.
function diffFiles(text: string, unnamedPath: string): readonly GitEditorDiffFile[] | null {
  const parsed = parseUnifiedDiff(text);
  if (parsed.files.length === 0) {
    const plain = plainDiffFile(text, unnamedPath);
    return plain === null ? null : [plain];
  }
  const shown = parsed.files
    .filter((file) => file.binary || file.hunks.length > 0)
    .map((file) => (file.path === UNKNOWN_DIFF_PATH ? { ...file, path: unnamedPath } : file));
  return shown.length === 0 ? null : shown;
}

function DiffSections({
  files,
  labels,
  idPrefix,
}: {
  readonly files: readonly GitEditorDiffFile[];
  readonly labels: DiffViewLabels;
  readonly idPrefix: string;
}): ReactNode {
  return (
    <div className="rv-body">
      <CodingWorkbenchDiffFiles
        surface="answer-diff"
        files={files}
        idPrefix={idPrefix}
        labels={labels}
      />
    </div>
  );
}

function DiffBlockView({
  text,
  standard,
}: {
  readonly text: string;
  readonly standard: ReactNode;
}): ReactNode {
  const t = useCodingWorkbenchTranslate();
  const idPrefix = `coding-workbench-answer-diff-${useId()}`;
  const labels = useMemo(() => diffLabels(t), [t]);
  const unnamedPath = t("codingWorkbench.richContent.diff.unnamedFile");
  // Parsed and laid out once per distinct block: the element tree is memoized with its source.
  const body = useMemo(() => {
    const files = diffFiles(text, unnamedPath);
    return files === null ? null : (
      <DiffSections files={files} labels={labels} idPrefix={idPrefix} />
    );
  }, [text, unnamedPath, labels, idPrefix]);
  if (body === null) return standard;
  return (
    <section
      className={`${styles.cmpDiff} review`}
      aria-label={t("codingWorkbench.richContent.diff.region")}
      tabIndex={0}
    >
      {body}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Diagram
// ---------------------------------------------------------------------------

type MermaidState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly mermaid: MermaidRenderer }
  | { readonly status: "failed" };

type DiagramView = DiagramDrawing | { readonly status: "pending" };

function initialMermaidState(): MermaidState {
  const mermaid = readLoadedMermaid();
  return mermaid === undefined ? { status: "loading" } : { status: "ready", mermaid };
}

// Mermaid is a lazy chunk, loaded only once a diagram is on screen. A failed load was already
// reported once by the loader, body-free; here it only decides what to show: the source.
function useMermaid(): MermaidState {
  const [state, setState] = useState<MermaidState>(initialMermaidState);
  useEffect(() => {
    if (state.status !== "loading") return undefined;
    let current = true;
    loadMermaid().then(
      (mermaid) => {
        if (current) setState({ status: "ready", mermaid });
      },
      () => {
        if (current) setState({ status: "failed" });
      },
    );
    return (): void => {
      current = false;
    };
  }, [state.status]);
  return state;
}

// Drawn once per distinct source: a streamed answer that re-renders for every new token does not
// draw an already complete diagram again.
function useDiagramView(text: string): DiagramView {
  const mermaid = useMermaid();
  const [view, setView] = useState<DiagramView>({ status: "pending" });
  useEffect(() => {
    if (mermaid.status === "loading") return undefined;
    if (mermaid.status === "failed") {
      setView({ status: "verbatim", reason: "rejected" });
      return undefined;
    }
    let current = true;
    void drawDiagram(mermaid.mermaid, text).then((drawing) => {
      if (current) setView(drawing);
    });
    return (): void => {
      current = false;
    };
  }, [mermaid, text]);
  return view;
}

// The checked nodes are adopted into a shadow root on a named region (a `section` may host one, a
// `figure` may not), cloned so the drawing stays reusable: the
// diagram's own stylesheet then styles that diagram and nothing else on the page.
function DrawnDiagram({ nodes }: { readonly nodes: readonly Node[] }): ReactNode {
  const t = useCodingWorkbenchTranslate();
  const ref = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const host = ref.current;
    if (host === null) return;
    const root = host.shadowRoot ?? host.attachShadow({ mode: "open" });
    root.replaceChildren(...nodes.map((node) => node.cloneNode(true)));
  }, [nodes]);
  return (
    <section
      ref={ref}
      className={styles.cmpDiagramDrawing}
      aria-label={t("codingWorkbench.richContent.diagram.region")}
      tabIndex={0}
      data-diagram-state="drawn"
    />
  );
}

// While Mermaid loads, and whenever it cannot draw the diagram, the fenced source stays, named for
// what it is.
function DiagramSourceView({
  standard,
  pending,
}: {
  readonly standard: ReactNode;
  readonly pending: boolean;
}): ReactNode {
  const t = useCodingWorkbenchTranslate();
  return (
    <figure className={styles.cmpDiagram} data-diagram-state={pending ? "pending" : "verbatim"}>
      <figcaption>
        <p className={styles.cmpDiagramTitle}>{t("codingWorkbench.richContent.diagram.title")}</p>
        {pending ? null : (
          <p className={styles.cmpDiagramNote}>{t("codingWorkbench.richContent.diagram.note")}</p>
        )}
      </figcaption>
      {standard}
    </figure>
  );
}

function DiagramBlockView({
  text,
  standard,
}: {
  readonly text: string;
  readonly standard: ReactNode;
}): ReactNode {
  const view = useDiagramView(text);
  if (view.status === "drawn") return <DrawnDiagram nodes={view.nodes} />;
  return <DiagramSourceView standard={standard} pending={view.status === "pending"} />;
}

// ---------------------------------------------------------------------------
// The injected renderer
// ---------------------------------------------------------------------------

function renderRichCodeBlock(node: SafeMarkdownNode, standard: ReactNode): ReactNode {
  const language = node.language?.toLowerCase() ?? "";
  const text = node.text ?? "";
  if (MATH_FENCES.has(language)) return <MathBlockView text={text} standard={standard} />;
  if (DIFF_FENCES.has(language)) return <DiffBlockView text={text} standard={standard} />;
  if (language === DIAGRAM_FENCE) return <DiagramBlockView text={text} standard={standard} />;
  return standard;
}

function renderRichMath(node: SafeMarkdownNode): ReactNode {
  return <MathSpan tex={node.text ?? ""} raw={node.raw ?? ""} display={node.display === true} />;
}

/** Module constant: the shared renderer keys its memoization on this object's identity. */
export const CODING_WORKBENCH_RICH_CONTENT: SafeMarkdownRichContent = {
  renderMath: renderRichMath,
  renderCodeBlock: renderRichCodeBlock,
};
