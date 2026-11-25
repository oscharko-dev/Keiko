import { act, renderHook } from "@testing-library/react";
import { useLayoutEffect } from "react";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import type { ProjectWithAvailability } from "@/lib/types";
import { reportGitClientOperationDiagnostic } from "./git-client-operation-diagnostics";
import type { GitClientSeam } from "./git-client-seam";
import {
  useHandedOffRepositoryConnection,
  type HandedOffRepositoryConnectionInput,
} from "./useHandedOffRepositoryConnection";

vi.mock("./git-client-operation-diagnostics", () => ({
  reportGitClientOperationDiagnostic: vi.fn(),
}));

const HANDED_OFF: ProjectWithAvailability = {
  path: "/repos/handed-off",
  name: "handed-off",
  favorite: false,
  createdAt: 0,
  lastOpenedAt: 0,
  available: true,
  workspaceAvailable: true,
};

interface Deferred {
  readonly promise: Promise<{ readonly project: ProjectWithAvailability }>;
  readonly resolve: (project: ProjectWithAvailability) => void;
  readonly reject: (error: unknown) => void;
}

function deferred(): Deferred {
  let resolve: Deferred["resolve"] = (): void => undefined;
  let reject: Deferred["reject"] = (): void => undefined;
  const promise = new Promise<{ readonly project: ProjectWithAvailability }>((ok, fail) => {
    resolve = (project): void => {
      ok({ project });
    };
    reject = fail;
  });
  return { promise, resolve, reject };
}

function harness(overrides: Partial<HandedOffRepositoryConnectionInput> = {}): {
  readonly input: HandedOffRepositoryConnectionInput;
  readonly registration: Deferred;
  readonly registerRepository: Mock<GitClientSeam["registerRepository"]>;
} {
  const registration = deferred();
  const registerRepository = vi.fn<GitClientSeam["registerRepository"]>(() => registration.promise);
  const client: Pick<GitClientSeam, "registerRepository"> = { registerRepository };
  const input: HandedOffRepositoryConnectionInput = {
    handOffPath: HANDED_OFF.path,
    client: client as GitClientSeam,
    actionSequence: { current: 0 },
    onStarted: vi.fn(),
    onAdded: vi.fn(),
    onFailed: vi.fn(),
    onSettled: vi.fn(),
    onSuperseded: vi.fn(),
    ...overrides,
  };
  return { input, registration, registerRepository };
}

type Registration = Awaited<ReturnType<GitClientSeam["registerRepository"]>>;

// A registration whose outcome the test delivers synchronously, at an exact point of a commit.
function synchronousRegistration(): {
  readonly result: ReturnType<GitClientSeam["registerRepository"]>;
  readonly settle: (value: Registration) => void;
} {
  let onFulfilled: ((value: Registration) => void) | undefined;
  const thenable = {
    then(fulfilled: (value: Registration) => void): void {
      onFulfilled = fulfilled;
    },
  };
  return {
    result: thenable as unknown as ReturnType<GitClientSeam["registerRepository"]>,
    settle: (value): void => {
      onFulfilled?.(value);
    },
  };
}

// Delivers the outcome in a layout effect of the commit that carries the newer hand-off, before
// any passive effect of that commit ran.
function useConnectionSettlingOnCommit(
  input: HandedOffRepositoryConnectionInput,
  settleOnNewerHandOff: () => void,
): (path: string) => void {
  const connect = useHandedOffRepositoryConnection(input);
  useLayoutEffect((): void => {
    if (input.handOffPath !== HANDED_OFF.path) settleOnNewerHandOff();
  }, [input.handOffPath, settleOnNewerHandOff]);
  return connect;
}

