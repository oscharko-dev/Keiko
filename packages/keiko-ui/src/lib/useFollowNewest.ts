"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefCallback,
  type RefObject,
} from "react";
import { newClientCorrelationId } from "./bff-correlation";
import { reportClientDiagnostic } from "./client-diagnostics";

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
  /** Binds the scroll region and its native Home/End navigation, preserving its log semantics. */
  readonly regionRef: RefCallback<HTMLElement>;
  /** Follow again and scroll to the end now, regardless of the current position. */
  readonly resume: () => void;
  /** True while the reader scrolled up and growth no longer follows: a way back can be offered. */
  readonly paused: boolean;
}

const NEAR_BOTTOM_PX = 64;

function reportTranscriptNavigation(): void {
  const correlationId = newClientCorrelationId();
  reportClientDiagnostic("Transcript navigation started.", {
    correlationId,
    stageReport: { stage: "transcript navigation", phase: "started", ordinal: 1 },
  });
  reportClientDiagnostic("Transcript navigation settled.", {
    correlationId,
    stageReport: { stage: "transcript navigation", phase: "settled", ordinal: 1, durationMs: 0 },
  });
}

function hasNavigationModifier(event: KeyboardEvent): boolean {
  return event.shiftKey || event.altKey || event.ctrlKey || event.metaKey;
}

// The browser's scroll anchoring keeps the visible rows in place when content above them changes
// height, by moving the scroll position. Under a following reader that move is a scroll that is not
// theirs: a row that opens itself would read as the reader leaving the end and stop following. So
// anchoring is off while the region follows and back on while the reader reads the history. The
// hook owns this property of the region; no stylesheet sets it.
function anchorScroll(element: HTMLElement, following: boolean): void {
  element.style.setProperty("overflow-anchor", following ? "none" : "auto");
}

function setFollowing(
  element: HTMLElement | null,
  stickRef: FollowNewest["stickRef"],
  setPaused: (paused: boolean) => void,
  following: boolean,
): void {
  stickRef.current = following;
  setPaused(!following);
  if (element !== null) anchorScroll(element, following);
}

function navigateTranscript(
  event: KeyboardEvent,
  element: HTMLElement,
  stickRef: FollowNewest["stickRef"],
  setPaused: (paused: boolean) => void,
): void {
  if (event.target !== element || event.defaultPrevented) return;
  if (event.isComposing || hasNavigationModifier(event)) return;
  if (event.key !== "Home" && event.key !== "End") return;
  event.preventDefault();
  setFollowing(element, stickRef, setPaused, event.key === "End");
  element.scrollTo({
    top: stickRef.current ? element.scrollHeight : 0,
    behavior: "instant",
  });
  reportTranscriptNavigation();
}

// Content that changes after the region's own scroll to the end and outside a growth key (an answer
// that finished loading) fires no scroll event once anchoring is off. A following region goes to its
// end again after each such change. One observer watches the region's DOM, never each row's height,
// so a long list costs nothing per row.
function followContentChanges(element: HTMLElement, onChange: () => void): () => void {
  if (typeof MutationObserver === "undefined") return () => undefined;
  const observer = new MutationObserver(() => {
    onChange();
  });
  observer.observe(element, { childList: true, characterData: true, subtree: true });
  return (): void => {
    observer.disconnect();
  };
}

// The reader's own input in the region. A change that follows it (a row the reader opened, rows a
// windowed list mounts for the reader's scroll) is theirs, so it does not bring the region to its
// end; the next growth of the content resumes that.
const READER_INPUT_EVENTS = ["pointerdown", "keydown", "wheel", "touchstart"] as const;

interface RegionBinding {
  readonly scrollRef: RefObject<HTMLElement | null>;
  readonly stickRef: FollowNewest["stickRef"];
  readonly readerActedRef: { current: boolean };
  readonly setPaused: (paused: boolean) => void;
  readonly onContentChange: () => void;
}

