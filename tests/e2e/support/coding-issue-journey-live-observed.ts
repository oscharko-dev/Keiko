// #3390 — the qualification lane's observations, read from the interface the operator sees.
//
// The five flows only count as a real user's experience if BOTH halves hold: every action goes
// through a real control, and every fact the evidence asserts is one the interface actually shows.
// A lane that drives the UI but reads its verdict from a route the product itself never calls can
// pass over a window that displays nothing at all. These readers close that half.
//
// They read the SAME rendered status the operator reads, through the locale-independent
// `data-state` / `data-reason` / `data-fact` hooks the Code task's status cards carry
// (CodingWorkbenchDraftDelivery.tsx, CodingWorkbenchCiReadiness.tsx). Nothing here issues a
// request; every value is already on screen.
//
// Two things are deliberately NOT read here, and neither is a shortcut:
//
//   * The RUN ID. It is a correlation key, not a fact the interface owes the operator, and the
//     product keeps it out of the chrome on purpose. The lane takes it from the response the
//     product itself received for the operator's own "Start coding run" click — its own traffic,
//     never a request the lane makes.
//   * The task workspace ROOT. The workspace chip is content-free by construction and the raw
//     filesystem root was deliberately REMOVED from it (CodingWorkbenchWindow.tsx's own comment;
//     BoundRootTarget.tsx: "No root path, display name, manifest reference, or digest reaches this
//     render"). Scraping it back out of a hidden route would contradict a deliberate product
//     decision, so the lane asserts scope CONSISTENCY across the description requests the card
//     itself issues instead of comparing against a path no operator can see.

import { expect, type Locator, type Page } from "@playwright/test";
import type { GitCiCheckCounts } from "@oscharko-dev/keiko-contracts/runtime/git-delivery-provider";

const WORKBENCH = 'section[aria-label="Coding Workbench"][data-state]';
const CHECK_COUNTS = ["total", "passed", "failed", "pending", "blocked", "unknown"] as const;

/** The card owning `testId` — its NEAREST enclosing section, never an outer one. Scoping by the
 * card's own test id rather than by its translated `aria-label` keeps every reader below
 * independent of the operator's locale; taking the nearest ancestor rather than a `section:has(…)`
 * match keeps it off the workbench shell, which is itself a section and encloses every card. */
function cardWith(page: Page, testId: string): Locator {
  return page.getByTestId(testId).locator("xpath=ancestor::section[1]");
}

async function present(locator: Locator): Promise<boolean> {
  return (await locator.count()) > 0;
}

async function textOf(locator: Locator): Promise<string> {
  return ((await locator.first().textContent()) ?? "").trim();
}

/** A displayed fact, by its stable id. Readable while its `<details>` is still collapsed: the row
 * is in the DOM either way, and this never asserts visibility. */
async function fact(card: Locator, id: string): Promise<string> {
  const row = card.locator(`[data-fact="${id}"] dd`);
  if (!(await present(row))) {
    throw new Error(`the Code task did not display the "${id}" fact`);
  }
  return textOf(row);
}

async function attribute(locator: Locator, name: string): Promise<string> {
  const value = await locator.first().getAttribute(name);
  if (value === null || value.length === 0) {
    throw new Error(`the Code task did not display a "${name}" value`);
  }
  return value;
}

/** The run lifecycle state the window is showing. `idle` also stands for "no run", which is why no
 * caller may treat it as a terminal outcome. */
export async function observedRunState(page: Page): Promise<string> {
  return attribute(page.locator(WORKBENCH), "data-state");
}

export interface ObservedPullRequest {
  readonly number: number;
  readonly url: string;
  readonly headSha: string;
  readonly baseSha: string;
}

export interface ObservedDelivery {
  readonly phase: string;
  readonly reason: string;
  readonly repository: string;
  readonly issueNumber: number;
  readonly headRef: string;
  readonly headSha: string;
  readonly baseRef: string;
  readonly baseSha: string;
  readonly proposalId: string;
  readonly pullRequest: ObservedPullRequest | undefined;
}

/** The observed pull request is read from the card's own link HREF, not from its label: the number
 * in `.../pull/<n>` is the provider's, while the label is a translated sentence. */
