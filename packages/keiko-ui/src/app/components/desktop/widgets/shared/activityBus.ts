// Global mutable bus intentionally outside React — Welle 4 AgentRun writes here
// from outside the React tree, and TimelinePanel subscribes via custom event.
import { useState, useEffect } from "react";

export interface ActivityEvent {
  type:
    | "step"
    | "approval"
    | "approved"
    | "rejected"
    | "stopped"
    | "open"
    | "twin-approved"
    | "twin-denied";
  text: string;
  agent?: string;
  tool?: string;
  time: number;
}

const STORE_KEY = "__keikoActivity";
const EVENT_NAME = "keiko-activity";

declare global {
  interface Window {
    __keikoActivity?: ActivityEvent[];
  }
}

export function logActivity(evt: Omit<ActivityEvent, "time">): void {
  if (typeof window === "undefined") return;
  const item: ActivityEvent = { ...evt, time: Date.now() };
  if (window[STORE_KEY] === undefined) {
    window[STORE_KEY] = [];
  }
  const store = window[STORE_KEY];
  if (store !== undefined) {
    store.unshift(item);
    if (store.length > 120) store.splice(120);
  }
  window.dispatchEvent(new CustomEvent(EVENT_NAME));
}

export function getActivity(): readonly ActivityEvent[] {
  if (typeof window === "undefined") return [];
  return window[STORE_KEY] ?? [];
}

export function useActivitySubscription(): readonly ActivityEvent[] {
  const [, force] = useState(0);
  useEffect(() => {
    const h = (): void => { force((n) => n + 1); };
    window.addEventListener(EVENT_NAME, h);
    return () => { window.removeEventListener(EVENT_NAME, h); };
  }, []);
  return getActivity();
}
