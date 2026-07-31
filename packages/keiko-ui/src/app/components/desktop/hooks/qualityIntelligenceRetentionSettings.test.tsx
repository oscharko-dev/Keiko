import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import {
  QI_RETENTION_POLICY_STORAGE_KEY,
  useQualityIntelligenceRetentionSettings,
} from "./qualityIntelligenceRetentionSettings";

describe("useQualityIntelligenceRetentionSettings", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("persists a selected named profile and restores it after remount", () => {
    const first = renderHook(() => useQualityIntelligenceRetentionSettings());
    act(() => {
      first.result.current.setRetentionPolicyId("qi:standard-90d");
    });
    expect(window.localStorage.getItem(QI_RETENTION_POLICY_STORAGE_KEY)).toBe("qi:standard-90d");
    first.unmount();

    const second = renderHook(() => useQualityIntelligenceRetentionSettings());
    expect(second.result.current.retentionPolicyId).toBe("qi:standard-90d");
  });

  it.each(["", "qi:unknown", "{broken-json"])(
    "falls back to 30 days for malformed persisted value %s",
    (persisted) => {
      window.localStorage.setItem(QI_RETENTION_POLICY_STORAGE_KEY, persisted);
      const { result } = renderHook(() => useQualityIntelligenceRetentionSettings());
      expect(result.current.retentionPolicyId).toBe("qi:short-30d");
    },
  );
});
