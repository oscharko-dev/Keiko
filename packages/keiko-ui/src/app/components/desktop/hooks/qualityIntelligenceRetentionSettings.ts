"use client";

import { useCallback, useState } from "react";
import {
  QUALITY_INTELLIGENCE_DEFAULT_RETENTION_POLICY_ID,
  resolveQualityIntelligenceRetentionPolicyId,
  type QualityIntelligenceRetentionPolicyId,
} from "@oscharko-dev/keiko-contracts";

export const QI_RETENTION_POLICY_STORAGE_KEY = "keiko.quality-intelligence.retention-policy";

function readPersistedRetentionPolicyId(): QualityIntelligenceRetentionPolicyId {
  if (typeof window === "undefined") return QUALITY_INTELLIGENCE_DEFAULT_RETENTION_POLICY_ID;
  try {
    return resolveQualityIntelligenceRetentionPolicyId(
      window.localStorage.getItem(QI_RETENTION_POLICY_STORAGE_KEY),
    );
  } catch {
    return QUALITY_INTELLIGENCE_DEFAULT_RETENTION_POLICY_ID;
  }
}

function persistRetentionPolicyId(value: QualityIntelligenceRetentionPolicyId): void {
  try {
    window.localStorage.setItem(QI_RETENTION_POLICY_STORAGE_KEY, value);
  } catch {
    // Browser storage may be unavailable; the in-memory setting remains effective for this mount.
  }
}

export function useQualityIntelligenceRetentionSettings(): {
  readonly retentionPolicyId: QualityIntelligenceRetentionPolicyId;
  readonly setRetentionPolicyId: (value: QualityIntelligenceRetentionPolicyId) => void;
} {
  const [retentionPolicyId, setRetentionPolicyIdState] = useState(readPersistedRetentionPolicyId);
  const setRetentionPolicyId = useCallback((value: QualityIntelligenceRetentionPolicyId): void => {
    const resolved = resolveQualityIntelligenceRetentionPolicyId(value);
    setRetentionPolicyIdState(resolved);
    persistRetentionPolicyId(resolved);
  }, []);
  return { retentionPolicyId, setRetentionPolicyId };
}
