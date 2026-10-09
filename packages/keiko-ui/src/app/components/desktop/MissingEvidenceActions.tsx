"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { GroundedInsufficiencyDeclaration } from "@oscharko-dev/keiko-contracts/bff-wire";
import { isRootRelativeFileIdentifier } from "@oscharko-dev/keiko-contracts/runtime/editor-workspace-path";
import { updateChatConnectedScopes } from "@/lib/api";
import { replaceGroundingScopeList } from "@/lib/chat-grounding-mutation";
import { useTranslate } from "@/lib/i18n";
import type { Chat, ChatConnectedScope, GroundedAnswer } from "@/lib/types";
import { mergeRepositoryFileScope } from "./repositoryFileScope";
import { effectiveScopes } from "./hooks/workspaceActions";
import { scopePathBasename } from "./connectedScopePresentation";
import { reportScopeNotice } from "./ChatScopeNotice";
import { formatUserError } from "./format-error";
import KeikoSelect from "./KeikoSelect";
import styles from "./ChatScopeNotice.module.css";

export interface MissingEvidenceActionsProps {
  readonly answer: GroundedAnswer | undefined;
  readonly chat: Chat | undefined;
  readonly onChatChanged: (chat: Chat) => void;
  readonly setDraft: (value: string) => void;
  readonly draft?: string | undefined;
  readonly focusComposer: () => void;
  readonly updateScopes?: typeof updateChatConnectedScopes;
}

function containsPath(scope: ChatConnectedScope, path: string): boolean {
  if (scope.kind === "workspace-root") return true;
  return scope.kind === "files"
    ? scope.relativePaths.includes(path)
    : scope.relativePaths.some((directory) => path.startsWith(`${directory}/`));
}

function declarationRoots(
  chat: Chat,
  declaration: GroundedInsufficiencyDeclaration,
): readonly string[] {
  if (
    declaration.state !== "unread-in-scope" ||
    !isRootRelativeFileIdentifier(declaration.scopePath)
  )
    return [];
  return Array.from(
    new Set(
      effectiveScopes(chat)
        .filter((scope) => containsPath(scope, declaration.scopePath))
        .map((scope) => scope.root ?? chat.projectPath),
    ),
  );
}

interface AddDeclaredFileAction {
  readonly busy: boolean;
  readonly error: string | null;
  readonly add: () => Promise<void>;
}

function useLatestActionProps(props: MissingEvidenceActionsProps): {
  current: MissingEvidenceActionsProps;
} {
  const latest = useRef(props);
  useEffect(() => {
    latest.current = props;
  }, [props]);
  return latest;
}

function useAddDeclaredFile(
  props: MissingEvidenceActionsProps,
  path: string,
  root: string,
): AddDeclaredFileAction {
  const t = useTranslate();
  const latest = useLatestActionProps(props);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const add = async (): Promise<void> => {
    const chat = props.chat;
    if (busy || chat === undefined || root.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const merged = mergeRepositoryFileScope(chat, root, path);
      const isCurrent = (): boolean =>
        latest.current.chat?.id === chat.id && latest.current.chat.projectPath === chat.projectPath;
      const update = (current: Chat): void => {
        if (isCurrent()) latest.current.onChatChanged(current);
      };
      const response = merged.changed
        ? await replaceGroundingScopeList(
            chat,
            merged.scopes,
            props.updateScopes ?? updateChatConnectedScopes,
            update,
          )
        : { chat };
      reportScopeNotice("missing-evidence-added", {
        kind: "files",
        root,
        relativePaths: [path],
        connectedAtMs: Date.now(),
      });
      if (!isCurrent()) return;
      update(response.chat);
      const suggestion = t("scope.missing.followUp", { path });
      latest.current.setDraft(
        latest.current.draft ? `${latest.current.draft}\n${suggestion}` : suggestion,
      );
      latest.current.focusComposer();
    } catch (failure) {
      setError(formatUserError(failure, t("scope.missing.failed")));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, add };
}

function DeclaredFileAction({
  declaration,
  roots,
  ...props
}: MissingEvidenceActionsProps & {
  readonly declaration: GroundedInsufficiencyDeclaration;
  readonly roots: readonly string[];
}): ReactNode {
  const t = useTranslate();
  const [selected, setSelected] = useState("");
  const root = roots.length === 1 ? (roots[0] ?? "") : roots.includes(selected) ? selected : "";
  const action = useAddDeclaredFile(props, declaration.scopePath, root);
  if (roots.length === 0) return null;
  return (
    <div className={styles.cmpNotice}>
      <span title={declaration.scopePath}>
        {t("scope.pill.file", { name: scopePathBasename(declaration.scopePath) })}
      </span>
      {roots.length > 1 ? (
        <KeikoSelect
          value={root}
          sections={[{ options: roots.map((value) => ({ value, label: value })) }]}
          onValueChange={setSelected}
          ariaLabel={t("scope.missing.folder")}
          placeholder={t("scope.missing.chooseFolder")}
        />
      ) : null}
      <button
        type="button"
        disabled={root.length === 0}
        aria-disabled={action.busy}
        onClick={() => {
          void action.add();
        }}
      >
        {t("scope.missing.add")}
      </button>
      {action.error === null ? null : <span role="alert">{action.error}</span>}
    </div>
  );
}

export function MissingEvidenceActions(props: MissingEvidenceActionsProps): ReactNode {
  const t = useTranslate();
  const { answer, chat } = props;
  if (
    chat === undefined ||
    answer === undefined ||
    answer.groundingKind === "local-knowledge" ||
    answer.answerKind !== "insufficiency"
  )
    return null;
  const declarations =
    answer.insufficiencyDeclarations?.filter(
      (declaration) => declaration.state === "unread-in-scope",
    ) ?? [];
  if (declarations.length === 0) return null;
  return (
    <section className={styles.cmpNotice} aria-label={t("scope.missing.title")}>
      <p>{t("scope.missing.count", { count: declarations.length })}</p>
      <button
        type="button"
        onClick={(event) => {
          const help = event.currentTarget
            .closest(".chatw")
            ?.querySelector<HTMLElement>('[data-testid="grounding-help"]');
          help?.focus();
          help?.scrollIntoView?.({ block: "nearest" });
        }}
      >
        {t("scope.missing.help")}
      </button>
      {declarations.map((declaration, index) => (
        <DeclaredFileAction
          key={`${declaration.scopePath}-${String(index)}`}
          {...props}
          declaration={declaration}
          roots={declarationRoots(chat, declaration)}
        />
      ))}
    </section>
  );
}
