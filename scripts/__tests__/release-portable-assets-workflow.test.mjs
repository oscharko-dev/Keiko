import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";

import {
  importGraphReachesDist,
  providesBuiltPackages,
  repositoryScriptsIn,
} from "./workflow-script-graph.mjs";

import {
  PORTABLE_ASSETS_ARTIFACT_NAME,
  resolvePortableAssetsManifest,
  validatePortableAssetsRunSnapshot,
  writeGithubOutput,
} from "../resolve-release-portable-assets.mjs";
import {
  envValue,
  portableReleaseAuthorityFailures,
} from "../check-release-required-workflow-names.mjs";
import { RUNTIME_ACTIVATION_RELATIVE_PATH } from "../runtime-activation-manifest.mjs";
import {
  redactedWindowsSigningError,
  validateAzureArtifactSigningConfig,
} from "../windows-portable-signing.mjs";

const portableWorkflow = readFileSync(".github/workflows/portable-assets.yml", "utf8");
const portableWorkflowDocument = parse(portableWorkflow);
const releaseWorkflow = readFileSync(".github/workflows/release.yml", "utf8");

function workflowJob(name) {
  return portableWorkflowDocument.jobs[name];
}

// Evaluates the one ref-selecting expression shape this workflow uses:
// ${{ github.ref == 'refs/heads/dev' && 'A' || 'B' }}
function valueForRef(expression, ref) {
  const match = /^\$\{\{\s*github\.ref == '([^']+)' && '([^']+)' \|\| '([^']+)'\s*\}\}$/u.exec(
    String(expression).trim(),
  );
  if (match === null) throw new Error(`unexpected ref expression: ${String(expression)}`);
  return ref === match[1] ? match[2] : match[3];
}

function jobNeeds(job) {
  return Array.isArray(job.needs) ? job.needs : [job.needs].filter(Boolean);
}

function namedStep(job, name) {
  const step = job.steps.find((entry) => entry.name === name);
  if (step === undefined) throw new Error(`missing workflow step: ${name}`);
  return step;
}

