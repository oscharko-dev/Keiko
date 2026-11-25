"use client";

import { useEffect, useState } from "react";

const TICK_MS = 1_000;

/**
 * The client clock, ticking at most once per second and only while `active`: a settled run's or a
 * finished call's clock stops. One hook for the run's elapsed time and a running call's, so the two
 * cannot drift apart.
 */
export function useSecondClock(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return (): void => clearInterval(timer);
  }, [active]);
  return now;
}
