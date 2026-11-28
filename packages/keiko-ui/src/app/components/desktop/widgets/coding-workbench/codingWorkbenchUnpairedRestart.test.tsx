// U-22: Keiko restarted while a Workbench window stayed open. Its app session lived in the old
// process, so every run-scoped read answers HTTP 200 with the constant `{ session: "unpaired" }`
// projection. The window must turn that into the ONE stated pairing state — not into unrelated
// per-surface "could not be read" notices whose retries can never succeed — and reload by itself
// once a fresh pairing arrives. The response bodies come from the contract's own producers.
import { useReducer, type ReactNode } from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import { axe } from "jest-axe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { unpairedCodingWorkbenchRuntimeSkillsChannelPayload } from "@oscharko-dev/keiko-contracts/runtime/coding-skill-discovery";
import { unpairedCodingWorkbenchRuntimeMcpChannelPayload } from "@oscharko-dev/keiko-contracts/runtime/mcp-servers";
import {
  codingWorkbenchRuntimeReducer,
  createInitialCodingWorkbenchRuntimeState,
} from "@/lib/coding-workbench-live-state";
import { useCodingWorkbenchPairingEffect } from "@/lib/coding-workbench-runtime-effects";
import { notifyCodingAppSessionEstablished } from "@/lib/coding-app-session-client";
import { useCodingWorkbenchSkills } from "@/lib/useCodingWorkbenchSkills";
import { ApprovedSkillsDisclosure } from "./CodingWorkbenchApprovedSkills";
import { CodingWorkbenchMcpServers } from "./CodingWorkbenchMcpServers";
import { CodingWorkbenchPairingHold } from "./codingWorkbenchPairingHold";
import { useCodingWorkbenchTranslate } from "./coding-workbench-i18n";

const manifestAccessMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/workspace-manifest-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/workspace-manifest-api")>()),
  fetchWorkspaceManifestAccess: manifestAccessMock,
}));

const PAIRING_MESSAGE = /Workbench is not paired/u;
const PER_SURFACE_ERRORS = [/could not be read/u, /could not be loaded/u];

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/** The run-scoped reads of a window whose app session is gone, or one that is paired again. */
function serveRunReads(session: "unpaired" | "active"): void {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      if (url.endsWith("/skills")) {
        return Promise.resolve(
          jsonResponse(
            session === "unpaired"
              ? unpairedCodingWorkbenchRuntimeSkillsChannelPayload()
              : { session: "active" },
          ),
        );
      }
      if (url.endsWith("/mcp")) {
        return Promise.resolve(
          jsonResponse(
            session === "unpaired"
              ? unpairedCodingWorkbenchRuntimeMcpChannelPayload()
              : { session: "active" },
          ),
        );
      }
      return Promise.resolve(jsonResponse({}));
    }),
  );
}

function Window(): ReactNode {
  const t = useCodingWorkbenchTranslate();
  const [state, dispatch] = useReducer(codingWorkbenchRuntimeReducer, undefined, () =>
    createInitialCodingWorkbenchRuntimeState(),
  );
  useCodingWorkbenchPairingEffect(dispatch);
  const skills = useCodingWorkbenchSkills({ runId: "run-1", revision: 1 });
  return (
    <main>
      <p role="status">
        {state.pairing === "unpaired" ? t("codingWorkbench.pairing.unpaired") : ""}
      </p>
      <CodingWorkbenchPairingHold unpaired={state.pairing === "unpaired"}>
        <ApprovedSkillsDisclosure
          status={skills.status}
          skills={skills.skills ?? undefined}
          retry={skills.retry}
        />
        <CodingWorkbenchMcpServers runId="run-1" revision={1} />
      </CodingWorkbenchPairingHold>
    </main>
  );
}

describe("a restarted Keiko leaves an open Workbench window unpaired (U-22)", () => {
  beforeEach(() => {
    // The pairing was last confirmed before the restart; nothing re-reads the workspaces on its own.
    manifestAccessMock.mockResolvedValue({ session: "paired", manifests: [] });
    serveRunReads("unpaired");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    manifestAccessMock.mockReset();
  });

  it("states the unpaired window once, without per-surface read errors", async () => {
    manifestAccessMock.mockResolvedValue({ session: "unpaired", manifests: [] });
    const { container } = render(<Window />);

    await waitFor(() => {
      expect(screen.getByRole("status")).toHaveTextContent(PAIRING_MESSAGE);
    });
    for (const error of PER_SURFACE_ERRORS) expect(screen.queryByText(error)).toBeNull();
    expect(screen.queryByRole("button", { name: /try again/iu })).toBeNull();
    expect(screen.getAllByText(PAIRING_MESSAGE)).toHaveLength(1);
    expect((await axe(container)).violations).toEqual([]);
  });

  it("recognises the unpaired run reads although the pairing was confirmed before the restart", async () => {
    // The workspaces read answered `paired` at mount; only the run-scoped reads learn better.
    manifestAccessMock.mockResolvedValueOnce({ session: "paired", manifests: [] });
    manifestAccessMock.mockResolvedValue({ session: "unpaired", manifests: [] });
    render(<Window />);

    await waitFor(() => {
      expect(screen.getByRole("status")).toHaveTextContent(PAIRING_MESSAGE);
    });
    for (const error of PER_SURFACE_ERRORS) expect(screen.queryByText(error)).toBeNull();
  });

  it("reloads every surface by itself when a fresh pairing arrives in this tab", async () => {
    manifestAccessMock.mockResolvedValueOnce({ session: "paired", manifests: [] });
    manifestAccessMock.mockResolvedValue({ session: "unpaired", manifests: [] });
    render(<Window />);
    await waitFor(() => {
      expect(screen.getByRole("status")).toHaveTextContent(PAIRING_MESSAGE);
    });

    manifestAccessMock.mockResolvedValue({ session: "paired", manifests: [] });
    serveRunReads("active");
    await act(async () => {
      notifyCodingAppSessionEstablished();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.getByRole("status")).toBeEmptyDOMElement();
    });
    for (const error of PER_SURFACE_ERRORS) expect(screen.queryByText(error)).toBeNull();
  });
});
