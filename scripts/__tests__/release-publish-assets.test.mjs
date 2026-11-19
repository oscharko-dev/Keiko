// Release-publish pipeline: the release assets (downloads, folder packages, published reruns,
// resumed drafts, signing keys and remote tampering). Same real orchestrator and stubbed
// npm/gh/git/curl as release-publish-pipeline.test.mjs, which describes the harness and the core
// publish scenarios; the two files are separate so each fits a coverage shard (PR #4464).

import { Buffer } from "node:buffer";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PORTABLE_TARGETS, WINDOWS_PORTABLE_SETUP_ASSET_NAME } from "../portable-runtime.mjs";
import {
  FOLDER_RELEASE_TARGETS,
  folderPackageArchiveName,
} from "../lib/folder-package-release.mjs";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  REPO_ROOT,
  RELEASE_VERSION,
  RELEASE_SPEC,
  RELEASE_PIPELINE_TEST_TIMEOUT_MS,
  HEAD_SHA,
  expectNoPublicationSideEffect,
  registryVersionBody,
  passthroughViewBody,
  runPublish,
  npmStub,
  indexOfCall,
  isDistTagView,
  isVersionEndpointCurl,
  RELEASE_VERSION_IS_PRERELEASE,
  assertReleaseBuildPresent,
} from "./support/release-publish-pipeline-harness.mjs";

beforeAll(assertReleaseBuildPresent);