describe("portable release-trust workflow", () => {
  it("builds and natively smokes all four stable targets without Apple or Microsoft signing", () => {
    const stage = workflowJob("stage");
    expect(stage.strategy.matrix.include).toEqual([
      { platform_target: "windows-x64", runner: "windows-latest" },
      { platform_target: "macos-arm64", runner: "macos-15" },
      { platform_target: "macos-x64", runner: "macos-15-intel" },
    ]);
    expect(stage.if).toContain("github.event_name == 'push'");
    expect(namedStep(stage, "Stage stable unsigned runtime for Keiko release trust").run).toContain(
      "--release",
    );
    expect(namedStep(stage, "Functionally smoke the staged USearch addon")).toBeDefined();
    expect(namedStep(stage, "Smoke test the staged artifact")).toBeDefined();
    expect(namedStep(stage, "Functionally smoke the unsigned secure-read helper").run).toContain(
      "--load",
    );
    expect(namedStep(stage, "Build unsigned Windows setup companion").if).toBe(
      "runner.os == 'Windows'",
    );
    const linux = workflowJob("stage-linux-production");
    expect(linux["runs-on"]).toBe("ubuntu-latest");
    expect(namedStep(linux, "Stage stable runtime for Keiko release trust").run).toContain(
      "--release",
    );
  });

  it("keeps native signing optional and out of the release authority path", () => {
    expect(Object.keys(portableWorkflowDocument.jobs)).toEqual([
      "rehearsal-readiness",
      "stage",
      "stage-linux-manual",
      "stage-linux-production",
      "qualify-linux-production",
      "assemble",
      "publish-handoff",
    ]);
    expect(portableWorkflow).not.toMatch(
      /AZURE_|APPLE_|artifact-signing-action|notarytool|codesign/u,
    );
    expect(workflowJob("stage").environment).toBeUndefined();
    expect(workflowJob("stage").permissions).toEqual({
      contents: "read",
    });
    const linuxEnvironment = workflowJob("stage-linux-production").environment;
    expect(valueForRef(linuxEnvironment, "refs/tags/v1.0.0")).toBe("portable-release-signing");
    // A rehearsal must not wait on, or reach into, the signing environment.
    expect(valueForRef(linuxEnvironment, "refs/heads/dev")).toBe("portable-release-rehearsal");
    // The planner reads the release state but has no write authority.
    const readiness = workflowJob("rehearsal-readiness");
    expect(readiness.environment).toBeUndefined();
    expect(readiness.permissions).toEqual({ actions: "read", contents: "read" });
    expect(JSON.stringify(readiness)).not.toMatch(/secrets\.|vars\./u);
  });

  it("assembles only a complete stable matrix and keeps attestations supplementary", () => {
    const assemble = workflowJob("assemble");
    expect(assemble.needs).toEqual(["stage", "stage-linux-production", "qualify-linux-production"]);
    expect(assemble.if).toContain("needs.stage.result == 'success'");
    expect(assemble.if).toContain("needs.qualify-linux-production.result == 'success'");
    expect(assemble.if).toContain("!contains(github.ref_name, '-')");
    expect(assemble.permissions).toEqual({
      attestations: "write",
      contents: "read",
      "id-token": "write",
    });
    const bundleName = namedStep(assemble, "Upload release-trust candidate bundle").with.name;
    expect(valueForRef(bundleName, "refs/tags/v1.0.0")).toBe(PORTABLE_ASSETS_ARTIFACT_NAME);
    expect(valueForRef(bundleName, "refs/heads/dev")).not.toBe(PORTABLE_ASSETS_ARTIFACT_NAME);
    expect(assemble.steps.filter((step) => step.uses?.startsWith("actions/attest@"))).toHaveLength(
      6,
    );
  });

  it("uses the protected publisher as the sole private-key boundary", () => {
    expect(releaseWorkflow).toContain("environment: npm-publish");
    expect(releaseWorkflow).toContain(
      "KEIKO_PORTABLE_RELEASE_SIGNING_KEY: ${{ secrets.KEIKO_PORTABLE_RELEASE_SIGNING_KEY }}",
    );
    expect(portableWorkflow).not.toContain("KEIKO_PORTABLE_RELEASE_SIGNING_KEY");
  });

  it("retains an explicit dispatch-only evaluation lane", () => {
    const input = portableWorkflowDocument.on.workflow_dispatch.inputs.evaluation_build;
    expect(input).toMatchObject({ default: false, required: false, type: "boolean" });
    const stage = workflowJob("stage");
    const evaluation = namedStep(stage, "Stage unsigned evaluation runtime for manual smoke");
    const ordinary = namedStep(stage, "Stage unsigned runtime for manual smoke");
    expect(evaluation.if).toContain("inputs.evaluation_build");
    expect(evaluation.run).toContain("--evaluation");
    expect(ordinary.if).toContain("!inputs.evaluation_build");
    expect(ordinary.run).not.toContain("--evaluation");
    const linux = workflowJob("stage-linux-manual");
    expect(namedStep(linux, "Stage unsigned evaluation runtime for manual smoke").run).toContain(
      "--evaluation",
    );
    expect(linux.permissions).toEqual({ contents: "read" });
  });

  it("attests Linux only after exact runtime qualification and re-verifies without OIDC", () => {
    const stage = workflowJob("stage-linux-production");
    const fresh = workflowJob("qualify-linux-production");
    const stepIndex = (job, name) => job.steps.findIndex((step) => step.name === name);
    const qualify = stepIndex(stage, "Qualify the exact Linux runtime and namespace gateway");
    const attest = stepIndex(stage, "Attest the exact qualification receipt with GitHub OIDC");
    const finalize = stepIndex(stage, "Seal and verify the production Linux archive");
    const upload = stepIndex(stage, "Upload verified Linux target artifact");

    expect(stage.permissions["id-token"]).toBe("write");
    expect(qualify).toBeGreaterThan(-1);
    expect(qualify).toBeLessThan(attest);
    expect(attest).toBeLessThan(finalize);
    expect(finalize).toBeLessThan(upload);
    expect(fresh.permissions).toEqual({ contents: "read" });
    expect(JSON.stringify(fresh)).toContain("--verify-only true");
  });

  it("relaxes hosted-runner namespace isolation before every Linux qualification", () => {
    // Both Linux jobs run the real namespace-gateway proof, which creates a network namespace.
    // Ubuntu 24.04 blocks unprivileged user namespaces via AppArmor and the hosted image ships no
    // iproute2, so without ./.github/actions/setup-sandbox-isolation the denied-egress child fails
    // closed BEFORE printing its BLOCKED/TIMEOUT marker and the proof sees an empty stdout. That is
    // how the v1.0.0 release failed on 2026-09-13: ci.yml calls this action in seven jobs and
    // e2e-extended.yml in two, while portable-assets.yml called it in none.
    const isolation = "./.github/actions/setup-sandbox-isolation";

    for (const name of ["stage-linux-production", "qualify-linux-production"]) {
      const job = workflowJob(name);
      const isolationAt = job.steps.findIndex((step) => step.uses === isolation);
      const qualifyAt = job.steps.findIndex((step) =>
        String(step.run ?? "").includes("qualify-linux-runtime-release.mjs"),
      );

      expect(isolationAt, `${name} must set up sandbox isolation`).toBeGreaterThan(-1);
      expect(qualifyAt, `${name} must run the namespace-gateway qualification`).toBeGreaterThan(-1);
      expect(isolationAt, `${name} must isolate before it qualifies`).toBeLessThan(qualifyAt);
    }
  });

  it("keeps the Linux-only isolation action out of the Windows and macOS matrix", () => {
    // The action installs Debian packages and writes a Linux sysctl. Adding it to the three-target
    // matrix would fail on windows-latest and macos-*, so absence there is part of the contract,
    // not an omission.
    const isolation = "./.github/actions/setup-sandbox-isolation";

    for (const name of ["stage", "assemble"]) {
      expect(
        workflowJob(name).steps.some((step) => step.uses === isolation),
        `${name} must not call the Linux-only isolation action`,
      ).toBe(false);
    }
  });

  it("builds workspace packages before any Linux step that loads built package output", () => {
    // qualify-linux-production installs with --ignore-scripts and stages nothing, so no step of its
    // own produces packages/*/dist — yet linux-portable-signing.mjs imports the built keiko-server
    // production discovery module. The first ever run of that job, on the v1.0.0 release of
    // 2026-09-13, died there with ERR_MODULE_NOT_FOUND after six earlier Linux repairs, while the
    // plain-node load proof in linux-portable-signing.test.mjs stayed green: it runs in a checkout
    // that already carries dist. This pin holds the job's provisioning, which that proof cannot see.
    for (const name of ["stage-linux-production", "qualify-linux-production"]) {
      const job = workflowJob(name);
      const providerAt = job.steps.findIndex((step) => providesBuiltPackages(step.run));
      job.steps.forEach((step, index) => {
        for (const script of repositoryScriptsIn(String(step.run ?? ""))) {
          if (!importGraphReachesDist(script)) continue;
          expect(providerAt, `${name}: ${script} imports packages/*/dist`).toBeGreaterThan(-1);
          expect(providerAt, `${name}: ${script} runs before the packages are built`).toBeLessThan(
            index,
          );
        }
      });
    }
  });

  it("re-verifies the sealed Linux artifact only after building the packages it imports", () => {
    // The named-step form of the incident above, and a check that the import walk still sees the
    // dist import it was written for — a walker that goes blind would pass the pin over a broken job.
    const steps = workflowJob("qualify-linux-production").steps.map((step) => step.name);
    const buildAt = steps.indexOf("Build workspace packages");
    const verifyAt = steps.indexOf(
      "Re-verify the offline Sigstore bundle, archive, and production discovery",
    );

    expect(importGraphReachesDist("scripts/linux-portable-signing.mjs")).toBe(true);
    expect(buildAt).toBeGreaterThan(-1);
    expect(verifyAt).toBeGreaterThan(-1);
    expect(buildAt).toBeLessThan(verifyAt);
  });

  it("hands the verified Linux tree to the fresh qualification with its file modes intact", () => {
    // upload-artifact's zipped upload stores every file as 644 (its README: "Permission Loss"), so
    // a job that downloads portable-stage-linux-x64 holds a native helper it cannot execute, and
    // the two requalification steps that spawn it would die with EACCES. The action's documented
    // remedy is a tar uploaded as-is (archive: false), which download-artifact hands back unchanged
    // and tar -p unpacks with its modes. assemble keeps consuming the zipped portable-stage-* set.
    const tarball = "linux-x64-qualification-tree.tar";
    const stage = workflowJob("stage-linux-production");
    const fresh = workflowJob("qualify-linux-production");
    const runs = (step, text) => String(step.run ?? "").includes(text);

    const packAt = stage.steps.findIndex((step) =>
      runs(step, `-cpf "$RUNNER_TEMP/${tarball}" linux-x64`),
    );
    const packUpload = stage.steps[packAt + 1];
    expect(packAt).toBeGreaterThan(-1);
    expect(String(packUpload?.uses)).toMatch(/^actions\/upload-artifact@/u);
    expect(packUpload?.with?.archive).toBe(false);
    expect(String(packUpload?.with?.path).endsWith(`/${tarball}`)).toBe(true);
    expect(tarball.startsWith("portable-stage-")).toBe(false);

    const downloadAt = fresh.steps.findIndex(
      (step) =>
        /^actions\/download-artifact@/u.test(String(step.uses)) && step.with?.name === tarball,
    );
    const unpackAt = fresh.steps.findIndex((step) => runs(step, "-xpf") && runs(step, tarball));
    const firstUse = fresh.steps.findIndex((step) =>
      runs(step, ".portable-runtime/staging/linux-x64"),
    );
    expect(downloadAt).toBeGreaterThan(-1);
    expect(unpackAt).toBeGreaterThan(downloadAt);
    expect(firstUse).toBeGreaterThan(unpackAt);
    expect(fresh.steps.some((step) => step.with?.name === "portable-stage-linux-x64")).toBe(false);
  });

  it("uploads every staged tree with the hidden evidence directory the contract requires", () => {
    // The portable contract keeps its evidence under .portable/ — runtime-activation.json and
    // runtime-qualification.json. upload-artifact excludes hidden files by default
    // (include-hidden-files: 'false' at the pinned v7.0.1), so every portable-stage-* zip shipped
    // a tree with no evidence in it. The staging jobs stayed green because their smoke steps run
    // on the local tree before the upload, and the Linux hand-off stayed green because a tar
    // carries dotfiles; assemble is the first consumer that reads them, and it had never run. On
    // the v1.0.0 release of 2026-09-13 it failed with "missing runtime activation manifest".
    // A single file uploaded with archive: false is exempt: it is not a tree, and a tar keeps its
    // own hidden entries.
    expect(RUNTIME_ACTIVATION_RELATIVE_PATH.startsWith(".")).toBe(true);

    const uploads = Object.entries(portableWorkflowDocument.jobs).flatMap(([name, job]) =>
      (job.steps ?? [])
        .filter((step) => String(step.uses ?? "").startsWith("actions/upload-artifact"))
        .map((step) => ({ name, with: step.with ?? {} })),
    );

    expect(uploads.length).toBeGreaterThan(0);
    for (const upload of uploads) {
      if (upload.with.archive === false) continue;
      expect(
        upload.with["include-hidden-files"],
        `${upload.name} uploads a tree whose ${RUNTIME_ACTIVATION_RELATIVE_PATH} would be dropped`,
      ).toBe(true);
    }
  });

  it("pins portable staging to the release workflow authority", () => {
    expect(portableReleaseAuthorityFailures(releaseWorkflow, portableWorkflow)).toEqual([]);
    const releaseBaseBranch = envValue(releaseWorkflow, "RELEASE_BASE_BRANCH");
    expect(releaseBaseBranch).toMatch(/^release\/\d+\.\d+$/u);
    expect(
      portableReleaseAuthorityFailures(
        releaseWorkflow,
        portableWorkflow.replace(releaseBaseBranch, "release/drift"),
      ),
    ).toEqual(["RELEASE_BASE_BRANCH"]);
    expect(
      portableReleaseAuthorityFailures(
        releaseWorkflow,
        portableWorkflow.replace('"ui"]', '"drift"]'),
      ),
    ).toEqual(["RELEASE_REQUIRED_CHECKS"]);
  });
});

