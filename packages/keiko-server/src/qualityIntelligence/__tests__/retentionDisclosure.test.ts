// Retention disclosure on the QI run list (0.3.0 release audit).
//
// `enforceQiRetentionAtStartup` hard-deletes QI runs on every server start — by age and by count,
// under the profile every run is recorded with. Nothing in the product told the user that: the run
// list rendered a plain list of runs that silently shrank between sessions, so evidence the user
// believed was kept was destroyed without disclosure.
//
// These tests pin the disclosure at the route that owns the run list. The disclosed numbers are
// DERIVED from the same production profile table the purge enforces — a fixture that restated "30
// days / 100 runs" would keep passing while the enforced policy moved underneath it.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  QualityIntelligenceUiRunListResponse,
  QualityIntelligenceUiRetentionNotice,
} from "@oscharko-dev/keiko-contracts";
import type { EvidenceStore } from "@oscharko-dev/keiko-evidence";
import {
  getQualityIntelligenceRetentionProfile,
  QUALITY_INTELLIGENCE_DEFAULT_RETENTION_PROFILE_ID,
} from "@oscharko-dev/keiko-evidence";
import type { RouteContext } from "../../routes.js";
import type { UiHandlerDeps } from "../../deps.js";
import { buildRedactor, createRunRegistry } from "../../index.js";
import { createInMemoryUiStore } from "../../store/index.js";
import { handleListQiRuns } from "../uiRoutes.js";

const emptyStore = (): EvidenceStore => ({
  put: () => "",
  list: () => [],
  get: () => undefined,
  delete: () => undefined,
});

let evidenceDir: string;

const deps = (): UiHandlerDeps => ({
  config: undefined,
  configPresent: false,
  evidenceStore: emptyStore(),
  env: {},
  redactor: buildRedactor({}),
  registry: createRunRegistry(),
  modelPortFactory: () => undefined,
  store: createInMemoryUiStore(),
  evidenceDir,
});

const ctx = (): RouteContext => ({
  correlationId: undefined,
  req: {} as RouteContext["req"],
  res: {} as RouteContext["res"],
  params: {},
  url: new URL("http://127.0.0.1/api/quality-intelligence/runs"),
});

beforeEach(() => {
  evidenceDir = mkdtempSync(join(tmpdir(), "keiko-qi-retention-disclosure-"));
});

afterEach(() => {
  rmSync(evidenceDir, { recursive: true, force: true });
});

describe("handleListQiRuns — retention disclosure", () => {
  it("discloses the retention policy that governs the listed runs", () => {
    const result = handleListQiRuns(ctx(), deps());
    expect(result.status).toBe(200);
    const body = result.body as QualityIntelligenceUiRunListResponse;
    expect(body.retention).toBeDefined();
  });

  it("discloses the SAME limits the startup purge enforces", () => {
    // Derived from the production profile table, not restated: if the enforced profile changes,
    // this expectation moves with it and a stale disclosure fails here.
    const profile = getQualityIntelligenceRetentionProfile(
      QUALITY_INTELLIGENCE_DEFAULT_RETENTION_PROFILE_ID,
    );
    expect(profile).toBeDefined();

    const body = handleListQiRuns(ctx(), deps()).body as QualityIntelligenceUiRunListResponse;
    const notice: QualityIntelligenceUiRetentionNotice | undefined = body.retention;

    expect(notice?.policyId).toBe(QUALITY_INTELLIGENCE_DEFAULT_RETENTION_PROFILE_ID);
    expect(notice?.retainedDays).toBe(profile?.retainedDays);
    expect(notice?.maxRunArtifacts).toBe(profile?.maxRunArtifacts);
  });

  it("discloses retention even when there is nothing to list yet", () => {
    const body = handleListQiRuns(ctx(), deps()).body as QualityIntelligenceUiRunListResponse;
    expect(body.runs).toHaveLength(0);
    expect(body.retention?.retainedDays).toBeGreaterThan(0);
    expect(body.retention?.maxRunArtifacts).toBeGreaterThan(0);
  });
});
