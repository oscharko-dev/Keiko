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
 * The orchestrator supplies three existing Chats on one signed-in browser page.
 * `chat` is the document Chat with Knowledge and Jira; `reportChat` has only Jira;
 * `deniedChat` has only the verified restricted Jira Pod. Each runs in Full access.
 * A block sends only through `turn(chat, prompt, extra)` and never creates a Chat.
 * `intent.state` holds private component facts; `update(patch)` merges those facts,
 * and `record(name, value)` stores one fact through the existing privateJson owner.
 * Neither method replaces the orchestrator's run identity or completed-step list.
 * @typedef {LimitContext & {
 *   region: object,
 *   chat: object,
 *   reportChat: object,
 *   deniedChat: object,
 *   projectPath: string,
 *   turn: Function,
 *   recovery?: { restartServer: (options: { signal?: AbortSignal }) => Promise<{ restarted: true, downtimeMs: number }> },
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

/** @typedef {"bulk-epics" | "hierarchy" | "progress"} FaultScope */

export {};
