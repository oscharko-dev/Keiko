import { useEffect, useState } from "react";
import type { JourneyOutcome } from "@oscharko-dev/keiko-contracts/runtime/git-journey-outcome";

/** Each independent evidence lease can expire before the overall lifecycle observation. */
export function useJourneyClock(outcome: JourneyOutcome): number {
  const [now, setNow] = useState(() => Date.now());
  const observation = outcome.expiresAt;
  const ci = outcome.readiness?.expiresAt;
  const description = outcome.description?.expiresAt;
  useEffect(() => {
    const update = (): void => {
      setNow(Date.now());
    };
    const leases = [observation, ci, description].filter(
      (value): value is string => value !== undefined,
    );
    const timers = [
      globalThis.setTimeout(update, 0),
      ...leases.map((value) =>
        globalThis.setTimeout(update, Math.max(0, Date.parse(value) - Date.now()) + 1),
      ),
    ];
    document.addEventListener("visibilitychange", update);
    globalThis.addEventListener("pageshow", update);
    return (): void => {
      for (const timer of timers) globalThis.clearTimeout(timer);
      document.removeEventListener("visibilitychange", update);
      globalThis.removeEventListener("pageshow", update);
    };
  }, [observation, ci, description]);
  return now;
}
