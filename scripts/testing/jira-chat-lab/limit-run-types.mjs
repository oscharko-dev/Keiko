/**
 * Shared limit-run contracts fixed by the integrator in #4321.
 * Private facts stay in the existing exclusive intent; StepResult is body-free.
 * @typedef {{
 *   sessionDir: string,
 *   session: object,
 *   page: import("playwright").Page,
 *   projectKey: string,
 *   locale: "en" | "de",
 *   modelId: string,
 *   intent: object,
 *   signal: AbortSignal,
 * }} LimitContext
 */

/**
 * @typedef {{
 *   step: string,
 *   status: "green" | "red" | "unverified",
 *   detail: string,
 *   counts: Record<string, number>,
 *   evidenceFile?: string,
 * }} StepResult
 */

/**
 * The orchestrator supplies one existing browser Chat and its ordinary turn owner.
 * `intent.state` holds private component facts; `update(patch)` merges those facts,
 * and `record(name, value)` stores one fact through the existing privateJson owner.
 * Neither method replaces the orchestrator's run identity or completed-step list.
 * @typedef {LimitContext & {
 *   region: object,
 *   chat: object,
 *   projectPath: string,
 *   turn: Function,
 *   read: Function,
 *   search: Function,
 *   truth: object,
 *   permittedToken: string,
 *   deniedToken: string,
 * }} LimitBrowserContext
 */

/**
 * @typedef {{ maybeInject: (ctx: LimitContext, progress01: number) => Promise<unknown> }} FaultPlan
 */

export {};
