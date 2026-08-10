import { existsSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { buildPortableEvaluationManifest } from "../lib/portable-evaluation-manifest.mjs";
import { writeZipArchiveEntries } from "../lib/zip-archive.mjs";
import {
  collectEvaluationArtifactDigests,
  downloadJsonAsset,
  jsonFromCommand,
  livePublish,
  portableAssetInputFailure,
  portableDownloadAssetNames,
  portableReleaseGate,
  missingPortableDownloads,
  prepublishedReleaseFailures,
  releaseReaders,
  uploadedDownloadSetFailure,
} from "../lib/portable-release-verification.mjs";

const TAG = "v0.3.1";
const REPOSITORY = "oscharko-dev/Keiko";
const WORKFLOW_PATH = ".github/workflows/portable-assets.yml";
const SOURCE_COMMIT = "0123456789abcdef0123456789abcdef01234567";
const RUN_ID = "31300595709";
const RUN_ATTEMPT = 1;
const RUN_ARTIFACTS = ["windows-x64", "macos-arm64", "macos-x64"].map((target, index) => ({
  name: `portable-stage-${target}-evaluation-unsigned`,
  id: 910001 + index,
}));
const MANIFEST_URL = `https://github.com/${REPOSITORY}/releases/download/${TAG}/keiko-portable-evaluation-manifest.json`;
const EXPECTED_NAMES = [
  "keiko-windows-x64.zip",
  "keiko-macos-arm64.zip",
  "keiko-macos-x64.zip",
  "keiko-windows-x64-setup.exe",
];

function downloads() {
  return EXPECTED_NAMES.map((name, index) => ({
    name,
    size: 1024 + index,
    sha256: String(index).repeat(64),
    browser_download_url: `https://github.com/${REPOSITORY}/releases/download/${TAG}/${name}`,
  }));
}

function evidence(assets, overrides = {}) {
  return {
    ...buildPortableEvaluationManifest({
      releaseTag: TAG,
      sourceCommitSha: SOURCE_COMMIT,
      repository: REPOSITORY,
      workflowPath: WORKFLOW_PATH,
      workflowRunId: RUN_ID,
      workflowRunAttempt: RUN_ATTEMPT,
      artifacts: RUN_ARTIFACTS,
      assets: assets.map((asset) => ({
        assetName: asset.name,
        sizeBytes: asset.size,
        sha256: asset.sha256,
      })),
    }),
    ...overrides,
  };
}

const RELEASE_ID = 987654321;

function release(assets, { withEvidence = true } = {}) {
  return {
    // The release-by-tag endpoint always reports both flags; the gate requires them to be
    // exactly false, so the fixture states the published stable shape explicitly.
    id: RELEASE_ID,
    draft: false,
    prerelease: false,
    assets: withEvidence
      ? [
          ...assets,
          {
            name: "keiko-portable-evaluation-manifest.json",
            size: 512,
            browser_download_url: MANIFEST_URL,
          },
        ]
      : assets,
  };
}

function goodRun() {
  return { path: WORKFLOW_PATH, head_sha: SOURCE_COMMIT, conclusion: "success" };
}

/**
 * Overrides are detected by key presence, not by value: every one of these cases overrides with
 * `undefined` on purpose (a release that does not exist, evidence that cannot be read, a run that
 * cannot be read), and a `??` default would quietly hand back the healthy fixture instead — the
 * test would then assert against a passing case and prove nothing.
 */
function verify(overrides = {}) {
  const assets = downloads();
  const pick = (key, fallback) => (key in overrides ? overrides[key] : fallback);
  return prepublishedReleaseFailures({
    tag: TAG,
    repository: REPOSITORY,
    workflowPath: WORKFLOW_PATH,
    expectedNames: EXPECTED_NAMES,
    release: pick("release", release(assets)),
    readLatestRelease: () => pick("latest", { id: RELEASE_ID }),
    readManifest: () => pick("manifest", evidence(assets)),
    readRun: () => pick("run", goodRun()),
  });
}

describe("missingPortableDownloads", () => {
  it("reports a name that is absent and one that is present but empty", () => {
    // A zero-byte asset is not a download. GitHub happily reports one, and a customer clicking it
    // gets nothing — so an empty asset must never satisfy the requirement its name implies.
    const assets = downloads();
    assets[1].size = 0;
    expect(missingPortableDownloads(assets.slice(1), EXPECTED_NAMES)).toEqual([
      "keiko-windows-x64.zip",
      "keiko-macos-arm64.zip",
    ]);
  });

  it("reports nothing when every expected download is present and non-empty", () => {
    expect(missingPortableDownloads(downloads(), EXPECTED_NAMES)).toEqual([]);
  });
});

describe("prepublishedReleaseFailures", () => {
  it("accepts a complete, evidence-bound release and returns what must still be hashed", () => {
    const result = verify();

    expect(result.failures).toEqual([]);
    // It never claims the bytes are good — it only says which bytes to check and against what.
    expect(result.expectedDownloads).toEqual(
      downloads().map((asset) => ({
        assetName: asset.name,
        expectedSize: asset.size,
        expectedSha256: asset.sha256,
      })),
    );
  });

  it.each([
    ["the release does not exist", undefined],
    ["the release reports no asset array", { assets: undefined }],
  ])("refuses when %s, naming the command that publishes it", (_label, rel) => {
    const result = verify({ release: rel });

    expect(result.failures.join(" ")).toContain("release-portable-prerelease.mjs --public-release");
    expect(result.expectedDownloads).toEqual([]);
  });

  it("refuses a release that is missing a download before reading any evidence", () => {
    const result = prepublishedReleaseFailures({
      tag: TAG,
      repository: REPOSITORY,
      workflowPath: WORKFLOW_PATH,
      expectedNames: EXPECTED_NAMES,
      release: release(downloads().slice(1)),
      readLatestRelease: () => ({ id: RELEASE_ID }),
      readManifest: () => {
        throw new Error("evidence must not be read when a download is missing");
      },
      readRun: () => goodRun(),
    });

    expect(result.failures).toEqual([
      `GitHub release ${TAG} is missing portable downloads: keiko-windows-x64.zip.`,
    ]);
  });

  it("refuses downloads that carry no evidence asset at all", () => {
    const result = verify({ release: release(downloads(), { withEvidence: false }) });

    expect(result.failures.join(" ")).toContain("keiko-portable-evaluation-manifest.json");
    expect(result.failures.join(" ")).toContain("must never authorize the latest dist-tag");
  });

  it("refuses a release that carries assets its evidence does not declare", () => {
    // A release writer could park an undeclared customer-shaped archive next to the four
    // evidenced downloads; every name-presence check would still pass while customers are
    // offered an unreviewed executable. Exactly the governed set, nothing else.
    const assets = downloads();
    const extra = release(assets);
    extra.assets.push({
      name: "keiko-macos-universal.zip",
      size: 4096,
      browser_download_url: `https://github.com/${REPOSITORY}/releases/download/${TAG}/keiko-macos-universal.zip`,
    });
    const result = verify({ release: extra });

    expect(result.failures.join(" ")).toContain("assets its evidence does not declare");
    expect(result.failures.join(" ")).toContain("keiko-macos-universal.zip");
    expect(result.expectedDownloads).toEqual([]);
  });

  it.each([
    ["an absurdly large", 5 * 1024 * 1024],
    ["a zero-byte", 0],
  ])("refuses %s evidence asset without fetching it", (_label, size) => {
    // Hostile evidence must produce a bounded refusal: the declared size is checked against the
    // manifest ceiling BEFORE any bytes are downloaded or read.
    const assets = downloads();
    const bloated = release(assets);
    const evidenceEntry = bloated.assets.find(
      (asset) => asset.name === "keiko-portable-evaluation-manifest.json",
    );
    evidenceEntry.size = size;
    const result = prepublishedReleaseFailures({
      tag: TAG,
      repository: REPOSITORY,
      workflowPath: WORKFLOW_PATH,
      expectedNames: EXPECTED_NAMES,
      release: bloated,
      readLatestRelease: () => ({ id: RELEASE_ID }),
      readManifest: () => {
        throw new Error("evidence must not be fetched when its size is out of bounds");
      },
      readRun: () => goodRun(),
    });

    expect(result.failures.join(" ")).toContain("refused without being fetched");
    expect(result.expectedDownloads).toEqual([]);
  });

  it("refuses evidence that cannot be read", () => {
    // An unreadable manifest is not a manifest; it must never be treated as an absent objection.
    const result = verify({ manifest: undefined });

    expect(result.failures.join(" ")).toContain("must be a JSON object");
    expect(result.expectedDownloads).toEqual([]);
  });

  it("refuses evidence bound to another release", () => {
    const assets = downloads();
    const result = verify({
      manifest: evidence(assets, {
        release: { releaseTag: "v0.3.0", sourceCommitSha: SOURCE_COMMIT },
      }),
    });

    expect(result.failures.join(" ")).toContain(`release.releaseTag must be ${TAG}`);
  });

  it.each([
    ["names a run that cannot be read", undefined, "could not be read"],
    [
      "names a run of another workflow",
      { ...goodRun(), path: ".github/workflows/release.yml" },
      "must be a run of the portable assets workflow",
    ],
    [
      "names a run of another commit",
      { ...goodRun(), head_sha: "f".repeat(40) },
      "must be the declared source commit",
    ],
    [
      "names a run that did not succeed",
      { ...goodRun(), conclusion: "failure" },
      "must have concluded successfully",
    ],
  ])("refuses evidence that %s", (_label, run, reason) => {
    const result = verify({ run });

    expect(result.failures.join(" ")).toContain(reason);
    expect(result.expectedDownloads).toEqual([]);
  });

  it("refuses a download whose published size disagrees with its evidence", () => {
    // The cheap half of the byte binding: a replaced asset is caught before anything is fetched.
    const assets = downloads();
    const published = downloads();
    published[2].size = published[2].size + 1;
    const result = prepublishedReleaseFailures({
      tag: TAG,
      repository: REPOSITORY,
      workflowPath: WORKFLOW_PATH,
      expectedNames: EXPECTED_NAMES,
      release: release(published),
      readLatestRelease: () => ({ id: RELEASE_ID }),
      readManifest: () => evidence(assets),
      readRun: () => goodRun(),
    });

    expect(result.failures).toEqual([
      "keiko-macos-x64.zip does not have the size its evidence declares.",
    ]);
    // The download that failed is not handed on to be hashed, and the sound ones still are.
    expect(result.expectedDownloads.map((entry) => entry.assetName)).not.toContain(
      "keiko-macos-x64.zip",
    );
  });
});

describe("jsonFromCommand", () => {
  it.each([
    ["a non-result", "not a result"],
    ["a failed command", { status: 1, stdout: '{"ok":true}' }],
    ["output that is not JSON", { status: 0, stdout: "<html>rate limited</html>" }],
    ["no output at all", { status: 0 }],
  ])("returns undefined for %s", (_label, result) => {
    // Every one of these is a refusal, never an absent objection: a rate-limit page or an empty
    // body must not read as "nothing to complain about" on the path to the latest dist-tag.
    expect(jsonFromCommand(result)).toBeUndefined();
  });

  it("returns the parsed payload of a successful command", () => {
    expect(jsonFromCommand({ status: 0, stdout: '{"tag_name":"v0.3.1"}' })).toEqual({
      tag_name: "v0.3.1",
    });
  });
});

describe("releaseReaders", () => {
  function readersWith(answers) {
    const calls = [];
    const readers = releaseReaders({
      gh: (args) => {
        calls.push(args.join(" "));
        return answers[args[1]] ?? { status: 1, stdout: "" };
      },
      downloadJson: (url) => ({ url }),
    });
    return { calls, readers };
  }

  it("asks GitHub for the release by tag and the run attempt by id", () => {
    const { calls, readers } = readersWith({
      [`repos/${REPOSITORY}/releases/tags/${TAG}`]: { status: 0, stdout: '{"assets":[]}' },
      [`repos/${REPOSITORY}/actions/runs/${RUN_ID}/attempts/${String(RUN_ATTEMPT)}`]: {
        status: 0,
        stdout: JSON.stringify(goodRun()),
      },
    });

    expect(readers.readRelease(REPOSITORY, TAG)).toEqual({ assets: [] });
    expect(readers.readRun(REPOSITORY, RUN_ID, RUN_ATTEMPT)).toEqual(goodRun());
    expect(calls).toEqual([
      `api repos/${REPOSITORY}/releases/tags/${TAG}`,
      `api repos/${REPOSITORY}/actions/runs/${RUN_ID}/attempts/${String(RUN_ATTEMPT)}`,
    ]);
  });

  it("reports an unreadable release or run as undefined instead of an empty answer", () => {
    const { readers } = readersWith({});

    expect(readers.readRelease(REPOSITORY, TAG)).toBeUndefined();
    expect(readers.readRun(REPOSITORY, RUN_ID, RUN_ATTEMPT)).toBeUndefined();
  });

  it("refuses a run payload that is not an object", () => {
    const { readers } = readersWith({
      [`repos/${REPOSITORY}/actions/runs/${RUN_ID}/attempts/${String(RUN_ATTEMPT)}`]: {
        status: 0,
        stdout: "[]",
      },
    });

    expect(readers.readRun(REPOSITORY, RUN_ID, RUN_ATTEMPT)).toBeUndefined();
  });

  it("reads the evidence manifest through the injected downloader", () => {
    const { readers } = readersWith({});

    expect(readers.readManifest(MANIFEST_URL)).toEqual({ url: MANIFEST_URL });
  });
});

describe("downloadJsonAsset", () => {
  it("returns the parsed asset when the fetch succeeds", () => {
    const asset = downloadJsonAsset((url, destination) => {
      writeFileSync(destination, JSON.stringify({ from: url }));
      return { status: 0 };
    }, MANIFEST_URL);

    expect(asset).toEqual({ from: MANIFEST_URL });
  });

  it.each([
    ["http://github.com/x.json", "plaintext transport"],
    ["https://user:secret@github.com/x.json", "credentials in the URL"],
    ["not a url", "an unparseable URL"],
  ])("refuses %s (%s) without fetching anything", (url) => {
    const fetchAsset = vi.fn();

    expect(downloadJsonAsset(fetchAsset, url)).toBeUndefined();
    expect(fetchAsset).not.toHaveBeenCalled();
  });

  it.each([
    ["the fetch fails", () => ({ status: 22 })],
    ["the fetch cannot spawn", () => ({ status: 0, error: new Error("curl missing") })],
    ["the fetch returns nothing usable", () => undefined],
  ])("returns undefined when %s", (_label, runFetch) => {
    expect(downloadJsonAsset(runFetch, MANIFEST_URL)).toBeUndefined();
  });

  it("returns undefined when the fetched bytes are not JSON", () => {
    // A rate-limit page or an error body is a refusal, not an empty objection.
    const asset = downloadJsonAsset((_url, destination) => {
      writeFileSync(destination, "<html>rate limited</html>");
      return { status: 0 };
    }, MANIFEST_URL);

    expect(asset).toBeUndefined();
  });

  it("removes its temporary directory on both the success and failure paths", () => {
    const roots = [];
    const capture = (_url, destination) => {
      roots.push(dirname(destination));
      writeFileSync(destination, "{}");
      return { status: 0 };
    };

    expect(downloadJsonAsset(capture, MANIFEST_URL)).toEqual({});
    expect(
      downloadJsonAsset((_url, destination) => {
        roots.push(dirname(destination));
        return { status: 1 };
      }, MANIFEST_URL),
    ).toBeUndefined();
    expect(roots).toHaveLength(2);
    expect(roots.filter((root) => existsSync(root))).toEqual([]);
  });
});

describe("livePublish", () => {
  it.each([
    [{}, true],
    [{ planOnly: true }, false],
    [{ dryRun: true }, false],
  ])("reads %o as %s", (options, expected) => {
    expect(livePublish(options)).toBe(expected);
  });
});

describe("uploadedDownloadSetFailure", () => {
  it("returns undefined for a complete set and names what is missing otherwise", () => {
    expect(uploadedDownloadSetFailure(TAG, downloads(), EXPECTED_NAMES)).toBeUndefined();
    expect(uploadedDownloadSetFailure(TAG, downloads().slice(2), EXPECTED_NAMES)).toContain(
      "keiko-windows-x64.zip, keiko-macos-arm64.zip",
    );
  });
});

describe("portableAssetInputFailure", () => {
  it.each([
    [{ suppliesManifest: true, skipGithubRelease: true, stableLatest: false }, "must attach them"],
    [
      { suppliesManifest: false, skipGithubRelease: true, stableLatest: true },
      "--skip-github-release is not accepted",
    ],
  ])("refuses %o", (input, reason) => {
    expect(portableAssetInputFailure(input)).toContain(reason);
  });

  it.each([
    [{ suppliesManifest: true, skipGithubRelease: false, stableLatest: true }],
    [{ suppliesManifest: false, skipGithubRelease: false, stableLatest: false }],
    // A preview never publishes a release, so skipping one announces nothing.
    [{ suppliesManifest: false, skipGithubRelease: true, stableLatest: false }],
  ])("accepts %o", (input) => {
    expect(portableAssetInputFailure(input)).toBeUndefined();
  });
});

describe("portableDownloadAssetNames", () => {
  it("is the three target archives plus the Windows setup companion, frozen", () => {
    const names = portableDownloadAssetNames(
      [{ assetName: "a.zip" }, { assetName: "b.zip" }],
      "setup.exe",
    );

    expect(names).toEqual(["a.zip", "b.zip", "setup.exe"]);
    expect(Object.isFrozen(names)).toBe(true);
  });
});

describe("portableReleaseGate", () => {
  const TARGETS = [
    { assetName: "keiko-windows-x64.zip", platformTarget: "windows-x64" },
    { assetName: "keiko-macos-arm64.zip", platformTarget: "macos-arm64" },
    { assetName: "keiko-macos-x64.zip", platformTarget: "macos-x64" },
  ];

  function gateWith(overrides = {}) {
    const events = { artifactReads: [], failed: [], logged: [], verified: [] };
    const assets = downloads();
    const manifest = evidence(assets);
    const gate = portableReleaseGate({
      fail: (message) => {
        events.failed.push(message);
        throw new Error(message);
      },
      fetchAssetToFile: (_url, destination) => {
        writeFileSync(destination, JSON.stringify(overrides.manifest ?? manifest));
        return { status: 0 };
      },
      gh: (args) => {
        const path = args[1];
        if (path.includes("/releases/latest")) {
          return { status: 0, stdout: JSON.stringify(overrides.latest ?? { id: RELEASE_ID }) };
        }
        if (path.includes("/releases/tags/")) {
          return {
            status: 0,
            stdout: JSON.stringify(overrides.release ?? release(assets)),
          };
        }
        return { status: 0, stdout: JSON.stringify(overrides.run ?? goodRun()) };
      },
      collectRunArtifactDigests: (repository, runId, names) => {
        events.artifactReads.push({ repository, runId, names });
        if (overrides.artifactDigests !== undefined) return overrides.artifactDigests;
        return new Map(assets.map((asset) => [asset.name, asset.sha256]));
      },
      log: (message) => events.logged.push(message),
      setupAssetName: "keiko-windows-x64-setup.exe",
      snapshot: () => ({ assets: overrides.snapshotAssets ?? assets }),
      targets: TARGETS,
      verifyBytes: (remote, expected) => events.verified.push(expected.map((e) => e.assetName)),
    });
    return { events, gate };
  }

  it("exposes the exact expected download set", () => {
    const { gate } = gateWith();

    expect(gate.expectedNames).toEqual(EXPECTED_NAMES);
  });

  it("verifies a prepublished release end to end and hands the bytes on to be hashed", () => {
    const { events, gate } = gateWith();

    expect(gate.verifyPrepublished(TAG, REPOSITORY, WORKFLOW_PATH)).toBe(true);
    // The digests are taken from the referenced RUN's artifacts, which cannot be rewritten after
    // the run, and only then are the published bytes fetched. The collector receives the
    // evidence-declared immutable identities, not bare names.
    expect(events.artifactReads).toEqual([
      { repository: REPOSITORY, runId: RUN_ID, names: RUN_ARTIFACTS },
    ]);
    expect(events.verified).toEqual([EXPECTED_NAMES]);
    expect(events.logged.join(" ")).toContain("match their evidence");
    expect(events.failed).toEqual([]);
  });

  it("fails a prepublished release whose evidence does not resolve, without hashing anything", () => {
    const { events, gate } = gateWith({ run: { ...goodRun(), conclusion: "cancelled" } });

    expect(() => gate.verifyPrepublished(TAG, REPOSITORY, WORKFLOW_PATH)).toThrow(
      /must have concluded successfully/u,
    );
    expect(events.verified).toEqual([]);
  });

  it("accepts a complete uploaded set and refuses an incomplete one", () => {
    const { events, gate } = gateWith();
    gate.assertUploadedSetComplete({ tag: TAG, repo: REPOSITORY });
    expect(events.logged.join(" ")).toContain("carries every portable download");

    const short = gateWith({ snapshotAssets: downloads().slice(1) });
    expect(() => short.gate.assertUploadedSetComplete({ tag: TAG, repo: REPOSITORY })).toThrow(
      /missing portable downloads: keiko-windows-x64\.zip/u,
    );
  });

  it.each([
    ["the run's artifacts cannot be read", new Map(), "could not be read"],
    [
      "a download is absent from the run's artifacts",
      new Map([["keiko-windows-x64.zip", "0".repeat(64)]]),
      "is not among the artifacts the referenced run produced",
    ],
    [
      "a download does not match the bytes the run produced",
      new Map(downloads().map((asset) => [asset.name, "e".repeat(64)])),
      "does not match the bytes the referenced run produced",
    ],
  ])("refuses when %s, before fetching anything", (_label, artifactDigests, reason) => {
    // The release-hosted evidence must never be its own provenance: replacing the downloads AND
    // the manifest that describes them is one action for anyone who can write release assets.
    const { events, gate } = gateWith({ artifactDigests });

    expect(() => gate.verifyPrepublished(TAG, REPOSITORY, WORKFLOW_PATH)).toThrow(
      new RegExp(reason.replaceAll(" ", "\\s"), "u"),
    );
    expect(events.verified).toEqual([]);
  });

  it("carries the argument refusals through unchanged", () => {
    const { gate } = gateWith();

    expect(
      gate.inputFailure({ suppliesManifest: true, skipGithubRelease: true, stableLatest: false }),
    ).toContain("must attach them");
    expect(
      gate.inputFailure({ suppliesManifest: true, skipGithubRelease: false, stableLatest: true }),
    ).toBeUndefined();
  });
});

describe("collectEvaluationArtifactDigests", () => {
  const DECLARED = [
    { name: "artifact-a", id: 7001 },
    { name: "artifact-b", id: 7002 },
  ];
  const RELEVANT = ["artifact-a.zip", "artifact-b.zip"];

  function recordAnswer(declared, overrides = {}) {
    return {
      status: 0,
      stdout: JSON.stringify({
        name: declared.name,
        expired: false,
        workflow_run: { id: 42 },
        ...overrides,
      }),
    };
  }

  function ghRecords(overrides = {}) {
    return (args) => {
      const id = Number(String(args[1]).split("/").at(-1));
      const declared = DECLARED.find((artifact) => artifact.id === id);
      if (declared === undefined) return { status: 1, stdout: "" };
      return recordAnswer(declared, overrides[id] ?? {});
    };
  }

  function zipFetcher(layout, failFor) {
    return (artifactId, destination) => {
      const declared = DECLARED.find((artifact) => artifact.id === artifactId);
      if (declared === undefined || declared.name === failFor) return { status: 1 };
      const prefix = layout === "nested" ? "inner/" : "";
      writeZipArchiveEntries(destination, [
        { name: `${prefix}${declared.name}.zip`, data: `bytes of ${declared.name}` },
      ]);
      return { status: 0 };
    };
  }

  it.each([["flat"], ["nested"]])(
    "hashes every entry of a %s artifact archive fetched by immutable id",
    (layout) => {
      const digests = collectEvaluationArtifactDigests(
        {
          gh: ghRecords(),
          fetchArtifactZip: zipFetcher(layout),
          hashFile: (path) => `hash:${basename(path)}`,
        },
        REPOSITORY,
        "42",
        DECLARED,
        RELEVANT,
      );

      expect([...digests.entries()]).toEqual([
        ["artifact-a.zip", "hash:artifact-a.zip"],
        ["artifact-b.zip", "hash:artifact-b.zip"],
      ]);
    },
  );

  it("ignores same-named evidence files across artifacts instead of refusing", () => {
    // The 0.3.1 latest-promotion outage: every staging artifact carries per-target evidence
    // files sharing one bare name (SHA256SUMS.txt, sbom.cdx.json, …) with different bytes.
    // Only the published download names may enter the digest map — irrelevant collisions must
    // not refuse a real release.
    const digests = collectEvaluationArtifactDigests(
      {
        gh: ghRecords(),
        fetchArtifactZip: (artifactId, destination) => {
          const declared = DECLARED.find((artifact) => artifact.id === artifactId);
          writeZipArchiveEntries(destination, [
            { name: `${declared.name}.zip`, data: `bytes of ${declared.name}` },
            { name: "evidence/SHA256SUMS.txt", data: `sums for ${declared.name}` },
            { name: "evidence/sbom.cdx.json", data: `sbom for ${declared.name}` },
            { name: "manifest/portable-manifest.json", data: `manifest for ${declared.name}` },
          ]);
          return { status: 0 };
        },
        hashFile: (path) => `hash:${basename(path)}`,
      },
      REPOSITORY,
      "42",
      DECLARED,
      RELEVANT,
    );

    expect([...digests.entries()]).toEqual([
      ["artifact-a.zip", "hash:artifact-a.zip"],
      ["artifact-b.zip", "hash:artifact-b.zip"],
    ]);
  });

  it("keeps verifying the original evidence when the run gains replacement artifacts", () => {
    // THE rerun pin: artifact ids are immutable, so nothing here may consult the run's MUTABLE
    // artifact listing — that is exactly the shape a rerun breaks. A listing call throws and
    // fails this test loudly.
    const digests = collectEvaluationArtifactDigests(
      {
        gh: (args) => {
          if (String(args[1]).includes("/artifacts?")) {
            throw new Error("the collector must not consult the run's mutable artifact listing");
          }
          return ghRecords()(args);
        },
        fetchArtifactZip: zipFetcher("flat"),
        hashFile: (path) => `hash:${basename(path)}`,
      },
      REPOSITORY,
      "42",
      DECLARED,
      RELEVANT,
    );

    expect(digests.size).toBe(2);
  });

  it("returns an empty map when any artifact archive cannot be fetched", () => {
    // Empty means unreadable, and the caller refuses on it — a partial set must never look like a
    // complete one with a missing entry.
    const digests = collectEvaluationArtifactDigests(
      {
        gh: ghRecords(),
        fetchArtifactZip: zipFetcher("flat", "artifact-b"),
        hashFile: () => "unused",
      },
      REPOSITORY,
      "42",
      DECLARED,
      RELEVANT,
    );

    expect(digests.size).toBe(0);
  });

  it.each([
    ["answers with another name", { 7001: { name: "artifact-renamed" } }],
    ["belongs to another run", { 7001: { workflow_run: { id: 43 } } }],
    ["is expired", { 7001: { expired: true } }],
  ])("refuses before fetching when the declared artifact record %s", (_label, overrides) => {
    let fetches = 0;
    const digests = collectEvaluationArtifactDigests(
      {
        gh: ghRecords(overrides),
        fetchArtifactZip: () => {
          fetches += 1;
          return { status: 1 };
        },
        hashFile: () => "unused",
      },
      REPOSITORY,
      "42",
      DECLARED,
      RELEVANT,
    );

    expect(digests.size).toBe(0);
    expect(fetches).toBe(0);
  });

  it("refuses an artifact record that cannot be read", () => {
    const digests = collectEvaluationArtifactDigests(
      {
        gh: () => ({ status: 1, stdout: "" }),
        fetchArtifactZip: () => ({ status: 0 }),
        hashFile: () => "unused",
      },
      REPOSITORY,
      "42",
      DECLARED,
      RELEVANT,
    );

    expect(digests.size).toBe(0);
  });

  it("refuses a malformed artifact archive", () => {
    const digests = collectEvaluationArtifactDigests(
      {
        gh: ghRecords(),
        fetchArtifactZip: (_artifactId, destination) => {
          writeFileSync(destination, "not a zip archive");
          return { status: 0 };
        },
        hashFile: () => "unused",
      },
      REPOSITORY,
      "42",
      DECLARED,
      RELEVANT,
    );

    expect(digests.size).toBe(0);
  });

  it("leaves no temporary directory behind", () => {
    const roots = [];
    collectEvaluationArtifactDigests(
      {
        gh: ghRecords(),
        fetchArtifactZip: (_artifactId, destination) => {
          roots.push(dirname(destination));
          return { status: 1 };
        },
        hashFile: () => "unused",
      },
      REPOSITORY,
      "42",
      DECLARED,
      RELEVANT,
    );

    expect(roots).toHaveLength(1);
    expect(roots.filter((root) => existsSync(root))).toEqual([]);
  });
});

describe("commit binding and ambiguous evidence", () => {
  it("refuses evidence whose source commit is not the commit being released", () => {
    // Self-declared is not bound. Without this, a manually assembled release could ship portable
    // bytes from one revision and npm packages from another, and the workflow-run check would
    // agree with the manifest's own claim about which revision that was.
    const assets = downloads();
    const result = prepublishedReleaseFailures({
      tag: TAG,
      repository: REPOSITORY,
      workflowPath: WORKFLOW_PATH,
      expectedNames: EXPECTED_NAMES,
      sourceCommitSha: "b".repeat(40),
      release: release(assets),
      readLatestRelease: () => ({ id: RELEASE_ID }),
      readManifest: () => evidence(assets),
      readRun: () => goodRun(),
    });

    expect(result.failures.join(" ")).toContain("must be the commit being released");
    expect(result.expectedDownloads).toEqual([]);
  });

  it("accepts evidence whose source commit is the commit being released", () => {
    const assets = downloads();
    const result = prepublishedReleaseFailures({
      tag: TAG,
      repository: REPOSITORY,
      workflowPath: WORKFLOW_PATH,
      expectedNames: EXPECTED_NAMES,
      sourceCommitSha: SOURCE_COMMIT,
      release: release(assets),
      readLatestRelease: () => ({ id: RELEASE_ID }),
      readManifest: () => evidence(assets),
      readRun: () => goodRun(),
    });

    expect(result.failures).toEqual([]);
  });

  it("reports an unreadable run when two artifacts disagree about one file name", () => {
    // Two artifacts may legitimately contain a file of the same name. Last-write-wins would let
    // the map answer with the wrong artifact's bytes, so a genuine disagreement is ambiguous
    // evidence and refuses rather than resolving itself.
    let call = 0;
    const declared = [
      { name: "artifact-a", id: 7001 },
      { name: "artifact-b", id: 7002 },
    ];
    const digests = collectEvaluationArtifactDigests(
      {
        gh: (args) => {
          const id = Number(String(args[1]).split("/").at(-1));
          const match = declared.find((artifact) => artifact.id === id);
          if (match === undefined) return { status: 1, stdout: "" };
          return {
            status: 0,
            stdout: JSON.stringify({
              name: match.name,
              expired: false,
              workflow_run: { id: 42 },
            }),
          };
        },
        fetchArtifactZip: (_artifactId, destination) => {
          writeZipArchiveEntries(destination, [{ name: "keiko-macos-x64.zip", data: "bytes" }]);
          return { status: 0 };
        },
        hashFile: () => {
          call += 1;
          return call === 1 ? "a".repeat(64) : "b".repeat(64);
        },
      },
      REPOSITORY,
      "42",
      declared,
      ["keiko-macos-x64.zip"],
    );

    expect(digests.size).toBe(0);
  });
});

describe("published stable shape", () => {
  // The release-by-tag endpoint resolves drafts and prereleases with every asset in place, so
  // the flags themselves are load-bearing: without these refusals a manually assembled
  // prerelease could authorize npm latest while GitHub never presents it as the stable release.
  it.each([
    ["a draft", { draft: true }],
    ["marked as a prerelease", { prerelease: true }],
  ])("refuses a release that is %s", (_label, flags) => {
    const assets = downloads();
    const result = prepublishedReleaseFailures({
      tag: TAG,
      repository: REPOSITORY,
      workflowPath: WORKFLOW_PATH,
      expectedNames: EXPECTED_NAMES,
      release: { ...release(assets), ...flags },
      readManifest: () => evidence(assets),
      readRun: () => goodRun(),
    });

    expect(result.failures.join(" ")).toContain("only the published stable release");
    expect(result.expectedDownloads).toEqual([]);
  });

  it.each([
    ["names a different release", { id: RELEASE_ID + 1 }],
    ["cannot be read", undefined],
  ])("refuses a release when the Latest badge %s", (_label, latest) => {
    // draft:false/prerelease:false cannot say which release GitHub DIRECTS customers to — the
    // npm latest dist-tag and GitHub's Latest release must name the same bytes.
    const result = verify({ latest });

    expect(result.failures.join(" ")).toContain("does not own the Latest badge");
    expect(result.expectedDownloads).toEqual([]);
  });

  it("refuses a payload that omits the draft and prerelease flags entirely", () => {
    // Absent is not published: a payload that never states the flags gets no benefit of doubt.
    const assets = downloads();
    const bare = { ...release(assets) };
    delete bare.draft;
    delete bare.prerelease;
    const result = prepublishedReleaseFailures({
      tag: TAG,
      repository: REPOSITORY,
      workflowPath: WORKFLOW_PATH,
      expectedNames: EXPECTED_NAMES,
      release: bare,
      readManifest: () => evidence(assets),
      readRun: () => goodRun(),
    });

    expect(result.failures.join(" ")).toContain("only the published stable release");
  });
});
