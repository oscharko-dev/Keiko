// Regression gate for the publish/verify pipeline in scripts/release-publish.mjs
// (finding GEN-TEST-RELEASE-GATE-006). release-publish.mjs is THE production npm
// publish orchestrator invoked by .github/workflows/release.yml. Its publish path —
// the "already published?" E404 heuristic, the publish-then-tag ordering, and the
// post-publish dist-tag verification — is only reachable by shelling out to `npm`,
// `gh`, and `git`, and the module exports nothing. Prior coverage only exercised
// argument validation.
//
// This suite drives the REAL orchestrator as a subprocess (the same seam the existing
// release-impact governance test uses) but prepends a temp dir of stub `npm`/`gh`/`git`
// executables to PATH. Because release-publish.mjs spawns every external tool by name
// (commandResult("npm", ...), gh([...]), commandResult("git", ...)), the stubs intercept
// all of them. The stubs record every invocation to a log file and emit scripted
// stdout/exit codes, so we can assert on the DECISIONS the orchestrator makes and the
// ORDER of the calls — never on source text.
//
// The stubs also gate off the network entirely: `npm view/publish/dist-tag` never touch
// a registry, and the GitHub release-owner approval check (which normally runs
// `gh api repos/.../reviews/...`) is answered by the stub `gh`. The registry stays a
// bogus default and no real credentials are used. Nothing can be published anywhere.
//
// Scenarios exercised against the real code:
//   A. Fresh publish — `npm view <spec> version` returns E404 (unpublished) -> the
//      orchestrator PUBLISHes, then adds the dist-tag, then verifies. Red-on-defect:
//      if the E404 heuristic were broken (treating E404 as "already there"), publish
//      would be skipped and the recorded call sequence would lose the `npm publish`.
//   B. Already published — `npm view <spec> version` already returns the target version
//      -> the orchestrator SKIPs publish but still verifies the dist-tag. Red-on-defect:
//      a broken skip-path would re-invoke `npm publish` (the stub fails hard if it does).
//   C. Dist-tag mismatch — after publish, `npm view <name> dist-tags.<tag>` keeps
//      pointing at the wrong version -> verifyPackage MUST fail the release (exit 1).
//      Red-on-defect: if the dist-tag comparison were dropped, the release would
//      falsely report PASS.
//   D. No npm registry token configured (the OIDC trusted-publishing CI shape) — a fresh
//      publish must still succeed end-to-end on `npm publish` alone even through transient
//      registry quarantine and dist-tag read propagation lag (retried, not failed), and a
//      dist-tag repair genuinely needed on an idempotent re-run must fail with the real recovery
//      path rather than a bare npm 401.

