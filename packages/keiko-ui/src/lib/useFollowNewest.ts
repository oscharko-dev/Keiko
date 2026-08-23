"use client";

import { useCallback, useEffect, useMemo, useRef, type RefObject } from "react";

/**
 * Stick-to-bottom behaviour for a live log region: while the reader is at (or near) the bottom,
 * every growth of the content scrolls the region to its end; once the reader scrolls up into the
 * history, growth never yanks them back until they return near the bottom themselves or the caller
 * resumes following explicitly (own send, new run).
 *
 * One implementation for every live stream surface — the desktop chat log and the Coding Workbench
 * session stream share it — so the two cannot drift apart (AGENTS.md §5). The scroll is applied
 * synchronously in the commit effect: growth is already coalesced upstream (the safe-activity
 * stream batches snapshots, the chat flushes stream chunks per frame), and a deferred animation
 * frame never fires while the document is hidden, which left a finished run's result scrolled out
 * of view in a background window.
 */
export interface FollowNewest {
  /** True while the region follows growth; callers may pause it (e.g. a deliberate jump). */
  readonly stickRef: { current: boolean };
  /** Scroll handler for the region: re-derives "near the bottom" from the live geometry. */
  readonly onScroll: () => void;
  /** Follow again and scroll to the end now, regardless of the current position. */
  readonly resume: () => void;
}

const NEAR_BOTTOM_PX = 64;

export function useFollowNewest(
  scrollRef: RefObject<HTMLElement | null>,
  growthKey: string | number,
): FollowNewest {
  const stickRef = useRef(true);

  const scrollToEnd = useCallback((): void => {
    const element = scrollRef.current;
    if (element !== null && stickRef.current) element.scrollTop = element.scrollHeight;
  }, [scrollRef]);

  const onScroll = useCallback((): void => {
    const element = scrollRef.current;
    if (element === null) return;
    stickRef.current =
      element.scrollHeight - element.scrollTop - element.clientHeight < NEAR_BOTTOM_PX;
  }, [scrollRef]);

  const resume = useCallback((): void => {
    stickRef.current = true;
    scrollToEnd();
  }, [scrollToEnd]);

  useEffect(() => {
    scrollToEnd();
  }, [growthKey, scrollToEnd]);

  return useMemo(() => ({ stickRef, onScroll, resume }), [onScroll, resume]);
}