let currentRoot;

function root() {
  currentRoot = mkdtempSync(join(tmpdir(), "keiko-release-portable-assets-"));
  return currentRoot;
}

function writeBundleManifest(cwd, name = "portable-assets.json") {
  const bundleRoot = join(cwd, ".portable-release-assets");
  mkdirSync(bundleRoot, { recursive: true });
  const manifestPath = join(bundleRoot, name);
  writeFileSync(manifestPath, '{"schemaVersion":1,"artifacts":[]}\n');
  return manifestPath;
}

function latestEnv(overrides = {}) {
  return {
    NPM_DIST_TAG: "latest",
    PORTABLE_ASSETS_ARTIFACT_NAME: "portable-release-assets",
    PORTABLE_ASSETS_MANIFEST: "",
    PORTABLE_ASSETS_RUN_ATTEMPT: "2",
    PORTABLE_ASSETS_RUN_ID: "123456789",
    ...overrides,
  };
}

describe("release workflow portable asset manifest resolution", () => {
  afterEach(() => {
    if (currentRoot !== undefined) {
      rmSync(currentRoot, { recursive: true, force: true });
      currentRoot = undefined;
    }
  });

  it("rejects incomplete reviewed artifact bundle inputs", () => {
    expect(() =>
      resolvePortableAssetsManifest(
        latestEnv({ PORTABLE_ASSETS_ARTIFACT_NAME: "", PORTABLE_ASSETS_RUN_ID: "123456789" }),
        root(),
      ),
    ).toThrow("portable_assets_run_id and portable_assets_artifact_name must be provided together");
  });

  it("returns the canonical manifest path inside the downloaded artifact bundle", () => {
    const cwd = root();
    const manifestPath = writeBundleManifest(cwd);
    expect(resolvePortableAssetsManifest(latestEnv(), cwd)).toBe(realpathSync(manifestPath));
  });

  it.each([
    ["../x.json", "must not escape the downloaded artifact"],
    ["/tmp/x.json", "must be relative to the downloaded artifact"],
  ])("rejects unsafe manifest path %s", (path, message) => {
    const cwd = root();
    writeBundleManifest(cwd);
    expect(() =>
      resolvePortableAssetsManifest(latestEnv({ PORTABLE_ASSETS_MANIFEST: path }), cwd),
    ).toThrow(message);
  });

  it("rejects directory and symlink manifest inputs", () => {
    const cwd = root();
    const bundleRoot = join(cwd, ".portable-release-assets");
    mkdirSync(join(bundleRoot, "portable-assets.json"), { recursive: true });
    expect(() => resolvePortableAssetsManifest(latestEnv(), cwd)).toThrow("regular file");
    rmSync(join(bundleRoot, "portable-assets.json"), { recursive: true, force: true });
    const outside = join(cwd, "outside.json");
    writeFileSync(outside, "{}\n");
    symlinkSync(outside, join(bundleRoot, "portable-assets.json"));
    expect(() => resolvePortableAssetsManifest(latestEnv(), cwd)).toThrow("symbolic link");
  });

  it("writes the resolved manifest to GITHUB_OUTPUT", () => {
    const cwd = root();
    const outputPath = join(cwd, "github-output.txt");
    writeGithubOutput("portable-assets.json", { GITHUB_OUTPUT: outputPath });
    expect(readFileSync(outputPath, "utf8")).toBe("manifest=portable-assets.json\n");
  });
});

