#!/usr/bin/env node

import { runCli, runUiCli } from "../../../packages/keiko-cli/dist/index.js";
import { buildUiHandlerDeps } from "../../../packages/keiko-server/dist/index.js";
import { KEIKO_PRODUCT_VERSION } from "@oscharko-dev/keiko-contracts/runtime/version";

const PACKAGE_NAME = "@oscharko-dev/keiko";
const FIXTURE_INSTALL_ROOT = `/usr/local/lib/node_modules/${PACKAGE_NAME}`;
const LIFECYCLE_COMMANDS = new Set(["start", "stop", "restart"]);

const io = {
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
};

function nextPatchVersion(version) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.exec(version);
  if (match === null) {
    throw new Error("The real-BFF outage fixture requires a stable Keiko version.");
  }
  return `${match[1]}.${match[2]}.${String(Number(match[3]) + 1)}`;
}

function releaseImpactCatalog(targetVersion) {
  return {
    schemaVersion: 1,
    entries: [
      {
        id: `update-outage-${targetVersion}`,
        packageName: PACKAGE_NAME,
        packageVersion: targetVersion,
        distTag: "latest",
        registry: "https://registry.npmjs.org/",
        releaseTag: `v${targetVersion}`,
        releaseNoteCategory: "update-notes",
        releaseNotePriority: "normal",
        userVisibleChange: "observable",
        userVisibleSummary: "Real BFF outage and reconnect verification.",
        affectedStateStores: [],
        stateImpact: [],
        userActionRequired: false,
        remediation: "no-action-required",
        supportedFrom: [KEIKO_PRODUCT_VERSION],
        releaseNoteBullets: ["Exercises update recovery across a real local BFF outage."],
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
          // Parser-valid test data only. This is not release-owner approval or production
          // eligibility evidence; the journey qualifies BFF outage/recovery behavior alone.
          status: "reviewed",
          reviewer: "release-owner",
          reviewedAt: "2026-09-05",
          humanApproved: true,
          approvalReference: "github-pr-review:fixture.invalid/keiko#3405#1",
          rationale:
            "Format-valid synthetic metadata for the non-mutating real-BFF outage regression.",
        },
      },
    ],
  };
}

function requestUrl(input) {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function jsonResponse(body, status = 200) {
  return new globalThis.Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function metadataFetch(targetVersion) {
  return (input) => {
    const url = requestUrl(input);
    if (url.startsWith("https://registry.npmjs.org/")) {
      return Promise.resolve(jsonResponse({ "dist-tags": { latest: targetVersion } }));
    }
    if (url === `https://api.github.com/repos/oscharko-dev/keiko/releases/tags/v${targetVersion}`) {
      return Promise.resolve(
        jsonResponse({
          tag_name: `v${targetVersion}`,
          name: `Keiko ${targetVersion}`,
          html_url: `https://github.com/oscharko-dev/keiko/releases/tag/v${targetVersion}`,
          published_at: "2026-09-05T00:00:00.000Z",
          body: "- Exercises a real BFF outage without mutating an installation",
        }),
      );
    }
    return Promise.resolve(new globalThis.Response("not found", { status: 404 }));
  };
}

function pendingOperation() {
  return new Promise(() => {
    // The process shutdown is the interruption under test. No package-manager command is spawned.
  });
}

function createHarnessHandlerDeps(options) {
  const stateDir = options.env.KEIKO_STATE_DIR;
  if (typeof stateDir !== "string" || stateDir.length === 0) {
    throw new Error("The real-BFF outage fixture requires an isolated state directory.");
  }
  const targetVersion = nextPatchVersion(KEIKO_PRODUCT_VERSION);
  const facts = {
    packageRoot: FIXTURE_INSTALL_ROOT,
    packageName: PACKAGE_NAME,
    packageManagerHint: "npm",
    installScope: "global",
  };
  return {
    ...buildUiHandlerDeps({
      ...options,
      updateRuntimeFacts: () => facts,
      updateRunCommandImpl: pendingOperation,
      updatePreflightCatalog: releaseImpactCatalog(targetVersion),
    }),
    gatewayReadinessFetch: metadataFetch(targetVersion),
  };
}

const command = process.argv[2];
if (
  process.env.KEIKO_E2E_UPDATE_OUTAGE !== "1" ||
  (command !== "ui" && !LIFECYCLE_COMMANDS.has(command))
) {
  process.stderr.write("update-bff-outage-3405: refused unsupported invocation\n");
  process.exitCode = 2;
} else if (command !== "ui") {
  // Run the compiled production lifecycle directly so its controlled re-exec can target this
  // fixture. The root package bin deliberately normalizes inherited install paths and therefore
  // cannot serve as an injection seam for this real-BFF outage journey.
  process.exitCode = await runCli(process.argv.slice(2), io, process.env);
} else {
  process.exitCode = await runUiCli(process.argv.slice(3), io, process.env, {
    buildHandlerDeps: createHarnessHandlerDeps,
  });
}