describe.skipIf(RELEASE_VERSION_IS_PRERELEASE)(
  "release-publish pipeline (real orchestrator, stubbed npm/gh/git)",
  { timeout: RELEASE_PIPELINE_TEST_TIMEOUT_MS },
  () => {
    let lastRun;

    afterEach(() => {
      lastRun = undefined;
    });

    it("allows benign authentication prose in release evidence", () => {
      const viewBody =
        'if (argv.includes("version")) { process.stdout.write(VERSION + "\\n"); process.exit(0); }';
      lastRun = runPublish({
        npmBody: npmStub(viewBody, { failOnPublish: true }),
        initState: { published: true, tagged: true },
        portableFixtureOptions: {
          mutateEvidence: (root, _manifest, _target, index) => {
            if (index === 0) {
              writeFileSync(
                join(root, "evidence", "third-party-notices.txt"),
                "Basic authentication utilities for local testing.\nThe bearer must retain this notice.\n",
              );
            }
          },
        },
      });

      expect(lastRun.stderr).not.toContain("license evidence is not redacted");
      expect(lastRun.calls.some((line) => line.startsWith('gh ["release","upload"'))).toBe(true);
    });

    it("treats a 404 from the version-specific registry endpoint as unpublished and publishes, tags, then verifies", () => {
      // The version endpoint stays 404 until a publish has happened; the dist-tag view reports the
      // wrong version until `npm dist-tag add` runs.
      const viewBody = [
        "  const s = state();",
        '  if (argv.includes("version")) {',
        "    if (!s.published) {",
        // Real npm E404 shape; the heuristic scans for "E404" / "No match found".
        '      process.stderr.write("npm error code E404\\nnpm error 404 Not Found - GET " + argv[1] + "\\n");',
        "      process.exit(1);",
        "    }",
        '    process.stdout.write(VERSION + "\\n");',
        "    process.exit(0);",
        "  }",
        '  if (argv.some((a) => a.startsWith("dist-tags."))) {',
        '    process.stdout.write((s.tagged ? VERSION : "0.0.0-stale") + "\\n");',
        "    process.exit(0);",
        "  }",
      ].join("\n");

      lastRun = runPublish({
        npmBody: npmStub(viewBody),
        initState: { published: false },
      });

      expect(lastRun.status, lastRun.stderr).toBe(0);
      expect(lastRun.stdout).toContain(`PUBLISH ${RELEASE_SPEC}`);
      expect(lastRun.stdout).toContain("portable assets uploaded and verified");
      expect(lastRun.stdout).toContain(`PASS - ${RELEASE_SPEC} published as latest`);
      // It must NOT have short-circuited as already-present.
      expect(lastRun.stdout).not.toContain(`SKIP ${RELEASE_SPEC} already exists`);

      // Decision order: check existence -> publish -> add dist-tag -> re-verify existence -> re-verify dist-tag.
      const firstVersionRead = indexOfCall(lastRun.calls, isVersionEndpointCurl);
      const publishCall = indexOfCall(lastRun.calls, (l) => l.startsWith('npm ["publish"'));
      const distTagAdd = indexOfCall(lastRun.calls, (l) => l.startsWith('npm ["dist-tag","add"'));

      expect(firstVersionRead).toBeGreaterThanOrEqual(0);
      expect(publishCall).toBeGreaterThan(firstVersionRead);
      expect(distTagAdd).toBeGreaterThan(publishCall);

      // Publish carries the release-safety flags on the real command line.
      const publishLine = lastRun.calls.find((l) => l.startsWith('npm ["publish"'));
      expect(publishLine).toBe(
        'npm ["publish",".","--access","public","--tag","latest","--registry","https://registry.npmjs.org/","--ignore-scripts"]',
      );
      const publishCwdLine = lastRun.calls.find((line) => line.startsWith("npm-cwd "));
      expect(publishCwdLine).toBeDefined();
      const publishCwd = JSON.parse(publishCwdLine?.slice("npm-cwd ".length) ?? '""');
      expect(publishCwd).not.toBe(REPO_ROOT);
      expect(publishCwd).toMatch(/keiko-publish-stage-[^/\\]+$/u);
      // A token publish carries no provenance attestation: npm can attest only where an OIDC
      // provider exists, and the unconditional flag killed every local operator publish (0.3.1).

      // The post-publish verification pass re-reads BOTH the version and the dist-tag.
      const versionEndpointReads = lastRun.calls.filter(isVersionEndpointCurl);
      const versionViews = versionEndpointReads.length;
      const distTagViews = lastRun.calls.filter(isDistTagView).length;
      expect(versionViews).toBeGreaterThanOrEqual(2);
      expect(distTagViews).toBeGreaterThanOrEqual(2);
      expect(versionEndpointReads[0]).toContain('"--connect-timeout","5"');
      expect(versionEndpointReads[0]).toContain('"--max-time","15"');

      const uploadLine = lastRun.calls.find(
        (l) => l.startsWith('gh ["release","upload"') && l.includes("keiko-windows-x64.zip"),
      );
      expect(uploadLine).toContain("keiko-windows-x64.zip");
      expect(uploadLine).toContain(WINDOWS_PORTABLE_SETUP_ASSET_NAME);
      expect(uploadLine).toContain("keiko-macos-arm64.zip");
      expect(uploadLine).toContain("keiko-macos-x64.zip");
      const setupAttestation = lastRun.calls.find((line) =>
        line.startsWith('gh ["attestation","verify"'),
      );
      expect(setupAttestation).toContain(WINDOWS_PORTABLE_SETUP_ASSET_NAME);
      expect(setupAttestation).toContain(
        '"--signer-workflow","oscharko-dev/Keiko/.github/workflows/portable-assets.yml"',
      );
      expect(setupAttestation).toContain(`"--source-digest","${HEAD_SHA}"`);
      expect(setupAttestation).toContain(`"--source-ref","refs/tags/v${RELEASE_VERSION}"`);
      expect(
        indexOfCall(lastRun.calls, (l) => l.startsWith('gh ["release","upload"')),
      ).toBeGreaterThan(indexOfCall(lastRun.calls, (l) => l === setupAttestation));
      expect(
        indexOfCall(lastRun.calls, (l) => l.startsWith('gh ["release","upload"')),
      ).toBeLessThan(publishCall);
      const setupDownload = lastRun.calls.find(
        (line) =>
          line.startsWith("curl [") &&
          line.endsWith(
            `"https://github.com/oscharko-dev/Keiko/releases/download/v${RELEASE_VERSION}/${WINDOWS_PORTABLE_SETUP_ASSET_NAME}"]`,
          ),
      );
      expect(setupDownload).toBeDefined();
    });

    it("binds setup evidence to verified remote bytes after local post-upload mutation", () => {
      const viewBody = [
        '  if (argv.includes("version")) { process.stdout.write(VERSION + "\\n"); process.exit(0); }',
        '  if (argv.some((a) => a.startsWith("dist-tags."))) { process.stdout.write(VERSION + "\\n"); process.exit(0); }',
      ].join("\n");

      lastRun = runPublish({
        npmBody: npmStub(viewBody, { failOnPublish: true }),
        initState: {
          mutateSetupAfterArchiveUpload: true,
          published: true,
          tagged: true,
        },
      });

      expect(lastRun.status, lastRun.stderr).toBe(0);
      expect(lastRun.stdout).toContain("portable assets uploaded and verified");
    });

    it("assembles the release as a draft and publishes it only after every download verified", () => {
      // v1.0.0, 2026-09-14: the release was created as published, and GitHub immutable releases refused
      // every upload after that ("HTTP 422: Cannot upload assets to an immutable release"), which burned
      // the tag name. Assets now go into a draft that is published last.
      const viewBody = [
        '  if (argv.includes("version")) { process.stdout.write(VERSION + "\\n"); process.exit(0); }',
        '  if (argv.some((a) => a.startsWith("dist-tags."))) { process.stdout.write(VERSION + "\\n"); process.exit(0); }',
      ].join("\n");

      lastRun = runPublish({
        npmBody: npmStub(viewBody, { failOnPublish: true }),
        initState: { immutableReleases: true, published: true, tagged: true },
      });

      expect(lastRun.status, lastRun.stderr).toBe(0);
      const create = indexOfCall(
        lastRun.calls,
        (l) => l.startsWith('gh ["api","--method","POST"') && l.includes('/releases"'),
      );
      const firstUpload = indexOfCall(lastRun.calls, (l) => l.startsWith('gh ["release","upload"'));
      const publish = indexOfCall(
        lastRun.calls,
        (l) => l.startsWith('gh ["release","edit"') && l.includes('"--draft=false"'),
      );
      expect(lastRun.calls[create]).toContain('"draft=true"');
      expect(create).toBeLessThan(firstUpload);
      expect(firstUpload).toBeLessThan(publish);
      expect(lastRun.calls.slice(publish).some((l) => l.startsWith('gh ["release","upload"'))).toBe(
        false,
      );
      expect(lastRun.stdout).toContain("portable assets uploaded and verified");
      // The folder packages and their .sha256 files go into the same draft, before publication,
      // and are downloaded back and compared like every other asset.
      const uploads = lastRun.calls.slice(0, publish).filter((l) => l.includes('"upload"'));
      // Each package's build provenance is verified before anything reaches the draft; its
      // .sha256 file is derived from that digest and carries none of its own.
      const attestations = lastRun.calls.filter((l) => l.startsWith('gh ["attestation","verify"'));
      expect(attestations.some((l) => l.includes('.standalone.zip.sha256"'))).toBe(false);
      for (const target of FOLDER_RELEASE_TARGETS) {
        const name = folderPackageArchiveName(target, "standalone");
        const attestation = attestations.find((l) => l.includes(`/${name}"`));
        expect(attestation).toContain(
          '"--signer-workflow","oscharko-dev/Keiko/.github/workflows/portable-assets.yml"',
        );
        expect(attestation).toContain(`"--source-digest","${HEAD_SHA}"`);
        expect(attestation).toContain(`"--source-ref","refs/tags/v${RELEASE_VERSION}"`);
        expect(indexOfCall(lastRun.calls, (l) => l === attestation)).toBeLessThan(firstUpload);
        expect(uploads.some((l) => l.includes(`/${name}"`))).toBe(true);
        expect(uploads.some((l) => l.includes(`/${name}.sha256"`))).toBe(true);
        expect(lastRun.calls.some((l) => l.startsWith("curl [") && l.endsWith(`/${name}"]`))).toBe(
          true,
        );
      }
    });

    it.each([
      ["no folder packages", { folderPackages: false }, "carries no folder packages"],
      [
        "a folder package built from another archive",
        {
          mutateFolderPackages: (manifest) => {
            manifest.packages[0].sourceArchive.sha256 = "0".repeat(64);
          },
        },
        "must be built from this release's archive",
      ],
      [
        "a folder package whose bytes changed",
        {
          mutateFolderPackages: (manifest, directory) => {
            writeFileSync(join(directory, manifest.packages[1].assetName), "other bytes");
          },
        },
        "does not have the digest and size its manifest declares",
      ],
      [
        "a folder package missing a target",
        {
          mutateFolderPackages: (manifest) => {
            manifest.packages = manifest.packages.slice(0, -1);
          },
        },
        "the folder package of windows-x64 is missing",
      ],
    ])("refuses a bundle with %s before the release or npm publication", (_, options, message) => {
      lastRun = runPublish({
        npmBody: npmStub(passthroughViewBody(), { failOnPublish: true }),
        initState: { immutableReleases: true, published: false },
        portableFixtureOptions: options,
      });

      expect(lastRun.status).toBe(1);
      expect(lastRun.stderr).toContain("folder package validation failed");
      expect(lastRun.stderr).toContain(message);
      expect(lastRun.calls.some((l) => l.startsWith('gh ["api","--method","POST"'))).toBe(false);
      expect(lastRun.calls.some((l) => l.startsWith('gh ["release","upload"'))).toBe(false);
      expect(lastRun.calls.some((l) => l.startsWith('npm ["publish"'))).toBe(false);
    });

    it("refuses to upload into a release that is already published without its downloads", () => {
      lastRun = runPublish({
        npmBody: npmStub(passthroughViewBody(), { failOnPublish: true }),
        initState: { immutableReleases: true, published: false, releasePublished: true },
      });

      expect(lastRun.status).toBe(1);
      expect(lastRun.stderr).toContain("an immutable release cannot be repaired");
      expect(lastRun.calls.some((l) => l.startsWith('gh ["release","upload"'))).toBe(false);
      expect(lastRun.calls.some((l) => l.startsWith('npm ["publish"'))).toBe(false);
    });

    it("refuses a published release that carries the archives but not the folder packages", () => {
      // A re-run after publication can only verify: nothing can add the folder packages to an
      // immutable release, so a release published without them fails closed, naming only them.
      const archivesOnly = [
        ...PORTABLE_TARGETS.map((target) => target.assetName),
        WINDOWS_PORTABLE_SETUP_ASSET_NAME,
      ].map((name, index) => ({
        id: 200000 + index,
        name,
        size: 1,
        digest: `sha256:${"0".repeat(64)}`,
        content: "",
      }));
      lastRun = runPublish({
        npmBody: npmStub(passthroughViewBody(), { failOnPublish: true }),
        initState: {
          immutableReleases: true,
          published: false,
          releasePublished: true,
          uploadedAssets: archivesOnly,
        },
      });

      expect(lastRun.status).toBe(1);
      expect(lastRun.stderr).toContain("an immutable release cannot be repaired");
      for (const target of FOLDER_RELEASE_TARGETS) {
        const name = folderPackageArchiveName(target, "standalone");
        expect(lastRun.stderr).toContain(`${name},`);
        expect(lastRun.stderr).toContain(`${name}.sha256`);
      }
      expect(lastRun.stderr).not.toMatch(/lacks[^\n]*keiko-macos-arm64\.zip/u);
      expect(lastRun.calls.some((l) => l.startsWith('gh ["release","upload"'))).toBe(false);
      expect(lastRun.calls.some((l) => l.startsWith('npm ["publish"'))).toBe(false);
    });

    describe("a rerun over a published release (PR #4464)", () => {
      // Review finding on PR #4464 (P2): the first run published the release and then failed its
      // public download of a folder package. The rerun found the release published, checked the
      // API metadata and returned before any download, so npm published Keiko beside a package
      // nobody could fetch.
      // Each run below is one full orchestrator subprocess graph (about 20 s under the bounded
      // two-worker scheduler), so the published first run is built once with its own deadline and
      // each rerun keeps the suite's per-test deadline instead of three runs sharing one.
      const signingKeyPair = generateKeyPairSync("ed25519");
      const failing = folderPackageArchiveName("macos-arm64", "standalone");
      let first;

      beforeAll(() => {
        first = runPublish({
          npmBody: npmStub(registryVersionBody()),
          initState: { immutableReleases: true, published: false, failPublicDownloads: [failing] },
          signingKeyPair,
        });
      }, RELEASE_PIPELINE_TEST_TIMEOUT_MS);

      it("publishes the release on the first run and stops before npm when a download fails", () => {
        lastRun = first;
        expect(first.status).toBe(1);
        expect(first.stderr).toContain(
          `unauthenticated portable asset download failed for ${failing}.`,
        );
        expect(first.state.releasePublished).toBe(true);
        expect(first.calls.some((l) => l.startsWith('npm ["publish"'))).toBe(false);
      });

      it("downloads every asset again and still refuses npm while the download fails", () => {
        const rerun = runPublish({
          npmBody: npmStub(registryVersionBody()),
          initState: first.state,
          signingKeyPair,
        });
        lastRun = rerun;
        expect(rerun.status).toBe(1);
        expect(rerun.stderr).toContain(
          `unauthenticated portable asset download failed for ${failing}.`,
        );
        expect(rerun.calls.some((l) => l.startsWith('gh ["release","upload"'))).toBe(false);
        expect(rerun.calls.some((l) => l.startsWith('npm ["publish"'))).toBe(false);
      });

      it("downloads every asset again when it reruns over a published release (PR #4464)", () => {
        // Once the download works, the same rerun proves every asset publicly and publishes npm.
        const recovered = runPublish({
          npmBody: npmStub(registryVersionBody()),
          initState: { ...first.state, failPublicDownloads: [] },
          signingKeyPair,
        });
        lastRun = recovered;
        expect(recovered.status, recovered.stderr).toBe(0);
        expect(recovered.stdout).toContain("portable assets verified and downloaded on published");
        const downloads = recovered.calls.filter(
          (l) => l.startsWith("curl [") && l.includes("/releases/download/"),
        );
        // No user configuration (.curlrc) may apply to the unauthenticated smoke download, and no
        // redirect may leave HTTPS.
        for (const line of downloads) {
          expect(JSON.parse(line.slice("curl ".length)).slice(0, 5)).toEqual([
            "-q",
            "--proto",
            "=https",
            "--proto-redir",
            "=https",
          ]);
        }
        const downloadedNames = downloads
          .map((line) =>
            String(JSON.parse(line.slice("curl ".length)).at(-1))
              .split("/")
              .at(-1),
          )
          .sort();
        const expectedNames = first.state.uploadedAssets.map((asset) => asset.name).sort();
        expect(downloadedNames).toEqual(expectedNames);
        expect(recovered.calls.some((l) => l.startsWith('gh ["release","upload"'))).toBe(false);
        expect(recovered.calls.some((l) => l.startsWith('npm ["publish"'))).toBe(true);
      });
    });

    it("bounds every portable download by time, stall and bytes and names the asset (PR #4464)", () => {
      // Review findings on PR #4464: a download that never finished, or a response larger than the
      // verified asset, ran until the job was cancelled or the temporary storage was full.
      const signingKeyPair = generateKeyPairSync("ed25519");
      const target = folderPackageArchiveName("macos-arm64", "standalone");
      const ok = runPublish({
        npmBody: npmStub(registryVersionBody()),
        initState: { immutableReleases: true, published: false },
        signingKeyPair,
      });
      expect(ok.status, ok.stderr).toBe(0);
      const download = ok.calls
        .filter((l) => l.startsWith("curl [") && l.includes("/releases/download/"))
        .map((l) => JSON.parse(l.slice("curl ".length)))[0];
      for (const flag of ["--max-time", "--speed-limit", "--speed-time", "--max-filesize"]) {
        expect(download).toContain(flag);
      }

      // No Content-Length is involved: the stub writes a file larger than the expected size.
      // CodeRabbit on PR #4464: the failure exited inside the download's try, so its temporary
      // folder with the partial archive stayed behind. The publisher's own TMPDIR shows it.
      const publisherTemp = mkdtempSync(join(tmpdir(), "keiko-release-publish-tmp-"));
      const oversized = runPublish({
        npmBody: npmStub(registryVersionBody()),
        initState: {
          immutableReleases: true,
          published: false,
          oversizeRemoteDownloads: [target],
        },
        signingKeyPair,
        qualificationEnv: { TMPDIR: publisherTemp },
      });
      expect(oversized.status).toBe(1);
      expect(oversized.stderr).toContain(
        `portable asset download exceeded the expected size for ${target}.`,
      );
      expect(oversized.calls.some((l) => l.startsWith('npm ["publish"'))).toBe(false);
      expect(
        readdirSync(publisherTemp).filter((name) => name.startsWith("keiko-portable-download-")),
      ).toEqual([]);
      // Codex review of PR #4464: `fail` exited the process while the evidence, package staging
      // and npm configuration scopes were active, so their `finally` blocks never ran and the
      // temporary `.npmrc` (with the token) stayed behind. The failure now unwinds those scopes:
      // nothing the publisher created may remain in its temporary folder.
      expect(readdirSync(publisherTemp).filter((name) => name.startsWith("keiko-"))).toEqual([]);
      rmSync(publisherTemp, { force: true, recursive: true });

      // A download that never ends is stopped at the deadline and named.
      const hung = runPublish({
        npmBody: npmStub(registryVersionBody()),
        initState: { immutableReleases: true, published: false, hangPublicDownloads: [target] },
        signingKeyPair,
        qualificationEnv: { KEIKO_PORTABLE_DOWNLOAD_MAX_TIME_SECONDS: "1" },
      });
      expect(hung.status).toBe(1);
      expect(hung.stderr).toContain(`portable asset download timed out for ${target}.`);
    }, 120_000);

    it("refuses to download a published manifest whose recorded URL has credentials or is not HTTPS (PR #4464)", () => {
      // Review finding on PR #4464: on a rerun the manifest records' browser_download_url reached
      // curl without the HTTPS/no-userinfo rule every other asset is held to.
      const signingKeyPair = generateKeyPairSync("ed25519");
      const first = runPublish({
        npmBody: npmStub(registryVersionBody()),
        initState: { immutableReleases: true, published: false },
        signingKeyPair,
      });
      expect(first.status, first.stderr).toBe(0);
      const rejectedUrls = [
        `https://user:secret@github.com/oscharko-dev/Keiko/releases/download/v${RELEASE_VERSION}/`,
        // Credential-free but not HTTPS: only the scheme rule can reject it.
        `http://github.com/oscharko-dev/Keiko/releases/download/v${RELEASE_VERSION}/`,
      ];
      for (const url of rejectedUrls) {
        const uploadedAssets = first.state.uploadedAssets.map((asset) =>
          asset.name.endsWith("-portable-manifest.json")
            ? { ...asset, browser_download_url: `${url}${asset.name}` }
            : asset,
        );
        const rerun = runPublish({
          npmBody: npmStub(registryVersionBody(), { failOnPublish: true }),
          initState: { ...first.state, uploadedAssets },
          signingKeyPair,
        });
        expect(rerun.status).toBe(1);
        expect(rerun.stderr).toContain(
          "-portable-manifest.json must expose an HTTPS browser_download_url without credentials before it is downloaded.",
        );
        expect(rerun.stderr).not.toContain("secret");
        expect(
          rerun.calls.some((l) => l.startsWith("curl [") && l.includes(`${url}`.slice(0, 20))),
        ).toBe(false);
        expect(rerun.calls.some((l) => l.startsWith('npm ["publish"'))).toBe(false);
      }
    }, 120_000);

    it("refuses to publish a resumed draft that carries a package this run did not validate (PR #4464)", () => {
      // Review finding on PR #4464 (P2): a resumed draft with every expected asset and an extra
      // keiko-linux-x64.standalone.zip reached publication, so the stale package would have become
      // an immutable public download outside the validated bundle.
      const stale = Buffer.from("stale linux folder package\n");
      const extra = {
        id: 300001,
        name: "keiko-linux-x64.standalone.zip",
        size: stale.byteLength,
        content: stale.toString("base64"),
        digest: `sha256:${createHash("sha256").update(stale).digest("hex")}`,
        browser_download_url: `https://github.com/oscharko-dev/Keiko/releases/download/v${RELEASE_VERSION}/keiko-linux-x64.standalone.zip`,
      };
      const resumed = {
        immutableReleases: true,
        published: false,
        publisherDraft: true,
        resumableDraft: true,
      };
      lastRun = runPublish({
        npmBody: npmStub(registryVersionBody()),
        initState: { ...resumed, uploadedAssets: [extra] },
      });

      expect(lastRun.status).toBe(1);
      expect(lastRun.stdout).toContain("resuming draft GitHub release");
      expect(lastRun.stderr).toContain(
        "carries assets this run did not validate: keiko-linux-x64.standalone.zip; delete them from the draft",
      );
      expect(
        lastRun.calls.some(
          (l) => l.startsWith('gh ["release","edit"') && l.includes("--draft=false"),
        ),
      ).toBe(false);
      expect(lastRun.calls.some((l) => l.startsWith('npm ["publish"'))).toBe(false);

      // The failed run's own state, with only the stale package removed, is published.
      expect(lastRun.state.releasePublished).not.toBe(true);
      const refusedState = lastRun.state;
      lastRun = runPublish({
        npmBody: npmStub(registryVersionBody()),
        initState: {
          ...refusedState,
          uploadedAssets: refusedState.uploadedAssets.filter((asset) => asset.name !== extra.name),
        },
      });
      expect(lastRun.status, lastRun.stderr).toBe(0);
      expect(lastRun.stdout).toContain("resuming draft GitHub release");
      expect(lastRun.state.releasePublished).toBe(true);
    });

    it("fails before npm publish when portable upload verification fails", () => {
      const viewBody = [
        "  const s = state();",
        '  if (argv.includes("version")) {',
        '    if (!s.published) { process.stderr.write("npm error code E404\\n"); process.exit(1); }',
        '    process.stdout.write(VERSION + "\\n");',
        "    process.exit(0);",
        "  }",
        '  if (argv.some((a) => a.startsWith("dist-tags."))) { process.stdout.write(VERSION + "\\n"); process.exit(0); }',
      ].join("\n");

      lastRun = runPublish({
        npmBody: npmStub(viewBody),
        initState: { failGhUpload: true, published: false },
      });

      expect(lastRun.status).toBe(1);
      expect(lastRun.stderr).toContain("portable upload failed");
      expect(lastRun.calls.some((l) => l.startsWith('npm ["publish"'))).toBe(false);
    });

    it("refuses an untrusted release signing key before the GitHub release exists", () => {
      // The key was first used while binding archives already uploaded to the created release, so
      // a key the shipped trust roots reject failed only after `gh release create` and the
      // archive upload, and stranded a half-published Latest release.
      const signingKey = generateKeyPairSync("ed25519").privateKey.export({
        format: "pem",
        type: "pkcs8",
      });
      lastRun = runPublish({
        npmBody: npmStub(passthroughViewBody(), { failOnPublish: true }),
        initState: { published: false },
        qualificationEnv: { KEIKO_PORTABLE_RELEASE_SIGNING_KEY: signingKey },
      });

      expect(lastRun.status).toBe(1);
      expect(lastRun.stderr).toContain(
        "portable release signing key is not trusted (key-untrusted); nothing was published.",
      );
      expect(lastRun.stdout + lastRun.stderr).not.toContain(signingKey.split("\n")[1]);
      expectNoPublicationSideEffect(lastRun.calls);
    });

    it("refuses an unusable release signing key before the GitHub release exists", () => {
      const signingKey = "not-an-ed25519-private-key";
      lastRun = runPublish({
        npmBody: npmStub(passthroughViewBody(), { failOnPublish: true }),
        initState: { published: false },
        qualificationEnv: { KEIKO_PORTABLE_RELEASE_SIGNING_KEY: signingKey },
      });

      expect(lastRun.status).toBe(1);
      expect(lastRun.stderr).toContain(
        "portable release signing key is not a usable Ed25519 private key; nothing was published.",
      );
      expect(lastRun.stdout + lastRun.stderr).not.toContain(signingKey);
      expectNoPublicationSideEffect(lastRun.calls);
    });

    it.each([
      ["empty", ""],
      ["unset", undefined],
    ])("refuses an %s release signing key before the GitHub release exists", (_label, value) => {
      lastRun = runPublish({
        npmBody: npmStub(passthroughViewBody(), { failOnPublish: true }),
        initState: { published: false },
        qualificationEnv: { KEIKO_PORTABLE_RELEASE_SIGNING_KEY: value },
      });

      expect(lastRun.status).toBe(1);
      expect(lastRun.stderr).toContain(
        "KEIKO_PORTABLE_RELEASE_SIGNING_KEY is required for portable release publication.",
      );
      expectNoPublicationSideEffect(lastRun.calls);
    });

    it("stops before creating the release when a newer candidate moved the tag", () => {
      // ADR-0177 D8: the release candidate may move an unpublished tag, and `gh release create`
      // binds the release to wherever the tag points. A publish that checked out the older commit
      // must not attach its bundle to the newer one.
      lastRun = runPublish({
        npmBody: npmStub(passthroughViewBody(), { failOnPublish: true }),
        initState: { published: false, remoteTagSha: "f".repeat(40) },
      });

      expect(lastRun.status).toBe(1);
      expect(lastRun.stderr).toContain(
        "a release created or published now would bind to another commit",
      );
      expectNoPublicationSideEffect(lastRun.calls);
    });

    it("refuses to upload qualified assets over a published evaluation release", () => {
      // The evaluation lane's completed release is isDraft:false and carries the evidence
      // manifest; clobbering it with production bytes would leave that evidence beside foreign
      // downloads — a mixed-provenance surface (Codex finding on #3054).
      lastRun = runPublish({
        npmBody: npmStub(passthroughViewBody(), { failOnPublish: true }),
        initState: { existingEvaluationRelease: true, published: false },
      });

      expect(lastRun.status).toBe(1);
      expect(lastRun.stderr).toContain("published by the evaluation lane");
      expect(lastRun.calls.some((l) => l.startsWith('npm ["publish"'))).toBe(false);
      expect(lastRun.calls.some((l) => l.startsWith('gh ["release","edit"'))).toBe(false);
      expect(lastRun.calls.some((l) => l.startsWith('gh ["release","upload"'))).toBe(false);
    });

    it("refuses to edit over a resumable stable-tag draft left by an interrupted evaluation publish", () => {
      // Editing the draft would keep it private while npm publishes, clobber only same-named
      // assets, and leave the evaluation manifest beside qualified uploads (Codex finding on
      // #3054). The evaluation lane owns resuming or deleting its draft.
      lastRun = runPublish({
        npmBody: npmStub(passthroughViewBody(), { failOnPublish: true }),
        initState: { existingReleaseIsDraft: true, published: false },
      });

      expect(lastRun.status).toBe(1);
      expect(lastRun.stderr).toContain("exists as a draft");
      expect(lastRun.calls.some((l) => l.startsWith('npm ["publish"'))).toBe(false);
      expect(lastRun.calls.some((l) => l.startsWith('gh ["release","edit"'))).toBe(false);
    });

    it("rejects an unattested setup companion before release upload or npm publication", () => {
      const viewBody =
        'if (argv.includes("version")) { process.stdout.write(VERSION + "\\n"); process.exit(0); }';
      lastRun = runPublish({
        npmBody: npmStub(viewBody, { failOnPublish: true }),
        initState: { failSetupAttestation: true, published: true, tagged: true },
      });

      expect(lastRun.status).toBe(1);
      expect(lastRun.stderr).toContain("setup provenance verification failed");
      expect(lastRun.calls.some((line) => line.startsWith('gh ["release","upload"'))).toBe(false);
      expect(lastRun.calls.some((line) => line.startsWith('npm ["publish"'))).toBe(false);
    });

    // A package replaced together with its manifest entry still matches that entry; only its
    // build provenance shows it was not built by the stable-tag workflow.
    it("rejects an unattested folder package before release upload or npm publication", () => {
      const viewBody =
        'if (argv.includes("version")) { process.stdout.write(VERSION + "\\n"); process.exit(0); }';
      lastRun = runPublish({
        npmBody: npmStub(viewBody, { failOnPublish: true }),
        initState: { failFolderAttestation: true, published: true, tagged: true },
      });

      expect(lastRun.status).toBe(1);
      expect(lastRun.stderr).toContain("folder package provenance verification failed");
      expect(lastRun.calls.some((line) => line.startsWith('gh ["release","upload"'))).toBe(false);
      expect(lastRun.calls.some((line) => line.startsWith('npm ["publish"'))).toBe(false);
    });

    it("rejects same-size remote tampering before npm publish or dist-tag mutation", () => {
      const viewBody = [
        'if (argv.includes("version")) { process.stderr.write("npm error code E404\\n"); process.exit(1); }',
        'if (argv.some((a) => a.startsWith("dist-tags."))) { process.stdout.write(VERSION + "\\n"); process.exit(0); }',
      ].join("\n");

      lastRun = runPublish({
        npmBody: npmStub(viewBody),
        initState: { published: false, tamperRemoteDownloads: true },
      });

      expect(lastRun.status).toBe(1);
      expect(lastRun.stderr).toContain("downloaded portable asset bytes do not match");
      expect(lastRun.calls.some((line) => line.startsWith('npm ["publish"'))).toBe(false);
      expect(lastRun.calls.some((line) => line.startsWith('npm ["dist-tag","add"'))).toBe(false);
    });

    it("rejects setup companion bytes that do not match the assembled bundle binding", () => {
      const viewBody =
        'if (argv.includes("version")) { process.stdout.write(VERSION + "\\n"); process.exit(0); }';
      lastRun = runPublish({
        npmBody: npmStub(viewBody, { failOnPublish: true }),
        initState: { published: true, tagged: true },
        portableFixtureOptions: {
          mutateBundle: (bundle) => {
            const windows = bundle.artifacts.find(
              (artifact) => artifact.platformTarget === "windows-x64",
            );
            windows.setupSha256 = "0".repeat(64);
          },
        },
      });

      expect(lastRun.status).toBe(1);
      expect(lastRun.stderr).toContain("windows-x64.setupSha256 must match the setup companion");
      expect(lastRun.calls.some((line) => line.startsWith('npm ["publish"'))).toBe(false);
    });

    it("rejects a setup companion size that does not match the assembled bundle binding", () => {
      const viewBody =
        'if (argv.includes("version")) { process.stdout.write(VERSION + "\\n"); process.exit(0); }';
      lastRun = runPublish({
        npmBody: npmStub(viewBody, { failOnPublish: true }),
        initState: { published: true, tagged: true },
        portableFixtureOptions: {
          mutateBundle: (bundle) => {
            const windows = bundle.artifacts.find(
              (artifact) => artifact.platformTarget === "windows-x64",
            );
            windows.setupSizeBytes += 1;
          },
        },
      });

      expect(lastRun.status).toBe(1);
      expect(lastRun.stderr).toContain("windows-x64.setupSizeBytes must match the setup companion");
      expect(lastRun.calls.some((line) => line.startsWith('npm ["publish"'))).toBe(false);
    });

    it("rejects a wrong remote GitHub asset name before npm publication", () => {
      const viewBody =
        'if (argv.includes("version")) { process.stdout.write(VERSION + "\\n"); process.exit(0); }';
      lastRun = runPublish({
        npmBody: npmStub(viewBody, { failOnPublish: true }),
        initState: { published: true, tagged: true, wrongRemoteAssetName: true },
      });

      expect(lastRun.status).toBe(1);
      expect(lastRun.stderr).toContain("exactly the four first-class ZIP assets");
      expect(lastRun.calls.some((line) => line.startsWith('npm ["publish"'))).toBe(false);
      expect(lastRun.calls.some((line) => line.startsWith('npm ["dist-tag","add"'))).toBe(false);
    });

    it("rejects symlinked portable evidence before upload or npm publish", () => {
      const viewBody = [
        '  if (argv.includes("version")) { process.stdout.write(VERSION + "\\n"); process.exit(0); }',
        '  if (argv.some((a) => a.startsWith("dist-tags."))) { process.stdout.write(VERSION + "\\n"); process.exit(0); }',
      ].join("\n");

      lastRun = runPublish({
        npmBody: npmStub(viewBody, { failOnPublish: true }),
        initState: { published: true, tagged: true },
        portableFixtureOptions: { symlinkEvidenceOutsideRoot: true },
      });

      expect(lastRun.status).toBe(1);
      expect(lastRun.stderr).toContain("must not be a symbolic link");
      expect(lastRun.calls.some((l) => l.startsWith('gh ["release","upload"'))).toBe(false);
      expect(lastRun.calls.some((l) => l.startsWith('npm ["publish"'))).toBe(false);
    });
  },
);
