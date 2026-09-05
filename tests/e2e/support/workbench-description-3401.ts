import { expect, type Page, type Route } from "@playwright/test";

const RUN_ID = "run-description-race-3401";
const OLD_PROPOSAL = "proposal-old-3401";
const NEW_PROPOSAL = "proposal-new-3401";
const OLD_SNAPSHOT = "a".repeat(64);
const NEW_SNAPSHOT = "b".repeat(64);
const OLD_HEAD = "2".repeat(40);
const NEW_HEAD = "3".repeat(40);
const OBSERVED_AT = "2026-09-05T18:00:00.000Z";
const EXPIRES_AT = "2030-09-05T18:00:00.000Z";

const KINDS = {
  add: 0,
  modify: 1,
  delete: 0,
  rename: 0,
  copy: 0,
  "mode-change": 0,
  binary: 0,
  submodule: 0,
} as const;

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function descriptionStatus(
  proposalId: string,
  snapshotDigest: string,
  headSha: string,
  draftDigest: string,
): Record<string, unknown> {
  return {
    schemaVersion: "1",
    runId: RUN_ID,
    remoteDigest: "e".repeat(64),
    baseSha: "1".repeat(40),
    headSha,
    generationVersion: 1,
    state: "current",
    reason: "generated",
    snapshotDigest,
    draftDigest,
    artifactOutcome: "complete",
    proposalId,
    observedAt: OBSERVED_AT,
  };
}

function runtimeSnapshot(current: "old" | "new"): Record<string, unknown> {
  const next = current === "old";
  return {
    schemaVersion: "1",
    state: next ? "running" : "succeeded",
    revision: next ? 1 : 2,
    updatedAt: OBSERVED_AT,
    runId: RUN_ID,
    descriptionStatus: next
      ? descriptionStatus(OLD_PROPOSAL, OLD_SNAPSHOT, OLD_HEAD, "c".repeat(64))
      : descriptionStatus(NEW_PROPOSAL, NEW_SNAPSHOT, NEW_HEAD, "d".repeat(64)),
  };
}

function artifactCoverage(): Record<string, unknown> {
  return {
    snapshot: {
      totalFiles: 1,
      files: 1,
      hunks: 1,
      bytes: 32,
      omittedFiles: 0,
      omittedHunks: 0,
      truncatedFiles: 0,
      kinds: KINDS,
      omissions: [],
    },
    suppliedEvidenceCount: 1,
    processedEvidenceCount: 1,
    omittedEvidenceCount: 0,
  };
}

function artifactCandidate(old: boolean, evidenceId: string): Record<string, unknown> {
  return {
    summary: [
      {
        text: old ? "Old head draft" : "Current generic Workbench draft",
        evidenceIds: [evidenceId],
      },
    ],
    keyChanges: [{ text: "One bounded change", evidenceIds: [evidenceId] }],
    risks: [],
    reviewerFocus: [],
  };
}

function descriptionArtifact(current: "old" | "new"): Record<string, unknown> {
  const old = current === "old";
  const snapshotDigest = old ? OLD_SNAPSHOT : NEW_SNAPSHOT;
  const evidenceId = old ? "4".repeat(64) : "5".repeat(64);
  return {
    schemaVersion: "1",
    renderingVersion: "1",
    binding: {
      repositoryId: "repository-3401",
      baseRef: "main",
      baseSha: "1".repeat(40),
      headRef: "feature/no-pr",
      headSha: old ? OLD_HEAD : NEW_HEAD,
      mergeBaseSha: "1".repeat(40),
      snapshotDigest,
    },
    language: "en",
    outcome: "complete",
    reason: "none",
    coverage: artifactCoverage(),
    candidate: artifactCandidate(old, evidenceId),
    markdown: old
      ? "## Summary\n\nOld head draft that must never replace the newer response."
      : "## Summary\n\nCurrent generic Workbench draft\n\n## Key changes\n\n- One bounded change",
    artifactDigest: old ? "c".repeat(64) : "d".repeat(64),
  };
}

function draftResponse(current: "old" | "new"): Record<string, unknown> {
  return {
    outcome: "draft",
    draft: {
      schemaVersion: "1",
      proposalId: current === "old" ? OLD_PROPOSAL : NEW_PROPOSAL,
      expiresAt: EXPIRES_AT,
      artifact: descriptionArtifact(current),
    },
  };
}

