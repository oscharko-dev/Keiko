"use client";

import { createContext, useCallback, useState, type ReactNode } from "react";
import type { AvailableCodingSafeActivityFeed } from "@oscharko-dev/keiko-contracts";

import type { CodingWorkbenchTranslate } from "./coding-workbench-i18n";
import styles from "./CodingWorkbenchWindow.module.css";

/** Whether a long timeline's own scroller stopped following its newest row, and how to resume it. */
export interface ListFollow {
  readonly paused: boolean;
  readonly resume: () => void;
}

const NOT_FOLLOWING_A_LIST: ListFollow = { paused: false, resume: () => undefined };

/**
 * Where a long, windowed timeline reports its own scroller's follow state. That list scrolls by
 * itself inside the stream, so a reader can scroll up in it while the stream stays at its end; the
 * way back to the newest row has to know and resume both.
 */
export const ListFollowContext = createContext<((follow: ListFollow) => void) | null>(null);

/** The stream's and its windowed list's follow state, joined into one way back to the newest row. */
export function useJoinedFollow(
  streamPaused: boolean,
  resumeStream: () => void,
): {
  readonly paused: boolean;
  readonly jump: () => void;
  readonly reportList: (follow: ListFollow) => void;
} {
  const [list, setList] = useState<ListFollow>(NOT_FOLLOWING_A_LIST);
  const reportList = useCallback((follow: ListFollow): void => {
    setList((current) =>
      current.paused === follow.paused && current.resume === follow.resume ? current : follow,
    );
  }, []);
  const { resume: resumeList } = list;
  const jump = useCallback((): void => {
    resumeStream();
    resumeList();
  }, [resumeStream, resumeList]);
  return { paused: streamPaused || list.paused, jump, reportList };
}

/**
 * The identities of the rows a feed shows: its messages and its tool calls. A count could not tell
 * an arrival from the eviction of an old turn in the same update; identities can.
 */
export function feedRowKeys(feed: AvailableCodingSafeActivityFeed | null): readonly string[] {
  const keys: string[] = [];
  for (const turn of feed?.turns ?? []) {
    for (const message of turn.messages) keys.push(`message:${message.messageId}`);
    for (const tool of turn.tools) keys.push(`tool:${tool.callId}`);
  }
  return keys;
}

/**
 * The way back to the newest activity once the reader scrolled up and the stream stopped following
 * it, with the number of rows that arrived since, however many old rows the feed let go meanwhile. It sits at the stream's lower edge; its own text
 * stays out of the log's announcements, so a growing count never interrupts a screen reader.
 */
function jumpLabel(fresh: number, t: CodingWorkbenchTranslate): string {
  if (fresh === 0) return t("codingWorkbench.stream.jumpToLatest");
  if (fresh === 1) return t("codingWorkbench.stream.jumpToLatestNew.one");
  return t("codingWorkbench.stream.jumpToLatestNew", { count: fresh });
}

export function JumpToLatest({
  paused,
  rowKeys,
  onJump,
  t,
}: {
  readonly paused: boolean;
  readonly rowKeys: readonly string[];
  readonly onJump: () => void;
  readonly t: CodingWorkbenchTranslate;
}): ReactNode {
  // The rows shown when following paused, kept as derived state so a resume forgets them.
  const [since, setSince] = useState<ReadonlySet<string> | null>(null);
  if (paused && since === null) setSince(new Set(rowKeys));
  if (!paused && since !== null) setSince(null);
  if (!paused || since === null) return null;
  const fresh = rowKeys.reduce((count, rowKey) => (since.has(rowKey) ? count : count + 1), 0);
  return (
    <div className={styles.cmpJumpToLatest} aria-live="off">
      <button type="button" className={styles.button} onClick={onJump}>
        <span className={styles.cmpJumpToLatestIcon} aria-hidden="true" />
        {jumpLabel(fresh, t)}
      </button>
    </div>
  );
}