import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { PORTABLE_EVALUATION_MANIFEST_ASSET_NAME } from "../lib/portable-evaluation-manifest.mjs";
import { codingRuntimeReleasesForPublishTest } from "./support/coding-runtime-releases-fixture.mjs";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  REPO_ROOT,
  RELEASE_VERSION,
  APPROVED_OPENCODE_VERSION,
  RELEASE_NAME,
  RELEASE_SPEC,
  RELEASE_PIPELINE_TEST_TIMEOUT_MS,
  passthroughViewBody,
  prepublishedEvaluationState,
  runPublish,
  npmStub,
  npmPackStubLines,
  isVersionView,
  isDistTagView,
  isVersionEndpointCurl,
  RELEASE_VERSION_IS_PRERELEASE,
  NO_REGISTRY_TOKEN_ENV,
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

    it("refuses a stable latest publish whose GitHub release carries no downloads", () => {
      // The requirement that a stable `latest` offers customer downloads did not move — WHERE it
      // is answered did. It used to demand a qualified asset MANIFEST as a publish input, which
      // only the Developer-ID/Azure-signed production lane can produce, so it refused every stable
      // release this project can currently build. It is now answered against the release itself,
      // which is strictly stronger: a well-formed manifest input proves nothing about whether the
      // upload actually landed. npm must never learn `latest` for a release with nothing behind it.
      const viewBody = [
        '  if (argv.includes("version")) { process.stdout.write(VERSION + "\\n"); process.exit(0); }',
        '  if (argv.some((a) => a.startsWith("dist-tags."))) { process.stdout.write("0.0.1\\n"); process.exit(0); }',
      ].join("\n");

      lastRun = runPublish({
        npmBody: npmStub(viewBody, { failOnPublish: true }),
        initState: { published: false, tagged: true },
        portableAssets: false,
      });

      expect(lastRun.status).toBe(1);
      expect(lastRun.stderr).toContain("is missing portable downloads");
      expect(lastRun.calls.some((l) => l.startsWith('npm ["publish"'))).toBe(false);
      // And it leaves nothing customer-visible behind. Creating the release before proving it
      // would publish an empty Latest release advertising downloads that are not there, and the
      // evaluation lane could then no longer create that tag — it refuses a non-draft release.
      expect(lastRun.calls.some((l) => l.startsWith('gh ["release","create"'))).toBe(false);
      expect(lastRun.calls.some((l) => l.startsWith('gh ["release","edit"'))).toBe(false);
    });

    it("refuses a release whose selected npm coding runtime carries an older OpenCode", () => {
      // #4271: dev approved OpenCode 2.2.5 while the root manifest still selected the 1.1.4
      // runtime packages, which carry 2.1.4. A release cut there would have installed the old
      // engine for every npm user without a word. The gate refuses before npm is asked anything.
      lastRun = runPublish({
        npmBody: npmStub(passthroughViewBody(), { failOnPublish: true }),
        initState: { published: false, tagged: true },
        codingRuntimeReleases: codingRuntimeReleasesForPublishTest("0.0.1"),
      });

      expect(lastRun.status).toBe(1);
      expect(lastRun.stderr).toContain(
        `carries OpenCode 0.0.1, but this release approves ${APPROVED_OPENCODE_VERSION}`,
      );
      expect(lastRun.calls.some((l) => l.startsWith("npm "))).toBe(false);
    });

    it("previews a stable latest plan without the workflow-only qualification environment", () => {
      // A local `release:plan` has no KEIKO_PORTABLE_ASSETS_* environment — that exists only
      // inside the release workflow. Demanding it here made a preview fail before rendering its
      // notes even with a valid manifest, which is not what a preview is for (Codex finding on
      // #3054). The structural manifest validation still runs.
      lastRun = runPublish({
        npmBody: npmStub(passthroughViewBody(), { failOnPublish: true }),
        initState: { published: true, tagged: true },
        extraArgs: ["--plan-only"],
        qualificationEnv: {
          KEIKO_PORTABLE_ASSETS_ARTIFACT_NAME: undefined,
          KEIKO_PORTABLE_ASSETS_REPOSITORY: undefined,
          KEIKO_PORTABLE_ASSETS_RUN_ATTEMPT: undefined,
          KEIKO_PORTABLE_ASSETS_RUN_ID: undefined,
          KEIKO_PORTABLE_ASSETS_SOURCE_SHA: undefined,
          KEIKO_PORTABLE_ASSETS_TAG: undefined,
          KEIKO_PORTABLE_ASSETS_WORKFLOW_PATH: undefined,
        },
      });

      expect(lastRun.status, lastRun.stderr).toBe(0);
      expect(lastRun.stdout, lastRun.stderr).toContain("PLAN-ONLY complete");
      expect(lastRun.calls.some((l) => l.startsWith('npm ["publish"'))).toBe(false);
    });

    it("refuses a stable latest release whose downloads lack Keiko release trust", () => {
      // The release-owner-scoped path for the first public release: the governed evaluation lane
      // publishes the four unsigned-but-sealed downloads onto the tag with the evidence that
      // binds them, and this run promotes the dist-tag without re-uploading anything. It must
      // actually SUCCEED — an orchestrator that silently skipped publication would satisfy a
      // weaker assertion while shipping nothing.
      // The version is NOT on the registry yet, so this run must genuinely publish it: an
      // orchestrator that skipped publication would otherwise satisfy every other assertion here
      // while shipping nothing.
      const viewBody = [
        "  const s = state();",
        '  if (argv.includes("version")) {',
        "    if (!s.published) { process.stderr.write('npm error code E404\\n'); process.exit(1); }",
        '    process.stdout.write(VERSION + "\\n"); process.exit(0);',
        "  }",
        '  if (argv.some((a) => a.startsWith("dist-tags."))) {',
        '    process.stdout.write((s.published ? VERSION : "0.0.1") + "\\n"); process.exit(0);',
        "  }",
      ].join("\n");

      lastRun = runPublish({
        npmBody: npmStub(viewBody),
        initState: { ...prepublishedEvaluationState(), published: false },
        portableAssets: false,
      });

      expect(lastRun.status).toBe(1);
      expect(lastRun.stderr).toContain("release-trust bundle");
      expect(lastRun.calls.some((l) => l.startsWith('gh ["release","upload"'))).toBe(false);
      // And it leaves the release surface alone. That release already carries the Latest flag and
      // the customer-facing install notes the evaluation lane wrote — first-launch steps,
      // checksums, provenance. Rewriting its body with the generated catalog notes would replace
      // exactly the guidance a non-technical customer needs. This run owns npm, not that release.
      expect(lastRun.calls.some((l) => l.startsWith('gh ["release","edit"'))).toBe(false);
      expect(lastRun.calls.some((l) => l.startsWith('gh ["release","create"'))).toBe(false);
      expect(lastRun.calls.some((l) => l.startsWith('npm ["publish"'))).toBe(false);
    });

    it("refuses prepublished downloads that carry no evaluation evidence", () => {
      // A name and a non-zero size authorize nothing: without the manifest that binds these bytes
      // to a tag, a commit and a successful workflow run, a stale or hand-uploaded file could
      // promote the npm latest tag (Codex and CodeRabbit findings on #3054).
      const state = prepublishedEvaluationState();
      state.uploadedAssets = state.uploadedAssets.filter(
        (asset) => asset.name !== PORTABLE_EVALUATION_MANIFEST_ASSET_NAME,
      );

      lastRun = runPublish({
        npmBody: npmStub(passthroughViewBody(), { failOnPublish: true }),
        initState: state,
        portableAssets: false,
      });

      expect(lastRun.status).toBe(1);
      expect(lastRun.stderr).toContain("release-trust bundle");
      expect(lastRun.calls.some((l) => l.startsWith('npm ["publish"'))).toBe(false);
    });

    it("refuses a prepublished release when another release owns the Latest badge", () => {
      // The npm latest dist-tag and GitHub's Latest release must name the same bytes; a stable
      // release that lost the badge to another release must not promote (Codex finding on #3054).
      lastRun = runPublish({
        npmBody: npmStub(passthroughViewBody(), { failOnPublish: true }),
        initState: { ...prepublishedEvaluationState(), latestBadgeElsewhere: true },
        portableAssets: false,
      });

      expect(lastRun.status).toBe(1);
      expect(lastRun.stderr).toContain("release-trust bundle");
      expect(lastRun.calls.some((l) => l.startsWith('npm ["publish"'))).toBe(false);
    });

    it("refuses a prepublished release that is still marked as a prerelease", () => {
      // The release-by-tag endpoint resolves prereleases with every asset in place, so without
      // this refusal a manually assembled prerelease-flagged release could promote npm latest
      // while GitHub never presents it as the stable Latest release (Codex finding on #3054).
      lastRun = runPublish({
        npmBody: npmStub(passthroughViewBody(), { failOnPublish: true }),
        initState: { ...prepublishedEvaluationState(), releasePrerelease: true },
        portableAssets: false,
      });

      expect(lastRun.status).toBe(1);
      expect(lastRun.stderr).toContain("release-trust bundle");
      expect(lastRun.calls.some((l) => l.startsWith('npm ["publish"'))).toBe(false);
    });

    it("refuses prepublished downloads whose bytes do not match their evidence", () => {
      // The evidence is only a claim until the bytes agree with it. Every download is re-fetched
      // over the same unauthenticated URL a customer uses; one tampered byte must stop the
      // promotion.
      lastRun = runPublish({
        npmBody: npmStub(passthroughViewBody(), { failOnPublish: true }),
        initState: { ...prepublishedEvaluationState(), tamperRemoteDownloads: true },
        portableAssets: false,
      });

      expect(lastRun.status).toBe(1);
      expect(lastRun.stderr).toContain("release-trust bundle");
      expect(lastRun.calls.some((l) => l.startsWith('npm ["publish"'))).toBe(false);
    });

    it("does not accept nested legacy run artifacts as release trust", () => {
      // `gh run download` places files directly in the target or one level deeper depending on how
      // the artifact was uploaded. Reading only the top level would refuse a perfectly good
      // release — the producer resolves them the same way.
      lastRun = runPublish({
        npmBody: npmStub(passthroughViewBody(), { failOnPublish: true }),
        initState: { ...prepublishedEvaluationState(), nestRunArtifacts: true },
        portableAssets: false,
      });

      expect(lastRun.status).toBe(1);
      expect(lastRun.stderr).toContain("release-trust bundle");
    });

    it("refuses prepublished downloads that are not the bytes their workflow run produced", () => {
      // The whole point of the run binding: replacing the downloads AND the manifest that
      // describes them is ONE action for anyone who can write release assets, so the evidence
      // sitting next to the assets can never be its own provenance. Workflow-run artifacts are not
      // writable after the run, so that is where the digests come from.
      lastRun = runPublish({
        npmBody: npmStub(passthroughViewBody(), { failOnPublish: true }),
        initState: { ...prepublishedEvaluationState(), tamperRunArtifacts: true },
        portableAssets: false,
      });

      expect(lastRun.status).toBe(1);
      expect(lastRun.stderr).toContain("release-trust bundle");
      expect(lastRun.calls.some((l) => l.startsWith('npm ["publish"'))).toBe(false);
    });

    it("refuses prepublished downloads when the producing run's artifacts cannot be read", () => {
      lastRun = runPublish({
        npmBody: npmStub(passthroughViewBody(), { failOnPublish: true }),
        initState: { ...prepublishedEvaluationState(), runArtifactsUnavailable: true },
        portableAssets: false,
      });

      expect(lastRun.status).toBe(1);
      expect(lastRun.stderr).toContain("release-trust bundle");
      expect(lastRun.calls.some((l) => l.startsWith('npm ["publish"'))).toBe(false);
    });

    it("refuses prepublished downloads whose evidence names an unsuccessful workflow run", () => {
      // Provenance that does not resolve to a successful run of the canonical workflow at the
      // declared commit is not provenance.
      const state = prepublishedEvaluationState();
      state.workflowRun = { ...state.workflowRun, conclusion: "failure" };

      lastRun = runPublish({
        npmBody: npmStub(passthroughViewBody(), { failOnPublish: true }),
        initState: state,
        portableAssets: false,
      });

      expect(lastRun.status).toBe(1);
      expect(lastRun.stderr).toContain("release-trust bundle");
      expect(lastRun.calls.some((l) => l.startsWith('npm ["publish"'))).toBe(false);
    });

    it("refuses to skip the GitHub Release when portable assets are supplied", () => {
      // Announcing downloads that are never uploaded is the failure this replaces: supplying a
      // manifest and skipping the release would publish an npm dist-tag whose notes point at
      // assets that do not exist.
      lastRun = runPublish({
        npmBody: npmStub(passthroughViewBody(), { failOnPublish: true }),
        initState: { published: true, tagged: true },
        portableAssets: true,
        extraArgs: ["--skip-github-release"],
      });

      expect(lastRun.status).toBe(1);
      expect(lastRun.stderr).toContain(
        "a publish that supplies portable assets must attach them to the GitHub Release.",
      );
      expect(lastRun.calls.some((l) => l.startsWith('npm ["publish"'))).toBe(false);
    });

    it.each([
      "KEIKO_PORTABLE_ASSETS_SOURCE_SHA",
      "KEIKO_PORTABLE_ASSETS_TAG",
      "KEIKO_PORTABLE_ASSETS_RUN_ID",
      "KEIKO_PORTABLE_ASSETS_RUN_ATTEMPT",
      "KEIKO_PORTABLE_ASSETS_ARTIFACT_NAME",
      "KEIKO_PORTABLE_ASSETS_REPOSITORY",
      "KEIKO_PORTABLE_ASSETS_WORKFLOW_PATH",
    ])("rejects missing qualified-run provenance %s before publication", (field) => {
      const viewBody = [
        'if (argv.includes("version")) { process.stdout.write(VERSION + "\\n"); process.exit(0); }',
        'if (argv.some((a) => a.startsWith("dist-tags."))) { process.stdout.write(VERSION + "\\n"); process.exit(0); }',
      ].join("\n");
      lastRun = runPublish({
        npmBody: npmStub(viewBody, { failOnPublish: true }),
        initState: { published: true, tagged: true },
        qualificationEnv: { [field]: undefined },
      });

      expect(lastRun.status).toBe(1);
      expect(lastRun.stderr).toContain("qualified portable run provenance is invalid");
      expect(lastRun.calls.some((line) => line.startsWith('gh ["release","upload"'))).toBe(false);
      expect(lastRun.calls.some((line) => line.startsWith('npm ["publish"'))).toBe(false);
      expect(lastRun.calls.some((line) => line.startsWith('npm ["dist-tag","add"'))).toBe(false);
    });

    it("rejects an inner target relabelled against its outer bundle entry", () => {
      const viewBody = passthroughViewBody();
      lastRun = runPublish({
        npmBody: npmStub(viewBody, { failOnPublish: true }),
        initState: { published: true, tagged: true },
        portableFixtureOptions: {
          mutateManifest: (candidate, target) => {
            if (target.platformTarget === "linux-x64") {
              candidate.artifact.platformTarget = "windows-x64";
            }
          },
        },
      });

      expect(lastRun.status).toBe(1);
      expect(lastRun.stderr).toContain("must match the outer bundle target");
      expect(lastRun.calls.some((line) => line.startsWith('gh ["release","upload"'))).toBe(false);
      expect(lastRun.calls.some((line) => line.startsWith('npm ["publish"'))).toBe(false);
    });

    it.each(["size-mismatch", "malformed-zip"])(
      "refuses %s expanded metadata before publication",
      (kind) => {
        lastRun = runPublish({
          npmBody: npmStub(passthroughViewBody(), { failOnPublish: true }),
          initState: { published: true, tagged: true },
          portableFixtureOptions: {
            mutateManifest: (candidate, target, index, root) => {
              if (index !== 0) return;
              if (kind === "size-mismatch") ++candidate.artifact.uncompressedSizeBytes;
              else writeFileSync(join(root, target.assetName), "invalid ZIP");
            },
          },
        });
        expect(lastRun.status).toBe(1);
        expect(lastRun.stderr).toContain(
          kind === "size-mismatch"
            ? "uncompressedSizeBytes must match"
            : "expanded size could not be verified",
        );
        expect(lastRun.calls.some((line) => line.startsWith('gh ["release","upload"'))).toBe(false);
        expect(lastRun.calls.some((line) => line.startsWith('npm ["publish"'))).toBe(false);
      },
    );

    // portableAssetsFromManifest/normalizePortableAssets (release-publish.mjs) is the
    // publish-time twin of validatePortableReleaseSet: the last check before npm publish,
    // dist-tag mutation, or GitHub release promotion. Each case below shrinks/grows/
    // duplicates `bundle.artifacts` while keeping every remaining entry well-formed, so the
    // only thing that can make the run fail is the specific count/duplicate/missing guard
    // under test — never a same-shape neighbor.
    it("rejects a portable assets manifest missing a target before npm publish or dist-tag mutation", () => {
      const viewBody = passthroughViewBody();
      lastRun = runPublish({
        npmBody: npmStub(viewBody, { failOnPublish: true }),
        initState: { published: true, tagged: true },
        portableFixtureOptions: {
          // Drop the final (macos-x64) target: only three of the four required artifacts remain.
          mutateBundle: (bundle) => {
            bundle.artifacts = bundle.artifacts.slice(0, -1);
          },
        },
      });

      expect(lastRun.status).toBe(1);
      expect(lastRun.stderr).toContain(
        "portable assets manifest must list exactly four artifacts.",
      );
      expect(lastRun.stderr).toContain("missing portable asset entry for macos-x64.");
      expect(lastRun.calls.some((line) => line.startsWith('gh ["release","upload"'))).toBe(false);
      expect(lastRun.calls.some((line) => line.startsWith('npm ["publish"'))).toBe(false);
      expect(lastRun.calls.some((line) => line.startsWith('npm ["dist-tag","add"'))).toBe(false);
    });

    it("rejects a portable assets manifest with an extra target before npm publish or dist-tag mutation", () => {
      const viewBody =
        'if (argv.includes("version")) { process.stdout.write(VERSION + "\\n"); process.exit(0); }';
      lastRun = runPublish({
        npmBody: npmStub(viewBody, { failOnPublish: true }),
        initState: { published: true, tagged: true },
        portableFixtureOptions: {
          // Append a fifth artifact: the four real targets remain untouched and well-formed.
          mutateBundle: (bundle) => {
            bundle.artifacts.push({ platformTarget: "freebsd-x64" });
          },
        },
      });

      expect(lastRun.status).toBe(1);
      expect(lastRun.stderr).toContain(
        "portable assets manifest must list exactly four artifacts.",
      );
      expect(lastRun.calls.some((line) => line.startsWith('gh ["release","upload"'))).toBe(false);
      expect(lastRun.calls.some((line) => line.startsWith('npm ["publish"'))).toBe(false);
      expect(lastRun.calls.some((line) => line.startsWith('npm ["dist-tag","add"'))).toBe(false);
    });

    it("rejects a portable assets manifest with a duplicate platformTarget before npm publish or dist-tag mutation", () => {
      const viewBody =
        'if (argv.includes("version")) { process.stdout.write(VERSION + "\\n"); process.exit(0); }';
      lastRun = runPublish({
        npmBody: npmStub(viewBody, { failOnPublish: true }),
        initState: { published: true, tagged: true },
        portableFixtureOptions: {
          // Replace the macos-arm64 entry with a second copy of windows-x64: the artifact
          // count stays at four, so only the duplicate-target guard can catch this.
          mutateBundle: (bundle) => {
            const windows = bundle.artifacts.find(
              (artifact) => artifact.platformTarget === "windows-x64",
            );
            const macosArm64 = bundle.artifacts.findIndex(
              (artifact) => artifact.platformTarget === "macos-arm64",
            );
            bundle.artifacts[macosArm64] = { ...windows };
          },
        },
      });

      expect(lastRun.status).toBe(1);
      expect(lastRun.stderr).toContain("duplicate portable platformTarget windows-x64.");
      expect(lastRun.calls.some((line) => line.startsWith('gh ["release","upload"'))).toBe(false);
      expect(lastRun.calls.some((line) => line.startsWith('npm ["publish"'))).toBe(false);
      expect(lastRun.calls.some((line) => line.startsWith('npm ["dist-tag","add"'))).toBe(false);
    });

    it.each([
      ["SBOM", "evidence/sbom.cdx.json", '{"bomFormat":"CycloneDX","tokenValue":"secret"}\n'],
      [
        "SBOM password",
        "evidence/sbom.cdx.json",
        '{"bomFormat":"CycloneDX","password":"correct-horse-battery-staple"}\n',
      ],
      [
        "SBOM token",
        "evidence/sbom.cdx.json",
        '{"bomFormat":"CycloneDX","token":"sensitive-but-not-prefix-shaped"}\n',
      ],
      [
        "SBOM authorization",
        "evidence/sbom.cdx.json",
        '{"bomFormat":"CycloneDX","Authorization":"Bearer sensitive-value"}\n',
      ],
      [
        "SBOM compound token",
        "evidence/sbom.cdx.json",
        '{"bomFormat":"CycloneDX","api_token":"opaque"}\n',
      ],
      [
        "SBOM semantic credential property",
        "evidence/sbom.cdx.json",
        '{"bomFormat":"CycloneDX","properties":[{"name":"api_token","value":"opaque"}]}\n',
      ],
      [
        "SBOM inline authorization",
        "evidence/sbom.cdx.json",
        '{"bomFormat":"CycloneDX","description":"request header Authorization: Bearer opaque"}\n',
      ],
      ["SBOM terminal credential", "evidence/sbom.cdx.json", '{"apitoken":"opaque"}\n'],
      [
        "SBOM GitHub PAT",
        "evidence/sbom.cdx.json",
        `{"component":"github_pat_${"x".repeat(82)}"}\n`,
      ],
      ["license", "evidence/third-party-notices.txt", "https://user:pass@example.com/private\n"],
      ["signing", "evidence/signing-verification.json", '{"rawOutput":"secret"}\n'],
      ["provenance", "evidence/provenance.intoto.jsonl", '{"privatePath":"/Users/customer"}\n'],
      ["checksum", "evidence/SHA256SUMS.txt", "token=forbidden-secret\n"],
      ["malformed SBOM", "evidence/sbom.cdx.json", '{"bomFormat":'],
    ])("rejects unsafe or malformed %s evidence before publication", (_class, path, content) => {
      const viewBody =
        'if (argv.includes("version")) { process.stdout.write(VERSION + "\\n"); process.exit(0); }';
      lastRun = runPublish({
        npmBody: npmStub(viewBody, { failOnPublish: true }),
        initState: { published: true, tagged: true },
        portableFixtureOptions: {
          mutateEvidence: (root, _manifest, _target, index) => {
            if (index === 0) writeFileSync(join(root, path), content);
          },
        },
      });

      expect(lastRun.status).toBe(1);
      expect(lastRun.calls.some((line) => line.startsWith('gh ["release","upload"'))).toBe(false);
      expect(lastRun.calls.some((line) => line.startsWith('npm ["publish"'))).toBe(false);
      expect(lastRun.calls.some((line) => line.startsWith('npm ["dist-tag","add"'))).toBe(false);
    });

    it.each([
      '{"password":"correct-horse-battery-staple"}\n',
      '{"Authorization":"Basic c2Vuc2l0aXZlOnZhbHVl"}\n',
      '{"authToken":"opaque"}\n',
      '{"refresh_token":"opaque"}\n',
      '{"authtoken":"opaque"}\n',
      `{"package":"npm_${"a".repeat(36)}"}\n`,
      '{"description":"mirror https://user:password@example.invalid/npm/"}\n',
    ])("rejects credential-bearing optional evidence before publication", (content) => {
      const viewBody =
        'if (argv.includes("version")) { process.stdout.write(VERSION + "\\n"); process.exit(0); }';
      lastRun = runPublish({
        npmBody: npmStub(viewBody, { failOnPublish: true }),
        initState: { published: true, tagged: true },
        portableFixtureOptions: {
          mutateBundle: (bundle) => {
            bundle.artifacts[0].evidencePaths = ["evidence/optional.json"];
          },
          mutateEvidence: (root, _manifest, _target, index) => {
            if (index === 0) writeFileSync(join(root, "evidence", "optional.json"), content);
          },
        },
      });

      expect(lastRun.status).toBe(1);
      expect(lastRun.stderr).toContain("is not redacted");
      expect(lastRun.calls.some((line) => line.startsWith('gh ["release","upload"'))).toBe(false);
      expect(lastRun.calls.some((line) => line.startsWith('npm ["publish"'))).toBe(false);
      expect(lastRun.calls.some((line) => line.startsWith('npm ["dist-tag","add"'))).toBe(false);
    });

    it.each(["license", "sbom"])(
      "rejects unsafe sidecar %s evidence before publication",
      (sidecarEvidenceKind) => {
        const viewBody =
          'if (argv.includes("version")) { process.stdout.write(VERSION + "\\n"); process.exit(0); }';
        lastRun = runPublish({
          npmBody: npmStub(viewBody, { failOnPublish: true }),
          initState: { published: true, tagged: true },
          portableFixtureOptions: { sidecarEvidenceKind },
        });

        expect(lastRun.status).toBe(1);
        expect(lastRun.stderr).toContain("sidecar evidence is not redacted");
        expect(lastRun.calls.some((line) => line.startsWith('gh ["release","upload"'))).toBe(false);
        expect(lastRun.calls.some((line) => line.startsWith('npm ["publish"'))).toBe(false);
        expect(lastRun.calls.some((line) => line.startsWith('npm ["dist-tag","add"'))).toBe(false);
      },
    );

    it.each([
      "Authorization: Bearer sensitive-value\n",
      "request header Proxy-Authorization: Basic c2Vuc2l0aXZlOnZhbHVl\n",
      '{"proxy-authorization":"opaque"}\n',
      '{"client-password":"opaque"}\n',
      `npm_${"a".repeat(36)}\n`,
    ])("rejects credential-bearing sidecar evidence before publication", (content) => {
      const viewBody =
        'if (argv.includes("version")) { process.stdout.write(VERSION + "\\n"); process.exit(0); }';
      lastRun = runPublish({
        npmBody: npmStub(viewBody, { failOnPublish: true }),
        initState: { published: true, tagged: true },
        portableFixtureOptions: {
          sidecarEvidenceKind: "safe",
          mutateEvidence: (root, _manifest, _target, index) => {
            if (index === 0) {
              writeFileSync(
                join(
                  root,
                  "payload",
                  "Keiko",
                  "runtime",
                  "sidecars",
                  "opencode-compatible",
                  "LICENSE.txt",
                ),
                content,
              );
            }
          },
        },
      });

      expect(lastRun.status).toBe(1);
      expect(lastRun.stderr).toContain("sidecar evidence is not redacted");
      expect(lastRun.calls.some((line) => line.startsWith('gh ["release","upload"'))).toBe(false);
      expect(lastRun.calls.some((line) => line.startsWith('npm ["publish"'))).toBe(false);
      expect(lastRun.calls.some((line) => line.startsWith('npm ["dist-tag","add"'))).toBe(false);
    });

    it("skips publishing when `npm view … version` already reports the target version, yet still verifies the dist-tag", () => {
      // Version is already present and the dist-tag already points at it. A correct
      // orchestrator must NOT publish again; the stub publish path fails hard if it does.
      const viewBody = [
        '  if (argv.includes("version")) { process.stdout.write(VERSION + "\\n"); process.exit(0); }',
        '  if (argv.some((a) => a.startsWith("dist-tags."))) { process.stdout.write(VERSION + "\\n"); process.exit(0); }',
      ].join("\n");

      lastRun = runPublish({
        npmBody: npmStub(viewBody, { failOnPublish: true }),
        initState: { published: true, tagged: true },
      });

      expect(lastRun.status).toBe(0);
      expect(lastRun.stdout).toContain(`SKIP ${RELEASE_SPEC} already exists`);
      expect(lastRun.stdout).toContain(`PASS - ${RELEASE_SPEC} published as latest`);

      // Proof the skip actually held: `npm publish` was never invoked.
      expect(lastRun.calls.some((l) => l.startsWith('npm ["publish"'))).toBe(false);

      // Verification still runs: the dist-tag is re-read even on the skip path.
      expect(lastRun.calls.some(isDistTagView)).toBe(true);
    });

    // The three scenarios below prove the release-alignment wiring in release-publish.mjs
    // itself (issue #3252): that a real `--tag latest` run actually calls
    // recordNpmPublishDeployment / checkReleaseAlignment, and that a "failed"/"not aligned"
    // result actually reaches `fail()`. Every other scenario in this suite sets
    // KEIKO_RELEASE_SKIP_ALIGNMENT_PROOF=1 (see runPublish's env) precisely so that its own
    // unrelated fixture does not have to answer the deployment/alignment endpoints too — these
    // three remove that flag and are the only place the call site itself is exercised end to end.
    // The library functions' own branches are covered directly and hermetically by
    // npm-publish-deployment.test.mjs and check-release-alignment.test.mjs; this only has to
    // prove the wiring between them and release-publish.mjs was not dropped or inverted.
    const alignmentViewBody = [
      '  if (argv.includes("version")) { process.stdout.write(VERSION + "\\n"); process.exit(0); }',
      '  if (argv.includes("dist-tags") && argv.includes("--json")) { process.stdout.write(JSON.stringify({ latest: VERSION }) + "\\n"); process.exit(0); }',
      '  if (argv.some((a) => a.startsWith("dist-tags."))) { process.stdout.write(VERSION + "\\n"); process.exit(0); }',
    ].join("\n");

    it("records the npm-publish deployment and passes the alignment gate on a real latest publish", () => {
      lastRun = runPublish({
        npmBody: npmStub(alignmentViewBody, { failOnPublish: true }),
        initState: { published: true, tagged: true },
        qualificationEnv: { KEIKO_RELEASE_SKIP_ALIGNMENT_PROOF: undefined },
      });

      expect(lastRun.status, lastRun.stderr).toBe(0);
      expect(lastRun.stdout).toContain(`PASS - ${RELEASE_SPEC} published as latest`);
      expect(lastRun.stdout).toContain("npm-publish-deployment: recorded");
      expect(lastRun.stdout).toContain("release-alignment: PASS");
      expect(
        lastRun.calls.some((l) =>
          l.startsWith(
            'gh ["api","--method","POST","repos/oscharko-dev/Keiko/deployments","--input","-"]',
          ),
        ),
      ).toBe(true);
      expect(
        lastRun.calls.some(
          (l) => l.startsWith('gh ["api","--method","POST"') && l.includes("/statuses"),
        ),
      ).toBe(true);
    });

    it("publishes but fails the release when the deployment record is refused", () => {
      // Proves the `if (deploymentResult.kind === "failed") fail(...)` wiring: the publish must
      // still be reported as failed even though npm and the GitHub release already succeeded —
      // dropping this line would leave a real publish looking green with no deployment recorded.
      lastRun = runPublish({
        npmBody: npmStub(alignmentViewBody, { failOnPublish: true }),
        initState: { published: true, tagged: true, failDeploymentCreate: true },
        qualificationEnv: { KEIKO_RELEASE_SKIP_ALIGNMENT_PROOF: undefined },
      });

      expect(lastRun.status).toBe(1);
      expect(lastRun.stderr).toContain("the GitHub deployment record was refused");
      expect(lastRun.stderr).toContain("deployments:write");
      // The publish itself was not rolled back or retried — this is a post-publish gate: the
      // package was already confirmed present and correctly tagged before the deployment call.
      expect(lastRun.stdout).toContain(`SKIP ${RELEASE_SPEC} already exists`);
      expect(lastRun.stdout).toContain(`TAG ${RELEASE_NAME}@latest -> ${RELEASE_VERSION}`);
      expect(lastRun.stdout).not.toContain(`PASS - ${RELEASE_SPEC} published as latest`);
    });

    it("publishes but fails the release when the alignment gate finds a real divergence", () => {
      // Proves the `if (!alignment.aligned) fail(...)` wiring using the real 0.3.12-0.3.15
      // incident shape: the GitHub Release still names a stale tag even though npm, the tag
      // list, and the deployment record all agree. Dropping this line is exactly how that
      // incident went unnoticed.
      lastRun = runPublish({
        npmBody: npmStub(alignmentViewBody, { failOnPublish: true }),
        initState: { published: true, tagged: true, alignmentGithubLatestTag: "v0.0.1" },
        qualificationEnv: { KEIKO_RELEASE_SKIP_ALIGNMENT_PROOF: undefined },
      });

      expect(lastRun.status).toBe(1);
      expect(lastRun.stderr).toContain("release-alignment: FAIL");
      expect(lastRun.stderr).toContain(
        "release published, but the alignment gate found a divergence",
      );
      expect(lastRun.stderr).toContain(
        `GitHub Latest release is v0.0.1, expected v${RELEASE_VERSION}`,
      );
      expect(lastRun.stdout).not.toContain(`PASS - ${RELEASE_SPEC} published as latest`);
      // The deployment record itself was NOT refused — only the alignment gate found the
      // divergence, so the deployment write still succeeded.
      expect(lastRun.stdout).toContain("npm-publish-deployment: recorded");
    });

    it("retries post-publish registry visibility before failing the release", () => {
      // Real npm can accept the publish and dist-tag update before every registry view
      // endpoint sees the new version. The release must wait for propagation instead of
      // turning a successful publish into a red workflow.
      const viewBody = [
        "  const s = state();",
        '  if (argv.includes("version")) {',
        "    if (!s.published) { process.stderr.write('npm error code E404\\n'); process.exit(1); }",
        "    const attempts = s.versionVerifyAttempts ?? 0;",
        "    if (attempts === 0) {",
        "      setState({ versionVerifyAttempts: attempts + 1 });",
        "      process.stderr.write('npm error code E404\\n');",
        "      process.exit(1);",
        "    }",
        '    process.stdout.write(VERSION + "\\n");',
        "    process.exit(0);",
        "  }",
        '  if (argv.some((a) => a.startsWith("dist-tags."))) {',
        '    process.stdout.write(VERSION + "\\n");',
        "    process.exit(0);",
        "  }",
      ].join("\n");

      lastRun = runPublish({
        npmBody: npmStub(viewBody),
        initState: { published: false, versionVisibleAfterAttempts: 1 },
      });

      expect(lastRun.status).toBe(0);
      expect(lastRun.stdout).toContain(`PUBLISH ${RELEASE_SPEC}`);
      expect(lastRun.stdout).toContain(`VERIFY pending ${RELEASE_SPEC}`);
      expect(lastRun.stdout).toContain(`PASS - ${RELEASE_SPEC} published as latest`);
      expect(lastRun.calls.filter(isVersionEndpointCurl).length).toBeGreaterThanOrEqual(3);
    });

    it("retries transient registry responses inside the post-publish verification budget", () => {
      lastRun = runPublish({
        npmBody: npmStub(passthroughViewBody()),
        initState: {
          published: false,
          tagged: true,
          versionEndpointResponses: [
            { httpStatus: 404 },
            { httpStatus: 503 },
            { exitCode: 28 },
            { httpStatus: 200 },
          ],
        },
        qualificationEnv: {
          ...NO_REGISTRY_TOKEN_ENV,
          KEIKO_RELEASE_VERIFY_ATTEMPTS: "4",
        },
      });

      expect(lastRun.status).toBe(0);
      expect(lastRun.stdout).toContain("VERIFY pending");
      expect(lastRun.stdout).toContain("http-503");
      expect(lastRun.stdout).toContain("curl-exit-28");
      expect(lastRun.stdout).toContain(`PASS - ${RELEASE_SPEC} published as latest`);
      expect(lastRun.calls.filter(isVersionEndpointCurl)).toHaveLength(4);
    });

    it("refuses to publish when the pre-publish existence probe remains transient", () => {
      lastRun = runPublish({
        npmBody: npmStub(passthroughViewBody(), { failOnPublish: true }),
        initState: {
          published: false,
          tagged: false,
          versionEndpointResponses: [{ httpStatus: 503 }],
        },
      });

      expect(lastRun.status).toBe(1);
      expect(lastRun.stderr).toContain("registry availability remained transient");
      expect(lastRun.stderr).toContain("package existence could not be established safely");
      expect(lastRun.calls.filter(isVersionEndpointCurl)).toHaveLength(3);
      expect(lastRun.calls.some((line) => line.startsWith('npm ["publish"'))).toBe(false);
    });

    it("publishes only after transient pre-publish probes resolve to a definitive 404", () => {
      lastRun = runPublish({
        npmBody: npmStub(passthroughViewBody()),
        initState: {
          published: false,
          tagged: true,
          versionEndpointResponses: [
            { httpStatus: 503 },
            { exitCode: 28 },
            { httpStatus: 404 },
            { httpStatus: 200 },
          ],
        },
      });

      expect(lastRun.status).toBe(0);
      expect(lastRun.stdout).toContain("PREPUBLISH pending");
      expect(lastRun.stdout).toContain(`PUBLISH ${RELEASE_SPEC}`);
      expect(lastRun.stdout).toContain(`PASS - ${RELEASE_SPEC} published as latest`);
      expect(lastRun.calls.filter(isVersionEndpointCurl)).toHaveLength(4);
      expect(lastRun.calls.filter((line) => line.startsWith('npm ["publish"'))).toHaveLength(1);
    });

    it("fails only after the full budget when post-publish registry reads stay transient", () => {
      lastRun = runPublish({
        npmBody: npmStub(passthroughViewBody()),
        initState: {
          published: false,
          tagged: true,
          versionEndpointResponses: [{ httpStatus: 404 }, { httpStatus: 429 }],
        },
        qualificationEnv: NO_REGISTRY_TOKEN_ENV,
      });

      expect(lastRun.status).toBe(1);
      expect(lastRun.stderr).toContain("bounded verification budget");
      expect(lastRun.stderr).toContain("do not publish again or change deployment state");
      expect(lastRun.calls.filter(isVersionEndpointCurl)).toHaveLength(4);
    });

    it("fails the release when the dist-tag never resolves to the published version", () => {
      // Version publishes fine, but `npm view <name> dist-tags.latest` keeps pointing at a
      // different version — verifyPackage() must reject this and exit non-zero.
      const viewBody = [
        "  const s = state();",
        '  if (argv.includes("version")) {',
        '    if (!s.published) { process.stderr.write("npm error code E404\\n"); process.exit(1); }',
        '    process.stdout.write(VERSION + "\\n");',
        "    process.exit(0);",
        "  }",
        // Deliberately wrong dist-tag forever, even after `dist-tag add`.
        '  if (argv.some((a) => a.startsWith("dist-tags."))) { process.stdout.write("9.9.9-wrong\\n"); process.exit(0); }',
      ].join("\n");

      lastRun = runPublish({ npmBody: npmStub(viewBody), initState: { published: false } });

      expect(lastRun.status).toBe(1);
      expect(lastRun.stderr).toContain(`${RELEASE_NAME}@latest points to 9.9.9-wrong`);
      expect(lastRun.stderr).toContain(`expected ${RELEASE_VERSION}`);
      // It must not have reported success.
      expect(lastRun.stdout).not.toContain("PASS -");
    });

    it("treats a lone OIDC request URL as no auth path", () => {
      // The identity exchange needs BOTH GitHub-issued values; a URL without its bearer cannot
      // mint a token, and counting it as auth would fail twenty minutes later at npm publish.
      lastRun = runPublish({
        npmBody: npmStub(passthroughViewBody(), { failOnPublish: true }),
        initState: { published: false },
        portableAssets: false,
        qualificationEnv: {
          NODE_AUTH_TOKEN: undefined,
          NPM_TOKEN: "",
          ACTIONS_ID_TOKEN_REQUEST_URL: "https://actions.example/token-request",
          ACTIONS_ID_TOKEN_REQUEST_TOKEN: undefined,
        },
      });

      expect(lastRun.status).toBe(1);
      expect(lastRun.stderr).toContain("no npm auth path is available");
      expect(lastRun.calls.some((l) => l.startsWith('npm ["publish"'))).toBe(false);
    });

    it("refuses before any gate work when neither a token nor an OIDC endpoint exists", () => {
      // The 0.3.1 operator runs discovered missing auth only after the twenty-minute gate chain;
      // the preflight answers the question first.
      lastRun = runPublish({
        npmBody: npmStub(passthroughViewBody(), { failOnPublish: true }),
        initState: { published: false },
        portableAssets: false,
        qualificationEnv: {
          NODE_AUTH_TOKEN: undefined,
          NPM_TOKEN: "",
          ACTIONS_ID_TOKEN_REQUEST_URL: undefined,
          ACTIONS_ID_TOKEN_REQUEST_TOKEN: undefined,
        },
      });

      expect(lastRun.status).toBe(1);
      expect(lastRun.stderr).toContain("no npm auth path is available");
      expect(lastRun.calls.some((l) => l.startsWith('npm ["run","prepack"'))).toBe(false);
      expect(lastRun.calls.some((l) => l.startsWith('npm ["publish"'))).toBe(false);
    });

    it("publishes with no npm registry token configured, matching OIDC trusted publishing in CI", () => {
      // Unlike the shared npmStub() factory, model `publish` as ALSO fixing the dist-tag —
      // that is what real `npm publish --tag <tag>` does atomically on first publish. This
      // proves the actual CI shape: a fresh publish with zero registry credentials never
      // needs a separate `npm dist-tag add`, because trusted publishing authenticates
      // `npm publish` via OIDC and the tag is already correct once that call returns.
      const npmBody = [
        'log("npm");',
        "const sub = argv[0];",
        'if (sub === "config" && argv[1] === "get" && argv[2] === "strict-ssl") { process.stdout.write("true\\n"); process.exit(0); }',
        'if (sub === "run") { process.exit(0); }',
        ...npmPackStubLines(),
        'if (sub === "view") {',
        "  const s = state();",
        '  if (argv.includes("version")) {',
        "    if (!s.published) { process.stderr.write('npm error code E404\\n'); process.exit(1); }",
        '    process.stdout.write(VERSION + "\\n");',
        "    process.exit(0);",
        "  }",
        '  if (argv.some((a) => a.startsWith("dist-tags."))) {',
        '    process.stdout.write((s.tagged ? VERSION : "0.0.0-stale") + "\\n");',
        "    process.exit(0);",
        "  }",
        "}",
        'if (sub === "publish") { setState({ published: true, tagged: true }); process.exit(0); }',
        'process.stderr.write("stub npm: unhandled " + JSON.stringify(argv) + "\\n");',
        "process.exit(3);",
      ].join("\n");

      lastRun = runPublish({
        npmBody,
        initState: { published: false },
        qualificationEnv: NO_REGISTRY_TOKEN_ENV,
      });

      expect(lastRun.status).toBe(0);
      expect(lastRun.stdout).toContain(`PUBLISH ${RELEASE_SPEC}`);
      expect(lastRun.stdout).toContain(`PASS - ${RELEASE_SPEC} published as latest`);
      const publishLine = lastRun.calls.find((l) => l.startsWith('npm ["publish"'));
      expect(publishLine).toBeDefined();
      // Where the OIDC endpoint exists, the publish attests provenance — and only there.
      expect(publishLine).toContain('"--provenance"');
      // The whole point of this scenario: no dist-tag WRITE was needed or attempted.
      expect(lastRun.calls.some((l) => l.startsWith('npm ["dist-tag","add"'))).toBe(false);
    });

    it("retries a transiently stale dist-tag read before failing when no token is configured, so registry propagation lag does not fail an otherwise-successful publish", () => {
      // Same CDN/read-replica propagation lag verifyPackage() already retries for below,
      // but exercised on ensurePackageDistTag()'s tokenless path: `npm view dist-tags.<tag>`
      // reports stale for the first two reads after a fresh, fully successful publish, then
      // resolves. This must NOT fail() — a transient lag is not a real dist-tag problem and
      // must not tell the operator to supply a token for nothing.
      const npmBody = [
        'log("npm");',
        "const sub = argv[0];",
        'if (sub === "config" && argv[1] === "get" && argv[2] === "strict-ssl") { process.stdout.write("true\\n"); process.exit(0); }',
        'if (sub === "run") { process.exit(0); }',
        ...npmPackStubLines(),
        'if (sub === "view") {',
        "  const s = state();",
        '  if (argv.includes("version")) {',
        "    if (!s.published) { process.stderr.write('npm error code E404\\n'); process.exit(1); }",
        '    process.stdout.write(VERSION + "\\n");',
        "    process.exit(0);",
        "  }",
        '  if (argv.some((a) => a.startsWith("dist-tags."))) {',
        "    const attempts = s.distTagViewAttempts ?? 0;",
        "    setState({ distTagViewAttempts: attempts + 1 });",
        '    process.stdout.write((attempts >= 2 ? VERSION : "0.0.0-stale") + "\\n");',
        "    process.exit(0);",
        "  }",
        "}",
        'if (sub === "publish") { setState({ published: true }); process.exit(0); }',
        'process.stderr.write("stub npm: unhandled " + JSON.stringify(argv) + "\\n");',
        "process.exit(3);",
      ].join("\n");

      lastRun = runPublish({
        npmBody,
        initState: { published: false },
        qualificationEnv: NO_REGISTRY_TOKEN_ENV,
      });

      expect(lastRun.status).toBe(0);
      expect(lastRun.stdout).toContain(`PASS - ${RELEASE_SPEC} published as latest`);
      expect(lastRun.stdout).toContain("TAG pending");
      expect(lastRun.calls.some((l) => l.startsWith('npm ["dist-tag","add"'))).toBe(false);
    });

    it.each([5, 10, 15])(
      "waits through a %i-minute trusted-publishing registry quarantine simulation",
      (quarantineMinutes) => {
        // The workflow's production delay is one minute. The test keeps delay at zero but makes
        // the version-specific registry endpoint stay 404 for the same number of read cycles.
        const npmBody = [
          'log("npm");',
          "const sub = argv[0];",
          'if (sub === "config" && argv[1] === "get" && argv[2] === "strict-ssl") { process.stdout.write("true\\n"); process.exit(0); }',
          'if (sub === "run") { process.exit(0); }',
          ...npmPackStubLines(),
          'if (sub === "view") {',
          '  if (argv.includes("version")) { process.stderr.write("version reads use curl\\n"); process.exit(91); }',
          '  if (argv.some((a) => a.startsWith("dist-tags."))) {',
          "    const visible = (state().versionEndpointAttempts ?? 0) >= Number(process.env.KEIKO_TEST_QUARANTINE_MINUTES);",
          '    process.stdout.write((visible ? VERSION : "0.0.0-stale") + "\\n");',
          "    process.exit(0);",
          "  }",
          "}",
          'if (sub === "publish") { setState({ published: true }); process.exit(0); }',
          'process.stderr.write("stub npm: unhandled " + JSON.stringify(argv) + "\\n");',
          "process.exit(3);",
        ].join("\n");

        lastRun = runPublish({
          npmBody,
          initState: {
            published: false,
            versionVisibleAfterAttempts: quarantineMinutes,
          },
          qualificationEnv: {
            ...NO_REGISTRY_TOKEN_ENV,
            KEIKO_RELEASE_VERIFY_ATTEMPTS: "30",
            KEIKO_RELEASE_VERIFY_DELAY_MS: "0",
            KEIKO_TEST_QUARANTINE_MINUTES: String(quarantineMinutes),
          },
        });

        expect(lastRun.status, lastRun.stderr).toBe(0);
        expect(lastRun.stdout).toContain("TAG pending");
        expect(lastRun.stdout).toContain(`PASS - ${RELEASE_SPEC} published as latest`);
        expect(lastRun.calls.filter(isVersionEndpointCurl).length).toBeGreaterThan(
          quarantineMinutes,
        );
        expect(lastRun.calls.some((l) => l.startsWith('npm ["dist-tag","add"'))).toBe(false);
        expect(lastRun.calls.some(isVersionView)).toBe(false);
      },
    );

    it("fails with an actionable error, and never attempts an unauthenticated write, when a dist-tag repair needs a token that is not configured", () => {
      // Already published (idempotent re-run) with a stale dist-tag, and no token: this is
      // exactly the path npm Trusted Publishing does not cover (it authorizes `npm publish`
      // only). The orchestrator must fail before attempting `npm dist-tag add`, not after a
      // bare npm 401.
      const viewBody = [
        "  const s = state();",
        '  if (argv.includes("version")) { process.stdout.write(VERSION + "\\n"); process.exit(0); }',
        '  if (argv.some((a) => a.startsWith("dist-tags."))) { process.stdout.write("0.0.0-stale\\n"); process.exit(0); }',
      ].join("\n");

      lastRun = runPublish({
        npmBody: npmStub(viewBody, { failOnPublish: true }),
        initState: { published: true, tagged: false },
        qualificationEnv: NO_REGISTRY_TOKEN_ENV,
      });

      expect(lastRun.status).toBe(1);
      expect(lastRun.stderr).toContain(`${RELEASE_NAME}@latest points to 0.0.0-stale`);
      expect(lastRun.stderr).toContain("version endpoint is visible");
      expect(lastRun.stderr).toContain("governed release orchestrator");
      expect(lastRun.stderr).toContain("operator-held npm token");
      expect(lastRun.stderr).not.toContain("NODE_AUTH_TOKEN");
      expect(lastRun.calls.some((l) => l.startsWith('npm ["dist-tag","add"'))).toBe(false);
      expect(lastRun.stdout).not.toContain("PASS -");
    });
  },
);

// parseArgs' argv loop mixes three token widths in one pass: a bare boolean flag
// (--dry-run, 1 token), an inline `--flag=value` assignment (1 token), and a
// space-separated value flag (--tag <value>, 2 tokens). Runs standalone (not inside the
// stubbed-orchestrator describe above) so it exercises real argv parsing regardless of
// whether the root version is a prerelease, and fails fast in validateDistTag before any
// npm/gh/git process is spawned.
describe("release-publish argv parsing", () => {
  it("advances the index correctly across a boolean flag, an inline-assignment flag, and a value flag", () => {
    const result = spawnSync(
      process.execPath,
      [
        "scripts/release-publish.mjs",
        "--dry-run",
        "--registry=https://registry.example.invalid/",
        "--tag",
        "not-a-real-tag",
      ],
      { cwd: REPO_ROOT, encoding: "utf8", env: process.env },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("unsupported npm dist-tag not-a-real-tag");
  });
});