describe("useHandedOffRepositoryConnection (#4103 F2)", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("registers a handed-off path once while the hand-off is pending, with body-free evidence", async () => {
    const { input, registration, registerRepository } = harness();
    const { result } = renderHook(() => useHandedOffRepositoryConnection(input));

    act(() => {
      result.current(HANDED_OFF.path);
      result.current(HANDED_OFF.path);
    });
    expect(registerRepository).toHaveBeenCalledExactlyOnceWith(
      { path: HANDED_OFF.path },
      expect.any(String),
    );
    expect(input.onStarted).toHaveBeenCalledOnce();
    expect(input.actionSequence.current).toBe(1);

    await act(async () => {
      registration.resolve(HANDED_OFF);
      await registration.promise;
    });
    expect(input.onSettled).toHaveBeenCalledOnce();
    expect(input.onAdded).toHaveBeenCalledExactlyOnceWith(HANDED_OFF);
    expect(input.onFailed).not.toHaveBeenCalled();
    expect(vi.mocked(reportGitClientOperationDiagnostic).mock.calls.map((call) => call[1])).toEqual(
      [
        { operation: "repository-register", outcome: "started" },
        { operation: "repository-register", outcome: "succeeded" },
      ],
    );
  });

  it("connects a different handed-off path in the same mount", () => {
    const { input, registerRepository } = harness({ handOffPath: "/repos/first" });
    const { result, rerender } = renderHook(
      (props: HandedOffRepositoryConnectionInput) => useHandedOffRepositoryConnection(props),
      { initialProps: input },
    );

    act(() => {
      result.current("/repos/first");
    });
    rerender({ ...input, handOffPath: "/repos/second" });
    act(() => {
      result.current("/repos/second");
    });
    expect(registerRepository.mock.calls.map((call) => call[0])).toEqual([
      { path: "/repos/first" },
      { path: "/repos/second" },
    ]);
  });

  it("lets a new hand-off connect the same path again once the previous one settled", () => {
    const { input, registerRepository } = harness();
    const { result, rerender } = renderHook(
      (props: HandedOffRepositoryConnectionInput) => useHandedOffRepositoryConnection(props),
      { initialProps: input },
    );

    act(() => {
      result.current(HANDED_OFF.path);
    });
    rerender({ ...input, handOffPath: null });
    rerender(input);
    act(() => {
      result.current(HANDED_OFF.path);
    });
    expect(registerRepository).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["no pending hand-off", null],
    ["a hand-off of another folder", "/repos/other"],
  ])("never registers a path when there is %s", (_case, handOffPath) => {
    const { input, registerRepository } = harness({ handOffPath });
    const { result } = renderHook(() => useHandedOffRepositoryConnection(input));

    act(() => {
      result.current(HANDED_OFF.path);
    });
    expect(registerRepository).not.toHaveBeenCalled();
    expect(input.onStarted).not.toHaveBeenCalled();
  });

  it("reports a failed registration and hands the error to the window", async () => {
    const { input, registration } = harness();
    const { result } = renderHook(() => useHandedOffRepositoryConnection(input));
    const error = new Error("not a git repository");

    act(() => {
      result.current(HANDED_OFF.path);
    });
    await act(async () => {
      registration.reject(error);
      await registration.promise.catch((): undefined => undefined);
    });
    expect(input.onSettled).toHaveBeenCalledOnce();
    expect(input.onFailed).toHaveBeenCalledExactlyOnceWith(error, HANDED_OFF.path);
    expect(input.onAdded).not.toHaveBeenCalled();
    expect(vi.mocked(reportGitClientOperationDiagnostic).mock.calls.at(-1)?.[1]).toEqual({
      operation: "repository-register",
      outcome: "failed",
    });
  });

  it.each(["resolve", "reject"] as const)(
    "only ends the hand-off when a newer repository action started before it could %s",
    async (outcome) => {
      const { input, registration } = harness();
      const { result } = renderHook(() => useHandedOffRepositoryConnection(input));

      act(() => {
        result.current(HANDED_OFF.path);
      });
      // The person picked another repository while the registration was in flight.
      input.actionSequence.current += 1;
      await act(async () => {
        if (outcome === "resolve") registration.resolve(HANDED_OFF);
        else registration.reject(new Error("late failure"));
        await registration.promise.catch((): undefined => undefined);
      });
      expect(input.onSettled).toHaveBeenCalledOnce();
      expect(input.onAdded).not.toHaveBeenCalled();
      expect(input.onFailed).not.toHaveBeenCalled();
      expect(input.onSuperseded).not.toHaveBeenCalled();
    },
  );

  // CodeRabbit on #4553: a second Files hand-off can arrive while the first folder still registers.
  it.each(["resolve", "reject"] as const)(
    "leaves a newer hand-off pending when the earlier registration settles (%s)",
    async (outcome) => {
      const { input, registration, registerRepository } = harness();
      const { result, rerender } = renderHook(
        (props: HandedOffRepositoryConnectionInput) => useHandedOffRepositoryConnection(props),
        { initialProps: input },
      );

      act(() => {
        result.current(HANDED_OFF.path);
      });
      rerender({ ...input, handOffPath: "/repos/newer" });
      await act(async () => {
        if (outcome === "resolve") registration.resolve(HANDED_OFF);
        else registration.reject(new Error("late failure"));
        await registration.promise.catch((): undefined => undefined);
      });
      expect(input.onSettled).not.toHaveBeenCalled();
      expect(input.onAdded).not.toHaveBeenCalled();
      expect(input.onFailed).not.toHaveBeenCalled();
      expect(input.onSuperseded).toHaveBeenCalledOnce();

      // The superseded folder may be handed off again later and connects then.
      rerender(input);
      act(() => {
        result.current(HANDED_OFF.path);
      });
      expect(registerRepository).toHaveBeenCalledTimes(2);
    },
  );

  // Independent audit of the CodeRabbit repair: an outcome that lands between the commit of a newer
  // hand-off and that commit's passive effects must already see the newer hand-off.
  it("treats a newer hand-off as pending from the commit that carries it", () => {
    const registration = synchronousRegistration();
    const { input } = harness();
    const registerRepository = vi.fn<GitClientSeam["registerRepository"]>(
      () => registration.result,
    );
    const settleOnNewerHandOff = (): void => {
      registration.settle({ project: HANDED_OFF });
    };
    const { result, rerender } = renderHook(
      (props: HandedOffRepositoryConnectionInput) =>
        useConnectionSettlingOnCommit(props, settleOnNewerHandOff),
      { initialProps: { ...input, client: { registerRepository } as unknown as GitClientSeam } },
    );

    act(() => {
      result.current(HANDED_OFF.path);
    });
    rerender({
      ...input,
      client: { registerRepository } as unknown as GitClientSeam,
      handOffPath: "/repos/newer",
    });
    expect(input.onSettled).not.toHaveBeenCalled();
    expect(input.onAdded).not.toHaveBeenCalled();
    expect(input.onSuperseded).toHaveBeenCalledOnce();
  });

  it("leaves a newer repository action alone when a superseded registration settles", async () => {
    const { input, registration } = harness();
    const { result, rerender } = renderHook(
      (props: HandedOffRepositoryConnectionInput) => useHandedOffRepositoryConnection(props),
      { initialProps: input },
    );

    act(() => {
      result.current(HANDED_OFF.path);
    });
    rerender({ ...input, handOffPath: "/repos/newer" });
    input.actionSequence.current += 1;
    await act(async () => {
      registration.resolve(HANDED_OFF);
      await registration.promise;
    });
    expect(input.onSuperseded).not.toHaveBeenCalled();
    expect(input.onSettled).not.toHaveBeenCalled();
    expect(input.onAdded).not.toHaveBeenCalled();
  });
});
