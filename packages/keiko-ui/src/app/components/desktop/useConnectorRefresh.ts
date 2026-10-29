"use client";
import { useEffect, useRef } from "react";
import { ATLASSIAN_CONNECTORS_CHANGED_EVENT } from "@/lib/atlassian-connectors-api";

/** Mutation events and focus request a canonical read; neither event carries authority. */
export function useConnectorRefresh(refresh: () => void): void {
  const latest = useRef(refresh);
  latest.current = refresh;
  useEffect(() => {
    const reload = (): void => latest.current();
    window.addEventListener(ATLASSIAN_CONNECTORS_CHANGED_EVENT, reload);
    window.addEventListener("focus", reload);
    return (): void => {
      window.removeEventListener(ATLASSIAN_CONNECTORS_CHANGED_EVENT, reload);
      window.removeEventListener("focus", reload);
    };
  }, []);
}