describe("jobs downstream of the rehearsal readiness on a tag push", () => {
  // rehearsal-readiness runs only on a dev push, so every tag push and every dispatch skips it. A job
  // condition without a status function gets GitHub's implicit success(), which counts that skipped
  // ancestor as not successful: the first v1.0.1 tag build staged all four targets and then skipped
  // the Linux qualification, the assembly and the publish handoff, and still concluded "success".
  const jobs = portableWorkflowDocument.jobs;
  const needsOf = (id) => [jobs[id]?.needs ?? []].flat();
  const hasAncestor = (id, ancestor, seen = new Set()) =>
    needsOf(id).some((parent) => {
      if (parent === ancestor) return true;
      if (seen.has(parent)) return false;
      seen.add(parent);
      return hasAncestor(parent, ancestor, seen);
    });
  const downstream = Object.keys(jobs).filter((id) => hasAncestor(id, "rehearsal-readiness"));

  it("covers every job the release path needs after the readiness", () => {
    expect(downstream).toEqual(
      expect.arrayContaining([
        "stage",
        "stage-linux-production",
        "qualify-linux-production",
        "assemble",
        "publish-handoff",
      ]),
    );
  });

  it.each(downstream)("gives %s an explicit status function", (id) => {
    expect(String(jobs[id].if)).toMatch(/^\$\{\{ (?:!cancelled\(\)|always\(\)) && /u);
  });
});

describe("stable release rehearsal on dev", () => {
  // Every job behind a needs edge used to run for the first time inside a tagged release, so the
  // v1.0.0 cut surfaced one defect per attempt. A dev push now rehearses the whole chain without
  // publishing it.

  it("rehearses on every dev push and cancels only a superseded rehearsal", () => {
    expect(portableWorkflowDocument.on.push.branches).toEqual(["dev"]);
    expect(portableWorkflowDocument.on.push.tags).toEqual(["v*"]);
    // Exact: GitHub cancels a queued run in a shared group even without cancel-in-progress, so a tag
    // run or a manual dispatch must never share a group with another run.
    expect(portableWorkflowDocument.concurrency).toEqual({
      group:
        "${{ github.event_name == 'push' && github.ref == 'refs/heads/dev' && 'portable-assets-dev-rehearsal' || format('portable-assets-run-{0}', github.run_id) }}",
      "cancel-in-progress": "${{ github.event_name == 'push' && github.ref == 'refs/heads/dev' }}",
    });
  });

  it("assigns an already-published dev version to the rehearsal owner only", () => {
    const readiness = workflowJob("rehearsal-readiness");
    expect(readiness.if).toContain("github.event_name == 'push'");
    expect(readiness.if).toContain("github.ref == 'refs/heads/dev'");
    expect(readiness.outputs.ready).toBe(
      "${{ steps.plan.outputs.portable-build == 'dev-rehearsal' }}",
    );
    expect(readiness.outputs.owner).toBe("${{ steps.plan.outputs.portable-build }}");
    expect(readiness.steps.find((step) => step.id === "plan")?.run).toBe(
      "node scripts/release-candidate.mjs --plan",
    );
    for (const name of ["stage", "stage-linux-production"]) {
      const job = workflowJob(name);
      expect(jobNeeds(job), `${name} must wait for readiness`).toContain("rehearsal-readiness");
      expect(job.if, `${name} must survive a skipped readiness job`).toMatch(
        /^\$\{\{ !cancelled\(\)/u,
      );
      expect(job.if).toContain("needs.rehearsal-readiness.outputs.ready == 'true'");
    }
  });

  it("keeps tag identity on stable tags and leaves required checks to the publish handoff", () => {
    for (const name of ["stage", "stage-linux-production"]) {
      const job = workflowJob(name);
      const authority = namedStep(job, "Validate stable tag and governed release authority");
      expect(authority.if, `${name} authority`).toContain("startsWith(github.ref, 'refs/tags/v')");
      // ADR-0177 D8: the tag build runs beside the commit's CI, so the release-required checks
      // gate the publish handoff after assemble (release-candidate-workflow.test.mjs) instead.
      expect(authority.run).not.toContain("verify-release-required-checks.mjs");
      const rehearsal = namedStep(
        job,
        "Validate the release workflow authority a rehearsal will face",
      );
      expect(rehearsal.if).toContain("github.ref == 'refs/heads/dev'");
      expect(rehearsal.run).toContain("npm run check:release-required-workflows");
    }
    expect(namedStep(workflowJob("stage"), "Validate approved runtime inputs").if).toContain(
      "github.ref == 'refs/heads/dev'",
    );
  });

  it("verifies a rehearsal in the rehearsal lane and a release in the release lane", () => {
    for (const [jobName, stepName] of [
      ["stage-linux-production", "Seal and verify the production Linux archive"],
      [
        "qualify-linux-production",
        "Re-verify the offline Sigstore bundle, archive, and production discovery",
      ],
    ]) {
      const step = namedStep(workflowJob(jobName), stepName);
      expect(step.run, stepName).toContain('--lane "$SIGNING_LANE"');
      expect(valueForRef(step.env.SIGNING_LANE, "refs/heads/dev")).toBe("rehearsal");
      expect(valueForRef(step.env.SIGNING_LANE, "refs/tags/v1.0.0")).toBe("release");
    }
  });

  it("builds, signs, and assembles exactly the commit that triggered the run", () => {
    // An explicit ref makes actions/checkout fetch that ref's tip when the job starts; on
    // refs/heads/dev that can already be a newer push, while every artifact is bound to GITHUB_SHA.
    for (const [jobName, job] of Object.entries(portableWorkflowDocument.jobs)) {
      const checkout = job.steps.find((step) => String(step.uses).startsWith("actions/checkout@"));
      expect(checkout, `${jobName} checkout`).toBeDefined();
      expect(checkout.with?.ref, `${jobName} must check out the event commit`).toBeUndefined();
    }
    for (const jobName of ["stage", "stage-linux-production", "qualify-linux-production"]) {
      const { steps } = workflowJob(jobName);
      const verify = steps.findIndex((step) => step.name === "Verify checked-out commit");
      expect(verify, `${jobName} verifies its commit`).toBeGreaterThan(0);
      expect(steps[verify].run).toBe('test "$(git rev-parse HEAD)" = "$GITHUB_SHA"');
      expect(steps[verify].if, `${jobName} verification is unconditional`).toBeUndefined();
      steps.forEach((step, index) => {
        if (index !== verify && String(step.run).includes("GITHUB_SHA")) {
          expect(
            index,
            `${jobName}: ${String(step.name)} runs after the commit check`,
          ).toBeGreaterThan(verify);
        }
      });
    }
    // The Windows leg runs pwsh by default; the check is bash.
    expect(namedStep(workflowJob("stage"), "Verify checked-out commit").shell).toBe("bash");
  });

  it("keeps every secret-bearing step off the rehearsal lane", () => {
    // Environment separation keeps signing credentials away from a rehearsal only while no step reads
    // a secret on the rehearsal lane, so a step may read one only behind a reviewed stable-tag
    // condition.
    const stableTagOnly = new Set([
      "${{ startsWith(github.ref, 'refs/tags/v') }}",
      "${{ github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v') }}",
    ]);
    for (const [jobName, job] of Object.entries(portableWorkflowDocument.jobs)) {
      const { steps, ...jobSettings } = job;
      expect(JSON.stringify(jobSettings), `${jobName} job settings`).not.toContain("secrets.");
      for (const step of steps) {
        if (!JSON.stringify(step).includes("secrets.")) continue;
        expect(stableTagOnly.has(step.if), `${jobName}: ${String(step.name)}`).toBe(true);
      }
    }
    expect(JSON.stringify(portableWorkflowDocument.env ?? {})).not.toContain("secrets.");
  });

  it("checks the release tag a rehearsal would cut, derived from the version", () => {
    const run = namedStep(
      workflowJob("assemble"),
      "Assemble and validate the release asset bundle",
    ).run;
    expect(run).toContain('--release-tag "v$(node -p');
    expect(run).not.toContain("GITHUB_REF_NAME");
  });
});

describe("portable asset workflow run resolution", () => {
  const config = {
    artifactName: "portable-release-assets",
    releaseTag: "v0.2.15",
    repository: "oscharko-dev/Keiko",
    runAttempt: "2",
    runId: "123456789",
    sha: "a".repeat(40),
  };
  const run = {
    conclusion: "success",
    event: "push",
    head_branch: "v0.2.15",
    head_sha: "a".repeat(40),
    id: 123456789,
    path: ".github/workflows/portable-assets.yml@refs/tags/v0.2.15",
    repository: { full_name: "oscharko-dev/Keiko" },
    run_attempt: 2,
    status: "completed",
  };
  const artifacts = {
    artifacts: [
      { expired: false, id: 777, name: "portable-release-assets", workflow_run: { id: 123456789 } },
    ],
  };

  it("accepts one canonical artifact from the exact successful stable push", () => {
    expect(validatePortableAssetsRunSnapshot(config, run, artifacts)).toEqual({
      artifactId: 777,
      runAttempt: 2,
    });
  });

  it("refuses a dev rehearsal run and its rehearsal bundle", () => {
    const rehearsal = {
      ...run,
      head_branch: "dev",
      path: ".github/workflows/portable-assets.yml@refs/heads/dev",
    };
    expect(() => validatePortableAssetsRunSnapshot(config, rehearsal, artifacts)).toThrow(
      "stable tag",
    );
    const rehearsalBundle = {
      artifacts: [{ ...artifacts.artifacts[0], name: "portable-rehearsal-assets" }],
    };
    expect(() => validatePortableAssetsRunSnapshot(config, run, rehearsalBundle)).toThrow(
      "exactly one canonical portable asset artifact is required",
    );
  });

  it.each([
    ["workflow", { path: ".github/workflows/ci.yml" }, artifacts, "workflow path"],
    ["event", { event: "workflow_dispatch" }, artifacts, "event"],
    ["conclusion", { conclusion: "failure" }, artifacts, "conclusion"],
    ["SHA", { head_sha: "b".repeat(40) }, artifacts, "head SHA"],
    ["attempt", { run_attempt: 3 }, artifacts, "run attempt"],
    ["expired", {}, { artifacts: [{ ...artifacts.artifacts[0], expired: true }] }, "expired"],
  ])("rejects wrong %s metadata", (_name, runPatch, artifactValue, message) => {
    expect(() =>
      validatePortableAssetsRunSnapshot(config, { ...run, ...runPatch }, artifactValue),
    ).toThrow(message);
  });
});

describe("optional Windows Artifact Signing configuration", () => {
  function config(endpoint = "https://eus.codesigning.azure.net/") {
    return {
      AZURE_CLIENT_ID: "11111111-1111-1111-1111-111111111111",
      AZURE_TENANT_ID: "22222222-2222-2222-2222-222222222222",
      AZURE_SUBSCRIPTION_ID: "33333333-3333-3333-3333-333333333333",
      AZURE_ARTIFACT_SIGNING_ENDPOINT: endpoint,
      AZURE_ARTIFACT_SIGNING_ACCOUNT_NAME: "account",
      AZURE_ARTIFACT_SIGNING_CERTIFICATE_PROFILE_NAME: "profile",
      AZURE_ARTIFACT_SIGNING_IDENTITY_EKU: "1.3.6.1.4.1.311.97.12345",
    };
  }

  it("keeps the dormant provider parser strict", () => {
    expect(() => validateAzureArtifactSigningConfig(config())).not.toThrow();
    for (const endpoint of [
      "http://eus.codesigning.azure.net/",
      "https://eus.codesigning.azure.net:443/",
      "https://eus.codesigning.azure.net/path",
      "https://eus.codesigning.azure.net.evil.example/",
    ]) {
      expect(() => validateAzureArtifactSigningConfig(config(endpoint)), endpoint).toThrow(
        /service endpoint is invalid/u,
      );
    }
  });

  it("redacts dormant provider failures", () => {
    const missing = config();
    delete missing.AZURE_CLIENT_ID;
    expect(() => validateAzureArtifactSigningConfig(missing)).toThrow(
      "configuration is incomplete",
    );
    expect(redactedWindowsSigningError(new Error("/private/path secret"))).toBe(
      "windows-portable-signing: redacted failure",
    );
  });
});
