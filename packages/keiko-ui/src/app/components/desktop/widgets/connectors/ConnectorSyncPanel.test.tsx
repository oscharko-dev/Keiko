// Issue #2245 (AC — sync) — triggers a sync, updates live via polling, cancels, and renders terminal
// change summaries plus degradation remediation copy keyed to the backend failure reason codes.

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { describe, expect, it, vi } from "vitest";
import type {
  AtlassianSyncChangeSummary,
  AtlassianSyncJobState,
} from "@oscharko-dev/keiko-contracts";
import { ConnectorSyncPanel, type SyncClient } from "./ConnectorSyncPanel";

const COMMON = {
  schemaVersion: "1",
  jobId: "j1",
  connectorId: "c1",
  provider: "confluence",
  queuedAt: 0,
} as const;
const PROGRESS = {
  enumeratedItems: 5,
  fetchedItems: 2,
  indexedItems: 1,
  skippedItems: 0,
  failedItems: 0,
} as const;

function summary(outcome: AtlassianSyncChangeSummary["outcome"]): AtlassianSyncChangeSummary {
  return {
    schemaVersion: "1",
    outcome,
    counts: {
      addedItems: 3,
      changedItems: 1,
      removedItems: 0,
      unchangedItems: 2,
      failedItems: 0,
      deniedItems: 0,
    },
    fingerprintSetDigest: "abc",
    completedAt: 1,
  };
}

const RUNNING: AtlassianSyncJobState = {
  ...COMMON,
  progress: PROGRESS,
  status: "running",
  startedAt: 0,
};
const SUCCEEDED: AtlassianSyncJobState = {
  ...COMMON,
  progress: PROGRESS,
  status: "succeeded",
  startedAt: 0,
  completedAt: 1,
  changeSummary: summary("succeeded"),
};
const PARTIAL: AtlassianSyncJobState = {
  ...COMMON,
  progress: PROGRESS,
  status: "partial",
  startedAt: 0,
  completedAt: 1,
  changeSummary: summary("partial"),
  failureReasons: ["rate-limited"],
};
const CANCELLED: AtlassianSyncJobState = {
  ...COMMON,
  progress: PROGRESS,
  status: "cancelled",
  startedAt: 0,
  completedAt: 1,
  changeSummary: summary("cancelled"),
};

function makeClient(overrides: Partial<SyncClient> = {}): SyncClient {
  return {
    startSync: vi.fn(async () => ({ job: RUNNING })),
    getSyncJob: vi.fn(async () => ({ job: SUCCEEDED })),
    cancelSyncJob: vi.fn(async () => ({ job: CANCELLED })),
    ...overrides,
  };
}

async function addKeyAndStart(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.type(screen.getByLabelText("Confluence space keys"), "ENG");
  await user.click(screen.getByRole("button", { name: "Add key" }));
  await user.click(screen.getByRole("button", { name: "Start sync" }));
}

describe("ConnectorSyncPanel — start and live progress", () => {
  it("requires a scope key before starting", async () => {
    const user = userEvent.setup();
    const client = makeClient();
    render(<ConnectorSyncPanel client={client} authRef="a" provider="confluence" />);
    await user.click(screen.getByRole("button", { name: "Start sync" }));
    expect(screen.getByRole("alert")).toHaveTextContent(/at least one key/i);
    expect(vi.mocked(client.startSync)).not.toHaveBeenCalled();
  });

  it("starts a sync and updates live to the terminal change summary via polling", async () => {
    const user = userEvent.setup();
    const client = makeClient();
    render(
      <ConnectorSyncPanel client={client} authRef="a" provider="confluence" pollIntervalMs={5} />,
    );
    await addKeyAndStart(user);
    expect(vi.mocked(client.startSync)).toHaveBeenCalledWith("a", { spaceKeys: ["ENG"] });
    await waitFor(() =>
      expect(screen.getByTestId("acx-sync-badge")).toHaveTextContent("Succeeded"),
    );
    expect(vi.mocked(client.getSyncJob)).toHaveBeenCalled();
    expect(screen.getByTestId("acx-sync-changes")).toBeInTheDocument();
  });
});

describe("ConnectorSyncPanel — cancellation", () => {
  it("cancels an in-flight run and reaches the cancelled terminal state", async () => {
    const user = userEvent.setup();
    // Keep polling inert so the running job stays until cancel drives the terminal state.
    const client = makeClient({ getSyncJob: vi.fn(async () => ({ job: RUNNING })) });
    render(
      <ConnectorSyncPanel
        client={client}
        authRef="a"
        provider="confluence"
        pollIntervalMs={100000}
      />,
    );
    await addKeyAndStart(user);
    await user.click(await screen.findByRole("button", { name: "Cancel sync" }));
    expect(vi.mocked(client.cancelSyncJob)).toHaveBeenCalledWith("j1");
    await waitFor(() =>
      expect(screen.getByTestId("acx-sync-badge")).toHaveTextContent("Cancelled"),
    );
  });
});

describe("ConnectorSyncPanel — degradation", () => {
  it("renders remediation copy keyed to the backend reason code for a partial run", async () => {
    const user = userEvent.setup();
    const client = makeClient({ startSync: vi.fn(async () => ({ job: PARTIAL })) });
    render(
      <ConnectorSyncPanel
        client={client}
        authRef="a"
        provider="confluence"
        pollIntervalMs={100000}
      />,
    );
    await addKeyAndStart(user);
    const degraded = await screen.findByTestId("acx-sync-degraded");
    expect(degraded).toHaveTextContent(/rate-limited the sync/i);
    expect(screen.getByTestId("acx-sync-changes")).toBeInTheDocument();
  });

  it("has no axe violations with a terminal job (light and dark)", async () => {
    for (const theme of ["light", "dark"] as const) {
      document.documentElement.setAttribute("data-theme", theme);
      const user = userEvent.setup();
      const client = makeClient({ startSync: vi.fn(async () => ({ job: SUCCEEDED })) });
      const { container, unmount } = render(
        <ConnectorSyncPanel
          client={client}
          authRef="a"
          provider="confluence"
          pollIntervalMs={100000}
        />,
      );
      await addKeyAndStart(user);
      await screen.findByTestId("acx-sync-changes");
      expect(await axe(container)).toHaveNoViolations();
      unmount();
    }
    document.documentElement.removeAttribute("data-theme");
  });
});