async function observedPullRequest(card: Locator): Promise<ObservedPullRequest | undefined> {
  const link = card.getByRole("link");
  if (!(await present(link))) return undefined;
  const url = await attribute(link, "href");
  const number = /\/pull\/(\d+)(?:[/?#]|$)/u.exec(url)?.[1];
  if (number === undefined) {
    throw new Error("the Code task displayed a pull request link without a pull request number");
  }
  return {
    number: Number(number),
    url,
    headSha: await fact(card, "remoteHead"),
    baseSha: await fact(card, "remoteBase"),
  };
}

/** The Repository delivery card, or `undefined` while the run has recorded no delivery yet. */
export async function observedDelivery(page: Page): Promise<ObservedDelivery | undefined> {
  const card = cardWith(page, "cwb-draft-delivery-state");
  if (!(await present(card))) return undefined;
  const state = card.getByTestId("cwb-draft-delivery-state");
  const issueNumber = (await fact(card, "issueNumber")).replace(/^#/u, "");
  return {
    phase: await attribute(state, "data-state"),
    reason: await attribute(state, "data-reason"),
    repository: await fact(card, "repository"),
    issueNumber: Number(issueNumber),
    headRef: await fact(card, "headRef"),
    headSha: await fact(card, "headSha"),
    baseRef: await fact(card, "baseRef"),
    baseSha: await fact(card, "baseSha"),
    proposalId: await fact(card, "proposalId"),
    pullRequest: await observedPullRequest(card),
  };
}

export interface ObservedDescriptionStatus {
  readonly state: string;
  readonly reason: string;
  readonly headSha: string;
  readonly generationVersion: number;
  /** The "Review exact draft" control is on screen — the interface's own proof that a retained
   * proposal exists AND that the operator can act on it. The proposal id and its digests are never
   * rendered, and this lane never needs them: what was applied is checked against what was
   * reviewed, from the two responses the card's own clicks produce. */
  readonly reviewable: boolean;
}

/** The Pull request description card, or `undefined` while the run has generated no description. */
export async function observedDescriptionStatus(
  page: Page,
): Promise<ObservedDescriptionStatus | undefined> {
  const card = cardWith(page, "cwb-description-status");
  if (!(await present(card))) return undefined;
  const state = card.getByTestId("cwb-description-status");
  return {
    state: await attribute(state, "data-state"),
    reason: await attribute(state, "data-reason"),
    headSha: await fact(card, "headSha"),
    generationVersion: Number(await fact(card, "generationVersion")),
    reviewable: await present(card.getByTestId("cwb-description-review")),
  };
}

export interface ObservedCiReadiness {
  /** The card's DISPLAYED state, which is a superset of the recorded one: it also reports `stale`
   * for an observation the window no longer trusts and `unobserved` when none was recorded. A lane
   * waiting on this therefore waits for a currently trustworthy terminal readiness, which is
   * exactly what an operator would act on. */
  readonly state: string;
  readonly headSha: string;
  readonly requiredChecks: GitCiCheckCounts;
  readonly advisoryChecks: GitCiCheckCounts;
}

async function checkCounts(
  card: Locator,
  kind: "required" | "advisory",
): Promise<GitCiCheckCounts> {
  const group = card.locator(`[data-checks="${kind}"]`);
  const counts = await Promise.all(
    CHECK_COUNTS.map(
      async (name) =>
        [name, Number(await textOf(group.locator(`[data-count="${name}"] dd`)))] as const,
    ),
  );
  return Object.fromEntries(counts) as unknown as GitCiCheckCounts;
}

/** The CI readiness card, or `undefined` before a pull request exists to observe checks for. */
export async function observedCiReadiness(page: Page): Promise<ObservedCiReadiness | undefined> {
  const card = cardWith(page, "cwb-ci-state");
  if (!(await present(card))) return undefined;
  const state = await attribute(card.getByTestId("cwb-ci-state"), "data-state");
  if (state === "unobserved") return undefined;
  return {
    state,
    headSha: await fact(card, "headSha"),
    requiredChecks: await checkCounts(card, "required"),
    advisoryChecks: await checkCounts(card, "advisory"),
  };
}

/**
 * Waits for the Code task to report a coding runtime the operator could actually start a run with,
 * for the authority currently selected. Read from the window's own live status region — the one
 * surface that answers `runtimeAvailable` one-to-one. `Runtime ready.` is the platform-verified
 * runtime; the evaluation sentence is an unsigned but available one, which the product also allows
 * a run to start on. `Runtime unavailable.` and `Runtime refresh failed.` are neither.
 */
export async function assertObservedRuntimeReady(page: Page): Promise<void> {
  const status = page.locator(WORKBENCH).getByRole("status");
  await expect(status, "coding runtime must report ready before a run may start").toContainText(
    /Runtime ready\.|unverified evaluation runtime/u,
    { timeout: 60_000 },
  );
}

export interface ObservedRun {
  readonly state: string;
  readonly delivery: ObservedDelivery | undefined;
  readonly description: ObservedDescriptionStatus | undefined;
  readonly ciReadiness: ObservedCiReadiness | undefined;
}

/** One reading of everything the Code task is currently showing about its run. */
export async function observedRun(page: Page): Promise<ObservedRun> {
  return {
    state: await observedRunState(page),
    delivery: await observedDelivery(page),
    description: await observedDescriptionStatus(page),
    ciReadiness: await observedCiReadiness(page),
  };
}

/** What the window is telling the operator right now — its live status sentence plus any alert.
 * Carried into every failure message so a lane failure reads as the operator's own screen would,
 * rather than naming an internal code no window ever displayed. */
export async function observedDiagnosis(page: Page): Promise<string> {
  const shell = page.locator(WORKBENCH);
  const status = (await textOf(shell.getByRole("status"))).replace(/\s+/gu, " ");
  const alert = shell.getByRole("alert");
  const message = (await present(alert)) ? (await textOf(alert)).replace(/\s+/gu, " ") : "";
  return message.length === 0 ? status : `${status} ${message}`;
}
