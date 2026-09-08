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
/** The window's own lifecycle announcement. Selected by element rather than by role: `<output>` has
 * the implicit `status` role, so several cards would otherwise match. */
export const LIFECYCLE_STATUS = 'p.sr-only[role="status"]';
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

/** One card, as it stood in a single paint. */
interface CardReading {
  readonly state: string | null;
  readonly reason: string | null;
  readonly facts: Readonly<Record<string, string>>;
  readonly checks: Readonly<Record<string, Readonly<Record<string, string>>>>;
  readonly href: string | null;
  readonly testIds: readonly string[];
}

/**
 * Reads a whole card in ONE round trip, so every value comes from the same paint.
 *
 * Reading attribute by attribute over separate round trips is a torn read: the Code task is driven
 * by a live event stream, so an update landing between two of them yields a reading that never
 * existed — a delivery phase from before it beside a head SHA from after. The route this replaced
 * returned one JSON document and was atomic by construction; this restores that property against
 * the DOM. Facts inside a collapsed `<details>` are included: the rows are in the DOM either way,
 * and nothing here asserts visibility.
 */
async function readCard(card: Locator): Promise<CardReading | undefined> {
  if (!(await present(card))) return undefined;
  return card.evaluate((root: Element): CardReading => {
    const text = (node: Element | null | undefined): string => (node?.textContent ?? "").trim();
    const collect = <T>(
      selector: string,
      key: string,
      value: (element: Element) => T,
    ): Record<string, T> => {
      const entries: Record<string, T> = {};
      for (const element of root.querySelectorAll(selector)) {
        const id = element.getAttribute(key);
        if (id !== null && id.length > 0) entries[id] = value(element);
      }
      return entries;
    };
    const status = root.querySelector("[data-state]");
    return {
      state: status?.getAttribute("data-state") ?? null,
      reason: status?.getAttribute("data-reason") ?? null,
      facts: collect("[data-fact]", "data-fact", (row) => text(row.querySelector("dd"))),
      checks: collect("[data-checks]", "data-checks", (group) => {
        const counts: Record<string, string> = {};
        for (const cell of group.querySelectorAll("[data-count]")) {
          const name = cell.getAttribute("data-count");
          if (name !== null) counts[name] = text(cell.querySelector("dd"));
        }
        return counts;
      }),
      href: root.querySelector("a")?.getAttribute("href") ?? null,
      testIds: Object.keys(collect("[data-testid]", "data-testid", () => true)),
    };
  });
}

function fact(reading: CardReading, id: string): string {
  const value = reading.facts[id];
  if (value === undefined || value.length === 0) {
    throw new Error(`the Code task did not display the "${id}" fact`);
  }
  return value;
}

function displayed(value: string | null, what: string): string {
  if (value === null || value.length === 0) {
    throw new Error(`the Code task did not display a "${what}" value`);
  }
  return value;
}

