// Declaration for the shared Vitest worker count, so every vitest config can import it under
// TypeScript's strict noImplicitAny.
export const CI_MAX_WORKERS: number;
export const LOCAL_MAX_WORKERS: number;
export function vitestMaxWorkers(env?: Record<string, string | undefined>): number;
