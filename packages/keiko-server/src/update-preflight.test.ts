import { describe, expect, it, vi } from "vitest";
import type { IncomingMessage } from "node:http";
import type { ReleaseImpactCatalog, ReleaseImpactEntry } from "@oscharko-dev/keiko-contracts";
import { buildRedactor, createRunRegistry, type UiHandlerDeps } from "./index.js";
import { createInMemoryUiStore } from "./store/index.js";
import {
  compareSemver,
  createUpdatePreflightService,
  handleGetUpdatePreflight,
  handlePostUpdatePreflightCheck,
  runUpdatePreflight,
} from "./update-preflight.js";
import type { RouteContext } from "./routes.js";

const APPROVED_RELEASE_REFERENCE = "github-pr-review:oscharko-dev/Keiko#1717#484740";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function baseCatalog(): ReleaseImpactCatalog {
  return {
    schemaVersion: 1,
    entries: [
      {
        id: "0.2.10-a",
        packageName: "@oscharko-dev/keiko",
        packageVersion: "0.2.10",
        distTag: "latest",
        registry: "https://registry.npmjs.org/",
        releaseTag: "v0.2.10",
        releaseNoteCategory: "update-notes",
        releaseNotePriority: "normal",
        userVisibleChange: "observable",
        userVisibleSummary: "Catalog summary for 0.2.10",
        affectedStateStores: ["workspace"],
        stateImpact: [
          {
            store: "workspace",
            description: "Restart once to load the new workspace schema.",
            remediation: "restart-required",
            userActionRequired: true,
          },
        ],
        userActionRequired: true,
        remediation: "restart-required",
        supportedFrom: ["0.2.0"],
        releaseNoteBullets: ["Shared bullet", "Workspace reliability improvement"],
        internalOnly: false,
        observableImpact: true,
        defaultPatchNotes: true,
        oneClickEligible: true,
        publishGates: [
          "version-consistency",
          "publish-manifests",
          "release-impact",
          "package-surface",
          "qi-supply-chain",
        ],
        review: {
          status: "reviewed",
          reviewer: "release-owner",
          reviewedAt: "2026-06-30",
          humanApproved: true,
          approvalReference: APPROVED_RELEASE_REFERENCE,
          rationale: "Reviewed.",
        },
      },
      {
        id: "0.2.11-a",
        packageName: "@oscharko-dev/keiko",
        packageVersion: "0.2.11",
        distTag: "latest",
        registry: "https://registry.npmjs.org/",
        releaseTag: "v0.2.11",
        releaseNoteCategory: "update-notes",
        releaseNotePriority: "normal",
        userVisibleChange: "observable",
        userVisibleSummary: "Catalog summary for 0.2.11",
        affectedStateStores: ["workspace"],
        stateImpact: [
          {
            store: "workspace",
            description: "Restart once to load the new workspace schema.",
            remediation: "restart-required",
            userActionRequired: true,
          },
        ],
        userActionRequired: false,
        remediation: "no-action-required",
        supportedFrom: ["0.2.0"],
        releaseNoteBullets: ["Shared bullet", "Structured update preflight metadata"],
        internalOnly: false,
        observableImpact: true,
        defaultPatchNotes: true,
        oneClickEligible: true,
        publishGates: [
          "version-consistency",
          "publish-manifests",
          "release-impact",
          "package-surface",
          "qi-supply-chain",
        ],
        review: {
          status: "reviewed",
          reviewer: "release-owner",
          reviewedAt: "2026-06-30",
          humanApproved: true,
          approvalReference: APPROVED_RELEASE_REFERENCE,
          rationale: "Reviewed.",
        },
      },
      {
        id: "0.2.12-beta",
        packageName: "@oscharko-dev/keiko",
        packageVersion: "0.2.12-beta.1",
        distTag: "latest",
        registry: "https://registry.npmjs.org/",
        releaseTag: "v0.2.12-beta.1",
        releaseNoteCategory: "update-notes",
        releaseNotePriority: "normal",
        userVisibleChange: "observable",
        userVisibleSummary: "Ignored prerelease entry",
        affectedStateStores: [],
        stateImpact: [],
        userActionRequired: false,
        remediation: "no-action-required",
        supportedFrom: ["0.2.0"],
        releaseNoteBullets: ["Ignored prerelease bullet"],
        internalOnly: false,
        observableImpact: true,
        defaultPatchNotes: true,
        oneClickEligible: true,
        publishGates: [
          "version-consistency",
          "publish-manifests",
          "release-impact",
          "package-surface",
          "qi-supply-chain",
        ],
        review: {
          status: "reviewed",
          reviewer: "release-owner",
          reviewedAt: "2026-06-30",
          humanApproved: true,
          approvalReference: APPROVED_RELEASE_REFERENCE,
          rationale: "Reviewed.",
        },
      },
    ],
  };
}

