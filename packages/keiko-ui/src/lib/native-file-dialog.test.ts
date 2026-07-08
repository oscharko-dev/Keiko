// Epic #1941 (ADR-0118) — nativeFileDialogSupported's memoization contract had zero direct test
// coverage: success is cached for the session, but a failed capability fetch is deliberately NOT
// cached (native-file-dialog.ts:15-17) so a transient BFF hiccup does not permanently hide every
// Browse button. This file proves that contract directly against the real (unmocked) module.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./api", () => ({
  ApiError: class ApiError extends Error {
    constructor(
      public readonly code: string,
      message: string,
      public readonly status: number,
    ) {
      super(message);
    }
  },
  fetchNativeFileDialogCapability: vi.fn(),
  openNativeFileDialog: vi.fn(),
}));

import { fetchNativeFileDialogCapability } from "./api";
import {
  nativeFileDialogSupported,
  resetNativeFileDialogCapabilityCacheForTests,
} from "./native-file-dialog";

const mockFetchCapability = vi.mocked(fetchNativeFileDialogCapability);

beforeEach(() => {
  mockFetchCapability.mockReset();
  resetNativeFileDialogCapabilityCacheForTests();
});

describe("nativeFileDialogSupported", () => {
  it("resolves the capability the BFF reports", async () => {
    mockFetchCapability.mockResolvedValueOnce({ supported: true });
    await expect(nativeFileDialogSupported()).resolves.toBe(true);
  });

  it("memoizes a successful answer instead of refetching on every call", async () => {
    mockFetchCapability.mockResolvedValueOnce({ supported: true });

    await expect(nativeFileDialogSupported()).resolves.toBe(true);
    await expect(nativeFileDialogSupported()).resolves.toBe(true);
    await expect(nativeFileDialogSupported()).resolves.toBe(true);

    expect(mockFetchCapability).toHaveBeenCalledTimes(1);
  });

  it("does NOT cache a failed capability fetch, so a later call can retry and succeed", async () => {
    mockFetchCapability.mockRejectedValueOnce(new Error("network unavailable"));
    await expect(nativeFileDialogSupported()).resolves.toBe(false);

    // The transient failure above must not have been memoized — a second call re-fetches rather
    // than permanently returning the earlier `false`.
    mockFetchCapability.mockResolvedValueOnce({ supported: true });
    await expect(nativeFileDialogSupported()).resolves.toBe(true);

    expect(mockFetchCapability).toHaveBeenCalledTimes(2);
  });

  it("dedupes concurrent in-flight calls into a single fetch", async () => {
    let resolveCapability: ((value: { supported: boolean }) => void) | undefined;
    mockFetchCapability.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveCapability = resolve;
      }),
    );

    const first = nativeFileDialogSupported();
    const second = nativeFileDialogSupported();
    resolveCapability?.({ supported: true });

    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(true);
    expect(mockFetchCapability).toHaveBeenCalledTimes(1);
  });
});
