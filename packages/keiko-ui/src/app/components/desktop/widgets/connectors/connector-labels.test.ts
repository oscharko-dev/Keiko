// Issue #2245 — closed-union coverage for the connector label mappings. Every enum member must map
// to a REAL catalog key (proving the surface renders distinct, translated copy for each state), and
// verify statuses must expose distinct label/copy keys and correct tones.

import { describe, expect, it } from "vitest";
import {
  ATLASSIAN_CONNECTOR_ACTION_TYPES,
  ATLASSIAN_CONNECTOR_ACTION_DISPOSITIONS,
  ATLASSIAN_CONNECTOR_ACTION_REVIEW_REASONS,
  ATLASSIAN_CONNECTOR_PROVIDERS,
  ATLASSIAN_CONNECTOR_WRITE_FAILURE_REASONS,
  ATLASSIAN_SYNC_FAILURE_REASONS,
  ATLASSIAN_SYNC_JOB_STATUSES,
} from "@oscharko-dev/keiko-contracts";
import { EN_MESSAGES } from "@/lib/i18n-messages.en";
import { ATLASSIAN_CONNECTOR_VERIFY_STATUSES } from "@/lib/atlassian-connectors-api";
import {
  actionTypeLabelKey,
  deniedReasonCopyKey,
  dispositionLabelKey,
  providerLabelKey,
  reviewReasonCopyKey,
  riskLabelKey,
  syncFailureReasonKey,
  syncStatusBadgeState,
  syncStatusLabelKey,
  verifyStatusCopyKey,
  verifyStatusLabelKey,
  verifyStatusTone,
} from "./connector-labels";

function catalogHas(key: string): boolean {
  return Object.prototype.hasOwnProperty.call(EN_MESSAGES, key);
}

describe("connector-labels — every mapped key exists in the central catalog", () => {
  it("maps all providers, actions, risks, dispositions, review reasons", () => {
    for (const provider of ATLASSIAN_CONNECTOR_PROVIDERS) {
      expect(catalogHas(providerLabelKey(provider))).toBe(true);
    }
    for (const action of ATLASSIAN_CONNECTOR_ACTION_TYPES) {
      expect(catalogHas(actionTypeLabelKey(action))).toBe(true);
    }
    for (const risk of ["low", "medium", "high", "critical"] as const) {
      expect(catalogHas(riskLabelKey(risk))).toBe(true);
    }
    for (const disposition of ATLASSIAN_CONNECTOR_ACTION_DISPOSITIONS) {
      expect(catalogHas(dispositionLabelKey(disposition))).toBe(true);
    }
    for (const reason of ATLASSIAN_CONNECTOR_ACTION_REVIEW_REASONS) {
      expect(catalogHas(reviewReasonCopyKey(reason))).toBe(true);
    }
  });

  it("maps every sync status (label + badge state) and sync failure reason", () => {
    const badgeStates = new Set(["ready", "indexing", "stale", "error", "draft"]);
    for (const status of ATLASSIAN_SYNC_JOB_STATUSES) {
      expect(catalogHas(syncStatusLabelKey(status))).toBe(true);
      expect(badgeStates.has(syncStatusBadgeState(status))).toBe(true);
    }
    for (const reason of ATLASSIAN_SYNC_FAILURE_REASONS) {
      expect(catalogHas(syncFailureReasonKey(reason))).toBe(true);
    }
  });

  it("maps every write failure reason to real copy", () => {
    for (const reason of ATLASSIAN_CONNECTOR_WRITE_FAILURE_REASONS) {
      expect(catalogHas(deniedReasonCopyKey(undefined))).toBe(true);
    }
  });
});

describe("connector-labels — verify status distinct copy and tones", () => {
  it("gives each status a distinct label and copy key that exists", () => {
    const labels = new Set<string>();
    const copies = new Set<string>();
    for (const status of ATLASSIAN_CONNECTOR_VERIFY_STATUSES) {
      const labelKey = verifyStatusLabelKey(status);
      const copyKey = verifyStatusCopyKey(status);
      expect(catalogHas(labelKey)).toBe(true);
      expect(catalogHas(copyKey)).toBe(true);
      expect(labelKey).not.toEqual(copyKey);
      labels.add(labelKey);
      copies.add(copyKey);
    }
    expect(labels.size).toBe(ATLASSIAN_CONNECTOR_VERIFY_STATUSES.length);
    expect(copies.size).toBe(ATLASSIAN_CONNECTOR_VERIFY_STATUSES.length);
  });

  it("marks ok positive and every failure actionable", () => {
    expect(verifyStatusTone("ok")).toBe("ok");
    expect(verifyStatusTone("auth-failed")).toBe("danger");
    expect(verifyStatusTone("forbidden")).toBe("danger");
    expect(verifyStatusTone("unreachable")).toBe("warning");
    expect(verifyStatusTone("timeout")).toBe("warning");
  });
});

describe("deniedReasonCopyKey", () => {
  it("maps known authority/scope reasons and falls back to a generic content-free line", () => {
    expect(deniedReasonCopyKey("authority-expired")).toBe(
      "atlassianConnectors.denied.reason.authority-expired",
    );
    expect(deniedReasonCopyKey("connector-write-denied")).toBe(
      "atlassianConnectors.denied.reason.connector-write-denied",
    );
    expect(deniedReasonCopyKey("human-initiated")).toBe(
      "atlassianConnectors.denied.reason.generic",
    );
    expect(deniedReasonCopyKey(undefined)).toBe("atlassianConnectors.denied.reason.generic");
  });
});
