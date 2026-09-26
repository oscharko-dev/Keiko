import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CodingWorkbenchRuntimeSkillsChannelPayload,
  SkillDiscoveryResultV1,
} from "@oscharko-dev/keiko-contracts";
import { validateSkillDiscoveryResultV1 } from "@oscharko-dev/keiko-contracts/runtime/coding-skill-discovery";

import {
  useCodingWorkbenchSkills,
  type UseCodingWorkbenchSkillsInput,
} from "./useCodingWorkbenchSkills";
import { encodeCodingAppSessionPairingFragment } from "@oscharko-dev/keiko-contracts/runtime/coding-app-session";
import {
  redeemCodingAppSessionPairingNavigation,
  type CodingAppSessionPairingSeams,
} from "./coding-app-session-client";
import { ApiError } from "./api";
import { resetClientDiagnosticWriter, setClientDiagnosticWriter } from "./client-diagnostics";

const getSkillsMock = vi.hoisted(() => vi.fn());
const pairingSettledMock = vi.hoisted(() => vi.fn());

vi.mock("./coding-app-session-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./coding-app-session-client")>()),
  codingAppSessionPairingSettled: pairingSettledMock,
}));

vi.mock("./coding-workbench-runtime-api", () => ({
  getCodingWorkbenchRuntimeSkills: getSkillsMock,
}));

const LISTING: SkillDiscoveryResultV1 = ((): SkillDiscoveryResultV1 => {
  const validated = validateSkillDiscoveryResultV1({
    schemaVersion: 1,
    catalogDigest: "a".repeat(64),
    skills: [
      {
        skillId: "skl_repo-structure-summary@1",
        version: "1",
        sourceDigest: "b".repeat(64),
        category: "repository-analysis",
        capabilities: ["keiko.workspace.read"],
        compatibility: { profile: "opencode", minVersion: 1, maxVersion: 1 },
        readiness: { state: "ready" },
      },
    ],
  });
  if (!validated.ok) throw new Error(`fixture is not a listing: ${validated.errors.join(", ")}`);
  return validated.value;
})();

function active(
  skills: SkillDiscoveryResultV1 = LISTING,
): CodingWorkbenchRuntimeSkillsChannelPayload {
  return { session: "active", skills };
}

/** A paired run whose server composed no projection: active, with no listing at all. */
const ACTIVE_WITHOUT_LISTING: CodingWorkbenchRuntimeSkillsChannelPayload = { session: "active" };

const RUN: UseCodingWorkbenchSkillsInput = { runId: "run-1", revision: 4 };

beforeEach(() => {
  getSkillsMock.mockReset();
  pairingSettledMock.mockReset();
  pairingSettledMock.mockResolvedValue(true);
});

afterEach(() => {
  resetClientDiagnosticWriter();
});

describe("useCodingWorkbenchSkills (#3417)", () => {
  it("reads the run's approved skills from the authenticated channel", async () => {
    getSkillsMock.mockResolvedValue(active());

    const { result } = renderHook(() => useCodingWorkbenchSkills(RUN));

    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.skills).toEqual(LISTING);
    expect(getSkillsMock).toHaveBeenCalledWith("run-1", expect.any(AbortSignal));
  });

  it("reports a run whose runtime carries no projection as ready without a listing", async () => {
    getSkillsMock.mockResolvedValue(ACTIVE_WITHOUT_LISTING);

    const { result } = renderHook(() => useCodingWorkbenchSkills(RUN));

    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.skills).toBeNull();
  });

  it("stays idle with no run", () => {
    const { result } = renderHook(() =>
      useCodingWorkbenchSkills({ runId: undefined, revision: undefined }),
    );

    expect(result.current.status).toBe("idle");
    expect(getSkillsMock).not.toHaveBeenCalled();
  });

  it("reports unavailable - never a silent empty listing - when the window is unpaired", async () => {
    getSkillsMock.mockResolvedValue({ session: "unpaired" });

    const { result } = renderHook(() => useCodingWorkbenchSkills(RUN));

    await waitFor(() => expect(result.current.status).toBe("unavailable"));
    expect(result.current.skills).toBeNull();
  });

  it("reports unavailable and keeps the failure diagnosable when the read fails", async () => {
    const written: { readonly message: string; readonly correlationId?: string }[] = [];
    setClientDiagnosticWriter((message, options) => {
      written.push({
        message,
        ...(options?.correlationId === undefined ? {} : { correlationId: options.correlationId }),
      });
    });
    const failure = new ApiError("INTERNAL", "skills channel unavailable", 503);
    failure.correlationId = "corr-77";
    getSkillsMock.mockRejectedValue(failure);

    const { result } = renderHook(() => useCodingWorkbenchSkills(RUN));

    await waitFor(() => expect(result.current.status).toBe("unavailable"));
    expect(written.at(-1)?.message).toContain("skills channel read failed");
    expect(written.at(-1)?.correlationId).toBe("corr-77");
  });

  it("re-reads on demand via retry() without any input changing", async () => {
    getSkillsMock.mockResolvedValue(active());
    const { result } = renderHook(() => useCodingWorkbenchSkills(RUN));
    await waitFor(() => expect(getSkillsMock).toHaveBeenCalledTimes(1));

    act(() => {
      result.current.retry();
    });

    await waitFor(() => expect(getSkillsMock).toHaveBeenCalledTimes(2));
  });

  it("re-reads when the runtime revision replaces the current truth", async () => {
    getSkillsMock.mockResolvedValue(active());
    const { rerender } = renderHook(
      (input: UseCodingWorkbenchSkillsInput) => useCodingWorkbenchSkills(input),
      { initialProps: RUN },
    );
    await waitFor(() => expect(getSkillsMock).toHaveBeenCalledTimes(1));

    rerender({ ...RUN, revision: 5 });

    await waitFor(() => expect(getSkillsMock).toHaveBeenCalledTimes(2));
  });
});

// A launcher re-pair that arrives without a page load (F65): a fragment, and a pair endpoint that
// acknowledges it.
const REPAIR_SEAMS: CodingAppSessionPairingSeams = {
  readFragment: (): string =>
    encodeCodingAppSessionPairingFragment({
      requestId: "req_skills-re-pair",
      issuedAtMs: 1,
      claim: "e".repeat(64),
    }),
  stripFragment: (): void => undefined,
  postPairing: (): Promise<unknown> => Promise.resolve({ schemaVersion: "1" }),
};

describe("useCodingWorkbenchSkills after a re-pair without a page load (F65)", () => {
  it("reads the skills channel again", async () => {
    getSkillsMock.mockResolvedValue(active());
    renderHook(() => useCodingWorkbenchSkills(RUN));
    await waitFor(() => expect(getSkillsMock).toHaveBeenCalled());
    const before = getSkillsMock.mock.calls.length;

    await act(async () => {
      await redeemCodingAppSessionPairingNavigation(REPAIR_SEAMS);
    });

    await waitFor(() => expect(getSkillsMock.mock.calls.length).toBeGreaterThan(before));
  });
});
