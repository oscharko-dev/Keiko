"use client";

import {
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";
import { useOptionalWidgetTranslate as useTranslate } from "@/lib/optional-widget-i18n";
import { SafeMarkdown } from "../SafeMarkdown";
import type { ComposerEditorLabels } from "../composer/composer-editor-types";
import {
  joinMarkdownDocument,
  splitMarkdownDocument,
  supportsFormattedEditing,
} from "./markdown-document";
import { MarkdownDocumentController } from "./markdown-document-controller";
import {
  MarkdownEditorToolbar,
  MarkdownViewSwitch,
  type MarkdownView,
} from "./MarkdownEditorToolbar";
import styles from "./MarkdownEditor.module.css";

export interface MarkdownEditorProps {
  /** The complete Markdown file, including any YAML front matter. */
  readonly value: string;
  readonly onChange: (value: string) => void;
  /**
   * Names the open document. A new key opens a new document with its own view and history; the
   * editor otherwise owns the text while it is open, so replacing the value needs a new key.
   */
  readonly documentKey: string;
  readonly ariaLabel: string;
  readonly placeholder?: string;
  readonly maxLength: number;
  /**
   * Selects the first block's text when this document first opens formatted, so a new file's
   * title can be typed over at once.
   */
  readonly selectTitleOnOpen?: boolean;
}

type Translate = ReturnType<typeof useTranslate>;

function codeLabels(t: Translate): ComposerEditorLabels {
  return {
    code: t("chat.composer.code"),
    plainText: t("chat.composer.plainText"),
    language: t("chat.composer.codeLanguage"),
    continueText: t("chat.composer.continueText"),
    loading: t("chat.composer.codeLoading"),
    unavailable: t("chat.composer.codeUnavailable"),
    limit: t("markdownEditor.limit"),
    hint: "",
  };
}

/** The title is selected once per document: switching views later leaves the caret alone. */
function useTitleSelection(props: MarkdownEditorProps): {
  readonly pending: boolean;
  readonly done: () => void;
} {
  const selected = useRef<string>(undefined);
  return {
    pending: props.selectTitleOnOpen === true && selected.current !== props.documentKey,
    done: (): void => {
      selected.current = props.documentKey;
    },
  };
}

/** A document opens formatted unless that view would change what its Markdown means. */
function useDocumentView(
  documentKey: string,
  body: string,
): readonly [MarkdownView, (view: MarkdownView) => void] {
  const [state, setState] = useState(() => ({
    key: documentKey,
    view: (supportsFormattedEditing(body) ? "rich" : "source") as MarkdownView,
  }));
  let current = state;
  if (state.key !== documentKey) {
    current = { key: documentKey, view: supportsFormattedEditing(body) ? "rich" : "source" };
    setState(current);
  }
  const choose = (view: MarkdownView): void => {
    reportClientDiagnostic("Keiko Markdown editor view changed.", {
      composerActivity: "markdown-view-changed",
    });
    setState({ key: documentKey, view });
  };
  return [current.view, choose];
}

function useMarkdownEditorState(props: MarkdownEditorProps): {
  readonly view: MarkdownView;
  readonly setView: (view: MarkdownView) => void;
  readonly formattable: boolean;
  readonly controller: RefObject<MarkdownDocumentController | null>;
  readonly refreshToolbar: () => void;
  readonly notice: string;
  readonly setNotice: (notice: string) => void;
  readonly changeBody: (body: string) => void;
} {
  const body = splitMarkdownDocument(props.value).body;
  const [view, setView] = useDocumentView(props.documentKey, body);
  // In the formatted view the body is the editor's own output, so it always stays formattable.
  const formattable = view === "rich" || supportsFormattedEditing(body);
  const controller = useRef<MarkdownDocumentController | null>(null);
  const [, refreshToolbar] = useReducer((count: number) => count + 1, 0);
  const [notice, setNotice] = useState("");
  const latest = useRef(props);
  useLayoutEffect(() => {
    latest.current = props;
  });
  const changeBody = (next: string): void => {
    setNotice("");
    const frontMatter = splitMarkdownDocument(latest.current.value).frontMatter;
    latest.current.onChange(joinMarkdownDocument({ frontMatter, body: next }));
  };
  useSourceFallbackReport(props.documentKey, view, formattable);
  return { view, setView, formattable, controller, refreshToolbar, notice, setNotice, changeBody };
}

/**
 * The shared Markdown editor for prompts, skills and templates: a formatted view, the Markdown
 * source and a split view with a live preview; YAML front matter is kept apart and preserved.
 */
export function MarkdownEditor(props: MarkdownEditorProps): ReactNode {
  const t = useTranslate();
  const parts = splitMarkdownDocument(props.value);
  const editor = useMarkdownEditorState(props);
  const title = useTitleSelection(props);
  const { view, formattable } = editor;
  return (
    <div className={styles.mdeRoot} data-view={view}>
      <div className={styles.mdeBar}>
        {view === "rich" ? (
          <MarkdownEditorToolbar controller={editor.controller.current} />
        ) : (
          <span className={styles.mdeGrow} />
        )}
        <MarkdownViewSwitch view={view} formattable={formattable} onView={editor.setView} />
      </div>
      {parts.frontMatter === undefined ? null : (
        <FrontMatterField
          key={props.documentKey}
          value={parts.frontMatter}
          onChange={(frontMatter) =>
            props.onChange(joinMarkdownDocument({ ...parts, frontMatter }))
          }
        />
      )}
      <div className={styles.mdeBody}>
        {view === "rich" ? (
          <FormattedSurface
            key={props.documentKey}
            props={props}
            body={parts.body}
            controller={editor.controller}
            labels={codeLabels(t)}
            onChange={editor.changeBody}
            onState={editor.refreshToolbar}
            onLimit={() => editor.setNotice(t("markdownEditor.limit"))}
            title={title}
          />
        ) : (
          <SourceSurface body={parts.body} view={view} props={props} onChange={editor.changeBody} />
        )}
      </div>
      <MarkdownStatus
        notice={editor.notice || (formattable ? "" : t("markdownEditor.sourceOnly"))}
        count={props.value.length}
      />
    </div>
  );
}

function useSourceFallbackReport(
  documentKey: string,
  view: MarkdownView,
  formattable: boolean,
): void {
  const reported = useRef<string>(undefined);
  useEffect(() => {
    if (formattable || view === "rich" || reported.current === documentKey) return;
    reported.current = documentKey;
    reportClientDiagnostic("Keiko Markdown editor kept a document in Markdown source.", {
      composerActivity: "markdown-rich-unavailable",
    });
  }, [documentKey, formattable, view]);
}

interface FormattedSurfaceProps {
  readonly props: MarkdownEditorProps;
  readonly body: string;
  readonly controller: RefObject<MarkdownDocumentController | null>;
  readonly labels: ComposerEditorLabels;
  readonly onChange: (body: string) => void;
  readonly onState: () => void;
  readonly onLimit: () => void;
  readonly title: ReturnType<typeof useTitleSelection>;
}

/** Opens the formatted view; callbacks read the latest props, so the view outlives renders. */
function openFormattedDocument(
  element: HTMLElement,
  current: RefObject<FormattedSurfaceProps>,
): MarkdownDocumentController {
  const options = current.current;
  const editor = new MarkdownDocumentController(element, {
    body: options.body,
    maxLength: options.props.maxLength,
    ariaLabel: options.props.ariaLabel,
    placeholder: options.props.placeholder ?? "",
    className: styles.mdeDocument ?? "",
    labels: options.labels,
    onChange: (next): void => current.current.onChange(next),
    onState: (): void => current.current.onState(),
    onLimit: (): void => current.current.onLimit(),
  });
  if (options.title.pending) {
    options.title.done();
    editor.selectFirstBlock();
  }
  return editor;
}

function FormattedSurface(surface: FormattedSurfaceProps): ReactNode {
  const host = useRef<HTMLDivElement>(null);
  const current = useRef(surface);
  useLayoutEffect(() => {
    current.current = surface;
  });
  const { controller } = surface;
  useLayoutEffect(() => {
    const element = host.current;
    if (element === null) return;
    const editor = openFormattedDocument(element, current);
    controller.current = editor;
    current.current.onState();
    return (): void => {
      editor.destroy();
      controller.current = null;
    };
  }, [controller]);
  return <div ref={host} className={styles.mdePage} />;
}

function SourceSurface({
  body,
  view,
  props,
  onChange,
}: {
  readonly body: string;
  readonly view: MarkdownView;
  readonly props: MarkdownEditorProps;
  readonly onChange: (body: string) => void;
}): ReactNode {
  const t = useTranslate();
  return (
    <>
      <textarea
        className={styles.mdeSource}
        aria-label={`${props.ariaLabel} · ${t("markdownEditor.view.source")}`}
        placeholder={props.placeholder}
        value={body}
        maxLength={props.maxLength}
        spellCheck={false}
        onChange={(event) => onChange(event.target.value)}
      />
      {view === "split" ? (
        <section
          className={styles.mdePreview}
          aria-label={t("markdownEditor.preview")}
          // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- the preview scrolls on its own
          tabIndex={0}
        >
          <SafeMarkdown source={body} />
        </section>
      ) : null}
    </>
  );
}

/** The YAML a template is governed by; machine metadata, so it stays folded until asked for. */
function FrontMatterField({
  value,
  onChange,
}: {
  readonly value: string;
  readonly onChange: (value: string) => void;
}): ReactNode {
  const t = useTranslate();
  const lines = value.length === 0 ? 0 : value.split("\n").length;
  return (
    <details className={styles.mdeMeta}>
      <summary>
        {t("markdownEditor.frontMatter")}
        <span className={styles.mdeMetaCount}>{t("markdownEditor.lines", { count: lines })}</span>
      </summary>
      <textarea
        aria-label={t("markdownEditor.frontMatter")}
        value={value}
        rows={Math.min(Math.max(lines, 3), 14)}
        spellCheck={false}
        onChange={(event) => onChange(event.target.value)}
      />
    </details>
  );
}

function MarkdownStatus({
  notice,
  count,
}: {
  readonly notice: string;
  readonly count: number;
}): ReactNode {
  const t = useTranslate();
  return (
    <div className={styles.mdeStatus}>
      <output className={styles.mdeNotice}>{notice}</output>
      <span>{t("markdownEditor.format")}</span>
      <span>{t("markdownEditor.characters", { count: count.toLocaleString() })}</span>
    </div>
  );
}