async function fulfillJson(route: Route, body: unknown): Promise<void> {
  await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
}

export async function seedWorkbenchDescriptionWindow(page: Page, root: string): Promise<void> {
  await page.addInitScript(
    ({ repositoryRoot }) => {
      window.localStorage.setItem(
        "keiko.workspace.v4",
        JSON.stringify([
          {
            id: "issue-3401-workbench-window",
            type: "coding",
            x: 24,
            y: 24,
            w: 1120,
            h: 1400,
            z: 20,
            zoom: 1,
            cfg: { repositoryPath: repositoryRoot },
            max: false,
          },
        ]),
      );
      window.localStorage.removeItem("keiko.conns.v1");
    },
    { repositoryRoot: root },
  );
}

export interface WorkbenchDescriptionRaceObservation {
  readonly oldRequestStarted: Promise<void>;
  readonly advanceToNewHead: () => void;
  readonly releaseOldResponse: () => void;
  readonly calls: { oldDraft: number; newDraft: number; status: number; stream: number };
  readonly currentMarkdown: string;
  readonly oldMarkdown: string;
  readonly newHeadSha: string;
}

interface RaceState {
  current: "old" | "new";
  readonly calls: WorkbenchDescriptionRaceObservation["calls"];
  readonly oldStarted: ReturnType<typeof deferred>;
  readonly releaseOld: ReturnType<typeof deferred>;
  readonly releaseStream: ReturnType<typeof deferred>;
}

async function installStatusRoute(page: Page, state: RaceState): Promise<void> {
  await page.route("**/api/coding-workbench/runtime/status", async (route) => {
    state.calls.status += 1;
    await fulfillJson(route, runtimeSnapshot(state.current));
  });
}

async function installStreamRoute(page: Page, state: RaceState): Promise<void> {
  await page.route(`**/api/coding-workbench/runtime/runs/${RUN_ID}/events`, async (route) => {
    state.calls.stream += 1;
    await state.releaseStream.promise;
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: `event: status\ndata: ${JSON.stringify({
        schemaVersion: "1",
        cursor: "status-2",
        sequence: 2,
        occurredAt: OBSERVED_AT,
        kind: "status",
        runId: RUN_ID,
        state: "succeeded",
        revision: 2,
      })}\n\n`,
    });
  });
}

async function handleDraftRoute(route: Route, state: RaceState): Promise<void> {
  const proposalId = new URL(route.request().url()).searchParams.get("proposalId");
  if (proposalId === OLD_PROPOSAL) {
    state.calls.oldDraft += 1;
    state.oldStarted.resolve();
    await state.releaseOld.promise;
    await fulfillJson(route, draftResponse("old"));
    return;
  }
  expect(proposalId).toBe(NEW_PROPOSAL);
  state.calls.newDraft += 1;
  await fulfillJson(route, draftResponse("new"));
}

async function installDraftRoute(page: Page, state: RaceState): Promise<void> {
  await page.route(`**/api/coding-workbench/runtime/runs/${RUN_ID}/description-draft?**`, (route) =>
    handleDraftRoute(route, state),
  );
}

export async function interceptWorkbenchDescriptionRace(
  page: Page,
): Promise<WorkbenchDescriptionRaceObservation> {
  const oldStarted = deferred();
  const releaseOld = deferred();
  const releaseStream = deferred();
  const calls = { oldDraft: 0, newDraft: 0, status: 0, stream: 0 };
  const state: RaceState = { current: "old", calls, oldStarted, releaseOld, releaseStream };
  await installStatusRoute(page, state);
  await installStreamRoute(page, state);
  await installDraftRoute(page, state);
  return {
    oldRequestStarted: oldStarted.promise,
    advanceToNewHead: (): void => {
      state.current = "new";
      releaseStream.resolve();
    },
    releaseOldResponse: releaseOld.resolve,
    calls,
    currentMarkdown: String(descriptionArtifact("new").markdown),
    oldMarkdown: String(descriptionArtifact("old").markdown),
    newHeadSha: NEW_HEAD,
  };
}
