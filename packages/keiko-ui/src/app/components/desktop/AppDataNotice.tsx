"use client";

// Plain-language AppData notice (#4437, owner decision 2026-11-17). AppData stays searchable; the
// notice only informs that it can hold sensitive application data. It never blocks or asks for
// approval, and the existing credential floor, deny-list, containment and redaction are unchanged.
// The Activity Log receives only the closed `client.scope.notice` reason and counts, never a path.

import { useEffect, useRef, type ReactNode } from "react";
import { useLocale, type Locale } from "@/lib/i18n";
import type { Chat, ChatConnectedScope, FilesTreeEntry } from "@/lib/types";
import { reportScopeNotice } from "./ChatScopeNotice";
import styles from "./ChatScopeNotice.module.css";
import { effectiveScopes } from "./hooks/workspaceActions";

export type AppDataNoticeReason = "app-data-contained" | "app-data-selected";

const APP_DATA = "appdata";
// `C:\Users` or `C:\Users\<person>`: by Windows convention every profile below holds `AppData`.
const PROFILE_ROOT = /^[a-z]:\/users(?:\/[^/]+)?$/u;

const MESSAGES: Readonly<Record<Locale, Readonly<Record<AppDataNoticeReason, string>>>> = {
  en: {
    "app-data-contained":
      "This folder contains AppData. Apps keep their data there, which can include sensitive " +
      "information such as browser profiles, mailboxes and saved sign-ins. Keiko searches it like " +
      "any other folder.",
    "app-data-selected":
      "This folder is part of AppData. Apps keep their data there, which can include sensitive " +
      "information such as browser profiles, mailboxes and saved sign-ins. Keiko searches it like " +
      "any other folder.",
  },
  de: {
    "app-data-contained":
      "Dieser Ordner enthält AppData. Dort speichern Apps ihre Daten, darunter auch vertrauliche " +
      "wie Browserprofile, Postfächer und gespeicherte Anmeldungen. Keiko durchsucht ihn wie jeden " +
      "anderen Ordner.",
    "app-data-selected":
      "Dieser Ordner gehört zu AppData. Dort speichern Apps ihre Daten, darunter auch vertrauliche " +
      "wie Browserprofile, Postfächer und gespeicherte Anmeldungen. Keiko durchsucht ihn wie jeden " +
      "anderen Ordner.",
  },
};

function normalizedPath(path: string): string {
  const slashed = path.replaceAll("\\", "/").toLowerCase();
  let end = slashed.length;
  while (end > 0 && slashed.codePointAt(end - 1) === 0x2f) end -= 1;
  return slashed.slice(0, end);
}

function namesAppData(path: string): boolean {
  return normalizedPath(path)
    .split("/")
    .some((segment) => segment === APP_DATA);
}

/**
 * The notice a connected root needs. A loaded listing (`childNames`) is authoritative for whether
 * the root holds `AppData`; without one, a Windows profile root is assumed to hold it.
 */
export function appDataReasonForRoot(
  root: string,
  childNames?: readonly string[],
): AppDataNoticeReason | undefined {
  if (namesAppData(root)) return "app-data-selected";
  const contained =
    childNames === undefined
      ? PROFILE_ROOT.test(normalizedPath(root))
      : childNames.some((name) => name.toLowerCase() === APP_DATA);
  return contained ? "app-data-contained" : undefined;
}

/** The notice a Chat's connected scope needs; a selected subfolder is judged by its own path. */
export function appDataReasonForScope(scope: ChatConnectedScope): AppDataNoticeReason | undefined {
  if (scope.root === undefined) return undefined;
  if (namesAppData(scope.root) || scope.relativePaths.some(namesAppData)) {
    return "app-data-selected";
  }
  return scope.kind === "workspace-root" ? appDataReasonForRoot(scope.root) : undefined;
}

const FILES_ROOT_SCOPE: ChatConnectedScope = {
  kind: "workspace-root",
  relativePaths: [],
  connectedAtMs: 0,
};

// Reports once per distinct notice; the key stays in memory and never leaves the browser.
function useReportedNotice(
  reason: AppDataNoticeReason | undefined,
  key: string,
  scope: ChatConnectedScope,
): void {
  const reported = useRef<string | null>(null);
  const noticeKey = reason === undefined ? null : `${reason}\u0000${key}`;
  useEffect(() => {
    if (reason === undefined || noticeKey === null || reported.current === noticeKey) return;
    reported.current = noticeKey;
    reportScopeNotice(reason, scope);
  }, [noticeKey, reason, scope]);
}

function noticeText(locale: Locale, reason: AppDataNoticeReason): string {
  return MESSAGES[locale][reason];
}

function firstScopeNotice(
  scopes: readonly ChatConnectedScope[],
): { readonly reason: AppDataNoticeReason; readonly scope: ChatConnectedScope } | undefined {
  for (const scope of scopes) {
    const reason = appDataReasonForScope(scope);
    if (reason !== undefined) return { reason, scope };
  }
  return undefined;
}

/** Chat scope header: shown while a connected scope contains or is part of AppData. */
export function ChatAppDataNotice({ chat }: { readonly chat: Chat }): ReactNode {
  const locale = useLocale();
  const notice = firstScopeNotice(effectiveScopes(chat));
  const scope = notice?.scope ?? FILES_ROOT_SCOPE;
  useReportedNotice(
    notice?.reason,
    `${chat.id}\u0000${scope.root ?? ""}\u0000${scope.relativePaths.join("\u0000")}`,
    scope,
  );
  if (notice === undefined) return null;
  return (
    <p className={styles.cmpNotice} role="note" data-testid="app-data-notice">
      {noticeText(locale, notice.reason)}
    </p>
  );
}

/** Files root listing: shown when the opened folder holds or is part of AppData. */
export function FilesAppDataNotice({
  root,
  path,
  entries,
}: {
  readonly root: string;
  readonly path: string;
  readonly entries: readonly FilesTreeEntry[] | undefined;
}): ReactNode {
  const locale = useLocale();
  const reason =
    path === "" && root.length > 0 && entries !== undefined
      ? appDataReasonForRoot(
          root,
          entries.filter((entry) => entry.kind === "directory").map((entry) => entry.name),
        )
      : undefined;
  useReportedNotice(reason, root, FILES_ROOT_SCOPE);
  if (reason === undefined) return null;
  return (
    <p className="files-note files-warning" role="note" data-testid="app-data-notice">
      {noticeText(locale, reason)}
    </p>
  );
}