function bindRegion(element: HTMLElement, binding: RegionBinding): () => void {
  const { stickRef, readerActedRef, setPaused, onContentChange } = binding;
  anchorScroll(element, stickRef.current);
  const onKeyDown = (event: KeyboardEvent): void => {
    navigateTranscript(event, element, stickRef, setPaused);
  };
  const onReaderInput = (): void => {
    readerActedRef.current = true;
  };
  element.addEventListener("keydown", onKeyDown);
  for (const type of READER_INPUT_EVENTS) {
    element.addEventListener(type, onReaderInput, { capture: true, passive: true });
  }
  const stopFollowingChanges = followContentChanges(element, () => {
    if (!readerActedRef.current) onContentChange();
  });
  return (): void => {
    stopFollowingChanges();
    for (const type of READER_INPUT_EVENTS) {
      element.removeEventListener(type, onReaderInput, { capture: true });
    }
    element.removeEventListener("keydown", onKeyDown);
  };
}

function useRegionBinding(binding: RegionBinding): RefCallback<HTMLElement> {
  const { scrollRef, stickRef, readerActedRef, setPaused, onContentChange } = binding;
  return useCallback(
    (element: HTMLElement | null): (() => void) | undefined => {
      scrollRef.current = element;
      if (element === null) return undefined;
      const unbind = bindRegion(element, {
        scrollRef,
        stickRef,
        readerActedRef,
        setPaused,
        onContentChange,
      });
      return (): void => {
        unbind();
        if (scrollRef.current === element) scrollRef.current = null;
      };
    },
    [scrollRef, stickRef, readerActedRef, setPaused, onContentChange],
  );
}

// Where the region's own last scroll to the end left it: its position and the content height then.
interface EndMark {
  readonly top: number;
  readonly height: number;
}

// A scroll event the content caused, not the reader: the region is still where its own scroll to
// the end put it, and only the content grew since (an answer that finished loading before the event
// was read). A reader's scroll moves the position; a reader's small move over unchanged content is
// never mistaken for growth.
function grewSinceEnd(element: HTMLElement, end: EndMark | undefined): boolean {
  return (
    end !== undefined &&
    element.scrollHeight > end.height &&
    Math.abs(element.scrollTop - end.top) < 1
  );
}

function isAtEnd(element: HTMLElement): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= NEAR_BOTTOM_PX;
}

export function useFollowNewest(
  scrollRef: RefObject<HTMLElement | null>,
  growthKey: string | number,
): FollowNewest {
  const stickRef = useRef(true);
  const endRef = useRef<EndMark | undefined>(undefined);
  const readerActedRef = useRef(false);
  // A state copy of the ref, set only when it changes, so a scroll re-renders nothing on its own.
  const [paused, setPaused] = useState(false);

  const scrollToEnd = useCallback((): void => {
    const element = scrollRef.current;
    if (element === null || !stickRef.current) return;
    element.scrollTop = element.scrollHeight;
    endRef.current = { top: element.scrollTop, height: element.scrollHeight };
  }, [scrollRef]);

  const regionRef = useRegionBinding({
    scrollRef,
    stickRef,
    readerActedRef,
    setPaused,
    onContentChange: scrollToEnd,
  });

  const onScroll = useCallback((): void => {
    const element = scrollRef.current;
    if (element === null) return;
    const atEnd = isAtEnd(element);
    if (!atEnd && stickRef.current && grewSinceEnd(element, endRef.current)) {
      scrollToEnd();
      return;
    }
    endRef.current = undefined;
    setFollowing(element, stickRef, setPaused, atEnd);
  }, [scrollRef, scrollToEnd]);

  const resume = useCallback((): void => {
    readerActedRef.current = false;
    setFollowing(scrollRef.current, stickRef, setPaused, true);
    scrollToEnd();
  }, [scrollRef, scrollToEnd]);

  useEffect(() => {
    readerActedRef.current = false;
    scrollToEnd();
  }, [growthKey, scrollToEnd]);

  return useMemo(
    () => ({ stickRef, onScroll, regionRef, resume, paused }),
    [onScroll, regionRef, resume, paused],
  );
}
