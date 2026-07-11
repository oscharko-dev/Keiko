export interface RuntimeTimer {
  setInterval(callback: () => void, intervalMs: number): unknown;
  clearInterval(handle: unknown): void;
}

export function defaultRuntimeTimer(): RuntimeTimer {
  return {
    setInterval: (callback, intervalMs) => setInterval(callback, intervalMs),
    clearInterval: (handle): void => {
      clearInterval(handle as NodeJS.Timeout);
    },
  };
}