async function attribute(locator: Locator, name: string): Promise<string> {
  return displayed(await locator.first().getAttribute(name), name);
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
function observedPullRequest(reading: CardReading): ObservedPullRequest | undefined {
  const url = reading.href;
  if (url === null) return undefined;
  const number = /\/pull\/(\d+)(?:[/?#]|$)/u.exec(url)?.[1];
  if (number === undefined) {
    throw new Error("the Code task displayed a pull request link without a pull request number");
  }
  return {
    number: Number(number),
    url,
    headSha: fact(reading, "remoteHead"),
    baseSha: fact(reading, "remoteBase"),
  };
}

/** The Repository delivery card, or `undefined` while the run has recorded no delivery yet. */
export async function observedDelivery(page: Page): Promise<ObservedDelivery | undefined> {
  const reading = await readCard(cardWith(page, "cwb-draft-delivery-state"));
  if (reading === undefined) return undefined;
  return {
    phase: displayed(reading.state, "delivery phase"),
    reason: displayed(reading.reason, "delivery reason"),
    repository: fact(reading, "repository"),
    issueNumber: Number(fact(reading, "issueNumber").replace(/^#/u, "")),
    headRef: fact(reading, "headRef"),
    headSha: fact(reading, "headSha"),
    baseRef: fact(reading, "baseRef"),
    baseSha: fact(reading, "baseSha"),
    proposalId: fact(reading, "proposalId"),
    pullRequest: observedPullRequest(reading),
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
  const reading = await readCard(cardWith(page, "cwb-description-status"));
  if (reading === undefined) return undefined;
  return {
    state: displayed(reading.state, "description state"),
    reason: displayed(reading.reason, "description reason"),
    headSha: fact(reading, "headSha"),
    generationVersion: Number(fact(reading, "generationVersion")),
    reviewable: reading.testIds.includes("cwb-description-review"),
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

function checkCounts(reading: CardReading, kind: "required" | "advisory"): GitCiCheckCounts {
  const group = reading.checks[kind];
  if (group === undefined) {
    throw new Error(`the Code task did not display the ${kind} CI check counts`);
  }
  const counts = CHECK_COUNTS.map((name) => {
    const value = Number(group[name]);
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`the Code task displayed no ${kind} "${name}" CI check count`);
    }
    return [name, value] as const;
  });
  return Object.fromEntries(counts) as unknown as GitCiCheckCounts;
}

/** The CI readiness card, or `undefined` before a pull request exists to observe checks for. */
export async function observedCiReadiness(page: Page): Promise<ObservedCiReadiness | undefined> {
  const reading = await readCard(cardWith(page, "cwb-ci-state"));
  if (reading === undefined) return undefined;
  const state = displayed(reading.state, "CI readiness state");
  if (state === "unobserved") return undefined;
  return {
    state,
    headSha: fact(reading, "headSha"),
    requiredChecks: checkCounts(reading, "required"),
    advisoryChecks: checkCounts(reading, "advisory"),
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
  const status = page.locator(WORKBENCH).locator(LIFECYCLE_STATUS);
  await expect(status, "coding runtime must report ready before a run may start").toContainText(
    /Runtime ready\.|unverified evaluation runtime/u,
    { timeout: 60_000 },
  );
}

export interface ObservedCommitReceipt {
  readonly status: string;
  readonly reason: string;
  readonly headSha: string;
  readonly verificationEvidenceId: string;
  readonly proposalId: string;
}

/** The verified commit receipt, or `undefined` while none is displayed. The card renders ONLY for
 * the run the window is currently showing (`result.runId === runId`, CodingWorkbenchCommitResult.tsx),
 * so its presence is itself the interface's own proof that the receipt belongs to this run — which
 * is why nothing here compares a run id the window never displays. */
export async function observedCommitReceipt(
  page: Page,
): Promise<ObservedCommitReceipt | undefined> {
  const reading = await readCard(cardWith(page, "cwb-commit-result"));
  if (reading === undefined) return undefined;
  return {
    status: displayed(reading.state, "commit receipt status"),
    reason: displayed(reading.reason, "commit receipt reason"),
    headSha: fact(reading, "headSha"),
    verificationEvidenceId: fact(reading, "verificationEvidenceId"),
    proposalId: fact(reading, "proposalId"),
  };
}

export interface ObservedRun {
  readonly state: string;
  readonly delivery: ObservedDelivery | undefined;
  readonly description: ObservedDescriptionStatus | undefined;
  readonly ciReadiness: ObservedCiReadiness | undefined;
  readonly commitReceipt: ObservedCommitReceipt | undefined;
}

/** One reading of everything the Code task is currently showing about its run. */
export async function observedRun(page: Page): Promise<ObservedRun> {
  return {
    state: await observedRunState(page),
    delivery: await observedDelivery(page),
    description: await observedDescriptionStatus(page),
    ciReadiness: await observedCiReadiness(page),
    commitReceipt: await observedCommitReceipt(page),
  };
}

/** What the window is telling the operator right now — its live status sentence plus any alert.
 * Carried into every failure message so a lane failure reads as the operator's own screen would,
 * rather than naming an internal code no window ever displayed. */
export async function observedDiagnosis(page: Page): Promise<string> {
  const shell = page.locator(WORKBENCH);
  const status = (await textOf(shell.locator(LIFECYCLE_STATUS))).replace(/\s+/gu, " ");
  const alert = shell.getByRole("alert");
  const message = (await present(alert)) ? (await textOf(alert)).replace(/\s+/gu, " ") : "";
  return message.length === 0 ? status : `${status} ${message}`;
}
