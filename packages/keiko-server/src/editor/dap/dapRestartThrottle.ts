export interface DapRestartThrottle {
  mayStart(nowMs: number, debuggeeLaunched: boolean): boolean;
  attemptCount(): number;
}

export function createDapRestartThrottle(): DapRestartThrottle {
  const attempts: number[] = [];
  return {
    mayStart: (nowMs, debuggeeLaunched): boolean => {
      if (debuggeeLaunched) return false;
      const cutoff = nowMs - 60_000;
      const retained = attempts.filter((timestamp) => timestamp > cutoff);
      attempts.length = 0;
      attempts.push(...retained);
      if (attempts.length >= 2) return false;
      attempts.push(nowMs);
      return true;
    },
    attemptCount: (): number => attempts.length,
  };
}