function depsWith(fetchImpl: typeof fetch): UiHandlerDeps {
  return {
    config: undefined,
    configPresent: false,
    evidenceStore: { put: () => "", list: () => [], get: () => undefined, delete: () => undefined },
    env: {},
    redactor: buildRedactor({}),
    registry: createRunRegistry(),
    modelPortFactory: () => undefined,
    store: createInMemoryUiStore(),
    gatewayReadinessFetch: fetchImpl,
  };
}

const ctx: RouteContext = {
  req: {} as IncomingMessage,
  res: {} as RouteContext["res"],
  params: {},
  url: new URL("http://127.0.0.1/api/update/preflight"),
};

describe("update preflight service", () => {
  it("reports current with GitHub release notes when npm latest matches the running version", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ "dist-tags": { latest: "0.2.9" } }))
      .mockResolvedValueOnce(
        jsonResponse({
          tag_name: "v0.2.9",
          name: "Keiko 0.2.9",
          html_url: "https://github.com/oscharko-dev/keiko/releases/tag/v0.2.9",
          published_at: "2026-06-29T12:00:00.000Z",
          body: [
            "## Keiko 0.2.9 Release Notes",
            "### High · Improvements",
            "- Current release note",
            "### Normal · Fixes",
            "- Another current note",
            "<details>",
            "<summary>Technical release metadata</summary>",
            "- Package: `@oscharko-dev/keiko@0.2.9`",
            "- Generated by: `npm run release:publish`",
            "</details>",
          ].join("\n"),
        }),
      ) as typeof fetch;
    const deps = depsWith(fetchImpl);

    const report = await runUpdatePreflight(deps, {
      currentVersion: "0.2.9",
      bundledCatalog: baseCatalog(),
    });

    expect(report.status).toBe("current");
    expect(report.updateAvailable).toBe(false);
    expect(report.targetVersion).toBe("0.2.9");
    expect(report.releaseMetadataStatus).toBe("live");
    expect(report.release).toMatchObject({
      source: "github-release",
      tag: "v0.2.9",
      title: "Keiko 0.2.9",
      summary: "Current release note",
    });
    expect(report.release?.noteSections).toEqual([
      { title: "High · Improvements", bullets: ["Current release note"] },
      { title: "Normal · Fixes", bullets: ["Another current note"] },
    ]);
    expect(report.patchNotes).toMatchObject({
      collapsed: true,
      summary: "Current release note",
      bullets: ["Another current note"],
      sections: [
        { title: "High · Improvements", bullets: ["Current release note"] },
        { title: "Normal · Fixes", bullets: ["Another current note"] },
      ],
    });
    expect(report.patchNotes?.bullets).not.toContain("Current release note");
    expect(report.patchNotes?.bullets).not.toContain("Generated by: `npm run release:publish`");
    deps.store.close();
  });

  it("requests abbreviated npm metadata so the full packument does not trip the response cap", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ "dist-tags": { latest: "0.2.9" } }));
    const deps = depsWith(fetchMock);

    await runUpdatePreflight(deps, {
      currentVersion: "0.2.9",
      bundledCatalog: baseCatalog(),
    });

    const firstCall = fetchMock.mock.calls[0];
    expect(firstCall?.[0]).toBe("https://registry.npmjs.org/%40oscharko-dev%2Fkeiko");
    expect(firstCall?.[1]?.headers).toEqual(
      expect.objectContaining({
        Accept: "application/vnd.npm.install-v1+json",
      }),
    );
    deps.store.close();
  });

  it("keeps the current status when current release notes are unavailable", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ "dist-tags": { latest: "0.2.9" } }))
      .mockResolvedValueOnce(new Response("missing", { status: 404 })) as typeof fetch;
    const deps = depsWith(fetchImpl);

    const report = await runUpdatePreflight(deps, {
      currentVersion: "0.2.9",
      bundledCatalog: baseCatalog(),
    });

    expect(report.status).toBe("current");
    expect(report.updateAvailable).toBe(false);
    expect(report.releaseMetadataStatus).toBe("unavailable");
    expect(report.patchNotes).toBeUndefined();
    expect(report.warnings).toEqual(["Current release notes are unavailable."]);
    deps.store.close();
  });

  it("returns live GitHub release metadata when an update is available", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ "dist-tags": { latest: "0.2.11" } }))
      .mockResolvedValueOnce(
        jsonResponse({
          tag_name: "v0.2.11",
          name: "Keiko 0.2.11",
          html_url: "https://github.com/oscharko-dev/keiko/releases/tag/v0.2.11",
          published_at: "2026-06-30T12:00:00.000Z",
          body: "- Public release note\n- Another note",
        }),
      ) as typeof fetch;
    const deps = depsWith(fetchImpl);

    const report = await runUpdatePreflight(deps, {
      currentVersion: "0.2.9",
      bundledCatalog: baseCatalog(),
    });

    expect(report.status).toBe("update-available");
    expect(report.targetVersion).toBe("0.2.11");
    expect(report.releaseMetadataStatus).toBe("live");
    expect(report.release).toMatchObject({
      source: "github-release",
      tag: "v0.2.11",
      title: "Keiko 0.2.11",
      summary: "Public release note",
    });
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      "https://api.github.com/repos/oscharko-dev/keiko/releases/tags/v0.2.11",
      expect.anything(),
    );
    const secondRequest = vi.mocked(fetchImpl).mock.calls[1]?.[1];
    expect(secondRequest?.headers).toMatchObject({
      Accept: "application/vnd.github+json",
      "User-Agent": "Keiko",
    });
    deps.store.close();
  });

  it("fails quietly with a degraded report when the registry times out", async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new DOMException("timeout", "TimeoutError")) as typeof fetch;
    const deps = depsWith(fetchImpl);

    const report = await runUpdatePreflight(deps, {
      currentVersion: "0.2.9",
      bundledCatalog: baseCatalog(),
    });

    expect(report.status).toBe("degraded");
    expect(report.registryStatus).toBe("unavailable");
    expect(report.targetVersion).toBeUndefined();
    expect(report.releaseMetadataStatus).toBe("not-needed");
    deps.store.close();
  });

  it("falls back to the bundled catalog when GitHub is unavailable", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ "dist-tags": { latest: "0.2.11" } }))
      .mockResolvedValueOnce(new Response("nope", { status: 503 })) as typeof fetch;
    const deps = depsWith(fetchImpl);

    const report = await runUpdatePreflight(deps, {
      currentVersion: "0.2.9",
      bundledCatalog: baseCatalog(),
    });

    expect(report.releaseMetadataStatus).toBe("fallback");
    expect(report.release).toMatchObject({
      source: "bundled-catalog",
      tag: "v0.2.11",
      summary: "Catalog summary for 0.2.11",
    });
    expect(report.severity).toBe("normal");
    expect(report.oneClickEligible).toBe(true);
    expect(report.userActionRequired).toBe(true);
    expect(report.manualUpdateRequired).toBe(false);
    expect(report.affectedStateStores).toEqual(["workspace"]);
    expect(report.blockers).toEqual([]);
    expect(report.patchNotes).toMatchObject({
      collapsed: true,
      summary: "Catalog summary for 0.2.11",
    });
    expect(report.warnings).toContain(
      "GitHub release metadata is unavailable; bundled release impact will be used.",
    );
    deps.store.close();
  });

  it("treats malformed GitHub metadata as fallback-able metadata", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ "dist-tags": { latest: "0.2.11" } }))
      .mockResolvedValueOnce(jsonResponse({ tag_name: "v0.2.10", body: 42 })) as typeof fetch;
    const deps = depsWith(fetchImpl);

    const report = await runUpdatePreflight(deps, {
      currentVersion: "0.2.9",
      bundledCatalog: baseCatalog(),
    });

    expect(report.releaseMetadataStatus).toBe("fallback");
    expect(report.release?.source).toBe("bundled-catalog");
    expect(report.warnings).toContain(
      "GitHub release metadata was malformed; bundled release impact will be used.",
    );
    deps.store.close();
  });

  it("builds the release summary from the bundled catalog when GitHub is unavailable", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ "dist-tags": { latest: "0.2.10" } }))
      .mockResolvedValueOnce(new Response("missing", { status: 404 })) as typeof fetch;
    const deps = depsWith(fetchImpl);

    const report = await runUpdatePreflight(deps, {
      currentVersion: "0.2.9",
      bundledCatalog: baseCatalog(),
    });

    expect(report.release).toEqual({
      source: "bundled-catalog",
      tag: "v0.2.10",
      title: "Keiko 0.2.10",
      summary: "Catalog summary for 0.2.10",
      notes: ["Shared bullet", "Workspace reliability improvement"],
    });
    deps.store.close();
  });

  it("aggregates same-version bundled notes when GitHub fallback is forced", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ "dist-tags": { latest: "0.2.11" } }))
      .mockResolvedValueOnce(new Response("missing", { status: 503 })) as typeof fetch;
    const deps = depsWith(fetchImpl);
    const followUpEntry = {
      id: "0.2.11-b",
      packageName: "@oscharko-dev/keiko",
      packageVersion: "0.2.11",
      distTag: "latest",
      registry: "https://registry.npmjs.org/",
      releaseTag: "v0.2.11",
      releaseNoteCategory: "update-notes",
      releaseNotePriority: "normal",
      userVisibleChange: "observable",
      userVisibleSummary: "Catalog follow-up summary for 0.2.11",
      affectedStateStores: ["workspace"],
      stateImpact: [
        {
          store: "workspace",
          description: "Restart once to load the new workspace schema.",
          remediation: "restart-required",
          userActionRequired: true,
        },
      ],
      userActionRequired: false,
      remediation: "no-action-required",
      supportedFrom: ["0.2.0"],
      releaseNoteBullets: ["Shared bullet", "Target release follow-up"],
      internalOnly: false,
      observableImpact: true,
      defaultPatchNotes: true,
      oneClickEligible: true,
      publishGates: [
        "version-consistency",
        "publish-manifests",
        "release-impact",
        "package-surface",
        "qi-supply-chain",
      ],
      review: {
        status: "reviewed",
        reviewer: "release-owner",
        reviewedAt: "2026-06-30",
        humanApproved: true,
        approvalReference: APPROVED_RELEASE_REFERENCE,
        rationale: "Reviewed.",
      },
    } satisfies ReleaseImpactEntry;
    const catalog = {
      ...baseCatalog(),
      entries: [...baseCatalog().entries, followUpEntry],
    };

    const report = await runUpdatePreflight(deps, {
      currentVersion: "0.2.9",
      bundledCatalog: catalog,
    });

    expect(report.releaseMetadataStatus).toBe("fallback");
    expect(report.release).toEqual({
      source: "bundled-catalog",
      tag: "v0.2.11",
      title: "Keiko 0.2.11",
      summary: "Catalog follow-up summary for 0.2.11",
      notes: ["Shared bullet", "Structured update preflight metadata", "Target release follow-up"],
    });
    deps.store.close();
  });

  it("blocks one-click readiness when the installed version is outside the reviewed supported path", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ "dist-tags": { latest: "0.2.10" } }))
      .mockResolvedValueOnce(
        jsonResponse({
          tag_name: "v0.2.10",
          name: "Keiko 0.2.10",
          body: "- Public release note",
        }),
      ) as typeof fetch;
    const deps = depsWith(fetchImpl);
    const catalog = {
      ...baseCatalog(),
      entries: baseCatalog().entries.map((entry, index) =>
        index === 0 ? { ...entry, supportedFrom: ["0.2.5"] } : entry,
      ),
    };

    const report = await runUpdatePreflight(deps, {
      currentVersion: "0.2.4",
      bundledCatalog: catalog,
    });

    expect(report.status).toBe("update-available");
    expect(report.releaseMetadataStatus).toBe("live");
    expect(report.release?.source).toBe("github-release");
    expect(report.blockers).toEqual([
      expect.objectContaining({
        code: "one-click-ineligible",
        userActionRequired: true,
      }),
    ]);
    expect(report.manualUpdateRequired).toBe(true);
    expect(report.oneClickEligible).toBe(false);
    deps.store.close();
  });

  it("uses the highest reviewed supported floor across the whole upgrade chain", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ "dist-tags": { latest: "0.2.11" } }))
      .mockResolvedValueOnce(
        jsonResponse({
          tag_name: "v0.2.11",
          name: "Keiko 0.2.11",
          body: "- Public release note",
        }),
      ) as typeof fetch;
    const deps = depsWith(fetchImpl);
    const catalog = {
      ...baseCatalog(),
      entries: baseCatalog().entries.map((entry) =>
        entry.packageVersion === "0.2.10"
          ? { ...entry, supportedFrom: ["0.2.8"] }
          : entry.packageVersion === "0.2.11"
            ? { ...entry, supportedFrom: ["0.2.5"] }
            : entry,
      ),
    };

    const report = await runUpdatePreflight(deps, {
      currentVersion: "0.2.6",
      bundledCatalog: catalog,
    });

    expect(report.impact?.entries.map((entry) => entry.packageVersion)).toEqual([
      "0.2.10",
      "0.2.11",
    ]);
    expect(report.blockers).toHaveLength(1);
    expect(report.blockers[0]?.code).toBe("one-click-ineligible");
    expect(report.blockers[0]?.message).toContain("starts at 0.2.8");
    expect(report.manualUpdateRequired).toBe(true);
    expect(report.oneClickEligible).toBe(false);
    deps.store.close();
  });

  it("deduplicates cumulative impact bullets and state impact across included versions", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ "dist-tags": { latest: "0.2.11" } }))
      .mockResolvedValueOnce(new Response("missing", { status: 404 })) as typeof fetch;
    const deps = depsWith(fetchImpl);

    const report = await runUpdatePreflight(deps, {
      currentVersion: "0.2.9",
      bundledCatalog: baseCatalog(),
    });

    expect(report.impact?.entries.map((entry) => entry.packageVersion)).toEqual([
      "0.2.10",
      "0.2.11",
    ]);
    expect(report.impact?.releaseNoteBullets).toEqual([
      "Shared bullet",
      "Workspace reliability improvement",
      "Structured update preflight metadata",
    ]);
    expect(report.impact?.stateImpact).toHaveLength(1);
    expect(report.impact?.affectedStateStores).toEqual(["workspace"]);
    expect(report.impact?.remediations).toEqual(["restart-required", "no-action-required"]);
    expect(report.patchNotes?.bullets).toEqual([
      "Shared bullet",
      "Structured update preflight metadata",
      "Workspace reliability improvement",
    ]);
    expect(report.patchNotes?.details).toEqual([
      "0.2.10: Catalog summary for 0.2.10",
      "0.2.11: Catalog summary for 0.2.11",
    ]);
    deps.store.close();
  });

  it("drops malformed bundled catalog entries and fails closed without throwing", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ "dist-tags": { latest: "0.2.10" } }))
      .mockResolvedValueOnce(new Response("missing", { status: 404 })) as typeof fetch;
    const deps = depsWith(fetchImpl);
    const catalog = {
      schemaVersion: 1,
      entries: [
        {
          id: "0.2.10-malformed",
          packageName: "@oscharko-dev/keiko",
          packageVersion: "0.2.10",
          distTag: "latest",
          registry: "https://registry.npmjs.org/",
          releaseTag: "v0.2.10",
          releaseNoteCategory: "update-notes",
          releaseNotePriority: "normal",
          userVisibleChange: "observable",
          userVisibleSummary: "Malformed entry should be dropped.",
          affectedStateStores: ["workspace"],
          stateImpact: [
            {
              store: "workspace",
              description: "This malformed shape should never be used.",
              remediation: "restart-required",
              userActionRequired: true,
            },
            7,
          ],
          userActionRequired: false,
          remediation: "no-action-required",
          supportedFrom: ["0.2.0"],
          releaseNoteBullets: ["Valid bullet", 7],
          internalOnly: false,
          observableImpact: true,
          defaultPatchNotes: true,
          oneClickEligible: true,
          publishGates: [
            "version-consistency",
            "publish-manifests",
            "release-impact",
            "package-surface",
            "qi-supply-chain",
          ],
          review: {
            status: "reviewed",
            reviewer: "release-owner",
            reviewedAt: "2026-06-30",
            humanApproved: true,
            approvalReference: APPROVED_RELEASE_REFERENCE,
            rationale: "Reviewed.",
          },
        },
      ],
    } as unknown as ReleaseImpactCatalog;

    const report = await runUpdatePreflight(deps, {
      currentVersion: "0.2.9",
      bundledCatalog: catalog,
    });

    expect(report.releaseMetadataStatus).toBe("unavailable");
    expect(report.release).toBeUndefined();
    expect(report.impact).toBeUndefined();
    expect(report.blockers).toEqual([
      expect.objectContaining({
        code: "release-impact-missing",
        userActionRequired: true,
      }),
    ]);
    expect(report.manualUpdateRequired).toBe(true);
    expect(report.oneClickEligible).toBe(false);
    deps.store.close();
  });

  it("blocks one-click readiness when reviewed target release-impact metadata is missing", async () => {
    const catalog = baseCatalog();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ "dist-tags": { latest: "0.2.11" } }))
      .mockResolvedValueOnce(
        jsonResponse({
          tag_name: "v0.2.11",
          name: "Keiko 0.2.11",
          body: "- Public note",
        }),
      ) as typeof fetch;
    const deps = depsWith(fetchImpl);

    const report = await runUpdatePreflight(deps, {
      currentVersion: "0.2.10",
      bundledCatalog: { schemaVersion: 1, entries: catalog.entries.slice(0, 1) },
    });

    expect(report.updateAvailable).toBe(true);
    expect(report.releaseMetadataStatus).toBe("live");
    expect(report.release?.source).toBe("github-release");
    expect(report.impact).toBeUndefined();
    expect(report.oneClickEligible).toBe(false);
    expect(report.manualUpdateRequired).toBe(true);
    expect(report.blockers).toEqual([
      expect.objectContaining({
        code: "release-impact-missing",
        userActionRequired: true,
      }),
    ]);
    deps.store.close();
  });

  it("blocks one-click readiness when runtime metadata only has issue-scoped approval evidence", async () => {
    const catalog = {
      ...baseCatalog(),
      entries: baseCatalog().entries.map((entry) =>
        entry.packageVersion === "0.2.11"
          ? {
              ...entry,
              review: {
                ...entry.review,
                approvalReference: "issue:#1692",
              },
            }
          : entry,
      ),
    };
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ "dist-tags": { latest: "0.2.11" } }))
      .mockResolvedValueOnce(
        jsonResponse({
          tag_name: "v0.2.11",
          name: "Keiko 0.2.11",
          body: "- Public note",
        }),
      ) as typeof fetch;
    const deps = depsWith(fetchImpl);

    const report = await runUpdatePreflight(deps, {
      currentVersion: "0.2.10",
      bundledCatalog: catalog,
    });

    expect(report.releaseMetadataStatus).toBe("live");
    expect(report.release?.source).toBe("github-release");
    expect(report.impact).toBeUndefined();
    expect(report.oneClickEligible).toBe(false);
    expect(report.manualUpdateRequired).toBe(true);
    expect(report.blockers).toEqual([
      expect.objectContaining({
        code: "release-impact-missing",
        userActionRequired: true,
      }),
    ]);
    deps.store.close();
  });

  it("compares semver numerically instead of lexically", () => {
    expect(compareSemver("0.2.9", "0.2.10")).toBeLessThan(0);
    expect(compareSemver("0.2.10", "0.2.10")).toBe(0);
    expect(compareSemver("0.3.0", "0.2.99")).toBeGreaterThan(0);
  });

  it("rejects malformed semver comparisons instead of lexically sorting them", () => {
    expect(() => compareSemver("1.10.0", "not-a-version")).toThrow(TypeError);
  });

  it("surfaces malformed registry metadata as a degraded state", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ "dist-tags": { latest: 7 } })) as typeof fetch;
    const deps = depsWith(fetchImpl);

    const report = await runUpdatePreflight(deps, {
      currentVersion: "0.2.9",
      bundledCatalog: baseCatalog(),
    });

    expect(report.status).toBe("degraded");
    expect(report.registryStatus).toBe("malformed");
    expect(report.releaseMetadataStatus).toBe("not-needed");
    deps.store.close();
  });

  it("ignores prerelease latest tags in v1", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ "dist-tags": { latest: "0.2.12-beta.1" } }),
      ) as typeof fetch;
    const deps = depsWith(fetchImpl);

    const report = await runUpdatePreflight(deps, {
      currentVersion: "0.2.11",
      bundledCatalog: baseCatalog(),
    });

    expect(report.status).toBe("current");
    expect(report.updateAvailable).toBe(false);
    expect(report.targetVersion).toBe("0.2.11");
    expect(report.warnings).toContain(
      "The registry latest dist-tag currently points to a prerelease and was ignored.",
    );
    deps.store.close();
  });

  it("caches the startup result per BFF while manual checks always retry", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ "dist-tags": { latest: "0.2.10" } }))
      .mockResolvedValueOnce(new Response("missing", { status: 404 }))
      .mockResolvedValueOnce(jsonResponse({ "dist-tags": { latest: "0.2.11" } }))
      .mockResolvedValueOnce(new Response("missing", { status: 404 })) as typeof fetch;
    const deps = depsWith(fetchImpl);
    const service = createUpdatePreflightService({
      currentVersion: "0.2.9",
      bundledCatalog: baseCatalog(),
    });

    const startupA = await service.getStartupReport(deps);
    const startupB = await service.getStartupReport(deps);
    const manual = await service.runManualCheck(deps);

    expect(startupA.targetVersion).toBe("0.2.10");
    expect(startupB.targetVersion).toBe("0.2.10");
    expect(manual.targetVersion).toBe("0.2.11");
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    deps.store.close();
  });
});

describe("update preflight route handlers", () => {
  it("reuses the startup session on GET and retries on manual POST", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ "dist-tags": { latest: "0.2.12" } }))
      .mockResolvedValueOnce(new Response("missing", { status: 404 }))
      .mockResolvedValueOnce(jsonResponse({ "dist-tags": { latest: "0.2.12" } }))
      .mockResolvedValueOnce(new Response("missing", { status: 404 })) as typeof fetch;
    const deps = depsWith(fetchImpl);

    const first = await handleGetUpdatePreflight(ctx, deps);
    const second = await handleGetUpdatePreflight(ctx, deps);
    const manual = await handlePostUpdatePreflightCheck(ctx, deps);

    expect(first.status).toBe(200);
    expect(second.body).toEqual(first.body);
    expect(manual.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    deps.store.close();
  });
});
