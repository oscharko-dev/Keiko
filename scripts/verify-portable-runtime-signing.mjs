import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertContainedPath,
  PORTABLE_VERIFICATION_POLICIES,
  portableTargetByName,
  portableVerificationSummaryForManifest,
  readPortableManifest,
  validatePortableCandidateManifest,
  validatePortableStagingManifest,
} from "./portable-runtime.mjs";
import {
  PortableVerificationInputError,
  readPortableVerificationInput,
} from "./portable-verification-input.mjs";

function fail(message) {
  console.error(`portable-signing verify failed: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const options = { manifest: undefined, policy: undefined, verificationInput: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === "--manifest") {
      options.manifest = requiredValue(value, arg);
      index += 1;
      continue;
    }
    if (arg === "--policy") {
      options.policy = requiredValue(value, arg);
      index += 1;
      continue;
    }
    if (arg === "--verification-input") {
      options.verificationInput = requiredValue(value, arg);
      index += 1;
      continue;
    }
    fail(`unsupported argument: ${arg}`);
  }
  if (options.manifest === undefined) fail("pass --manifest <path>");
  if (options.policy === undefined)
    fail("pass --policy <staging|development|pull-request|production>");
  if (!PORTABLE_VERIFICATION_POLICIES.includes(options.policy)) {
    fail(`unsupported verification policy: ${options.policy}`);
  }
  return options;
}

function requiredValue(value, arg) {
  if (typeof value !== "string" || value.length === 0) fail(`${arg} requires a value`);
  return value;
}

function sidecarTarget(sidecar) {
  const target = portableTargetByName(sidecar.platformTarget);
  if (target === undefined) fail(`sidecar ${sidecar.name} platformTarget is unsupported`);
  return target;
}

function verificationSucceeded(target, checks) {
  if (target.nodePlatform === "win32") {
    return checks.publisherChainVerified === true && checks.timestampVerified === true;
  }
  return (
    checks.developerIdVerified === true &&
    checks.notarizationVerified === true &&
    checks.stapleVerified === true &&
    checks.assessmentVerified === true
  );
}

function failureReasonCodes(target, checks) {
  if (target.nodePlatform === "win32") {
    return [
      ...(checks.publisherChainVerified === true ? [] : ["windows-publisher-chain-unverified"]),
      ...(checks.timestampVerified === true ? [] : ["windows-timestamp-unverified"]),
    ];
  }
  return [
    ...(checks.developerIdVerified === true ? [] : ["macos-developer-id-unverified"]),
    ...(checks.notarizationVerified === true ? [] : ["macos-notarization-unverified"]),
    ...(checks.stapleVerified === true ? [] : ["macos-staple-unverified"]),
    ...(checks.assessmentVerified === true ? [] : ["macos-assessment-unverified"]),
  ];
}

function verificationStateFor(target, policy, input) {
  const verified = verificationSucceeded(target, input.verificationChecks);
  const reasons = verificationReasonCodesFor(target, policy, verified, input);
  return {
    verificationChecks: input.verificationChecks,
    verificationPolicy: policy,
    verificationReasonCodes: reasons,
    verificationStatus: verificationStatusFor(policy, verified),
    signatureKind: target.signatureKind,
    signatureVerified:
      target.nodePlatform === "win32"
        ? verified
        : input.verificationChecks.developerIdVerified === true,
    notarizationRequired: target.nodePlatform === "darwin",
    notarizationVerified:
      target.nodePlatform === "darwin"
        ? input.verificationChecks.notarizationVerified === true
        : false,
  };
}

function verificationStatusFor(policy, verified) {
  if (policy === "staging") return "unverified-staging";
  if (policy === "production") return verified ? "verified-production" : "verification-failed";
  return verified ? "verified-non-production" : "unsigned-non-production";
}

function verificationReasonCodesFor(target, policy, verified, input) {
  if (policy === "staging") return ["staging-unverified"];
  if (policy === "production") {
    return verified
      ? []
      : [
          ...new Set([
            ...input.reasonCodes,
            ...failureReasonCodes(target, input.verificationChecks),
          ]),
        ];
  }
  if (verified) return ["non-production-artifact"];
  return [
    ...new Set([
      "non-production-artifact",
      "non-production-unsigned-allowed",
      ...input.reasonCodes,
      ...failureReasonCodes(target, input.verificationChecks),
    ]),
  ];
}

function applyVerificationState(manifest, state, sidecarStates) {
  manifest.security = {
    ...manifest.security,
    verificationPolicy: state.verificationPolicy,
    verificationStatus: state.verificationStatus,
    verificationReasonCodes: state.verificationReasonCodes,
    signatureKind: state.signatureKind,
    signatureVerified: state.signatureVerified,
    notarizationRequired: state.notarizationRequired,
    notarizationVerified: state.notarizationVerified,
    verificationChecks: state.verificationChecks,
  };
  applySidecarVerificationStates(manifest, sidecarStates);
  manifest.releaseImpact.reviewedBinding = {
    ...manifest.releaseImpact.reviewedBinding,
    verificationPolicy: state.verificationPolicy,
    verificationStatus: state.verificationStatus,
    verificationReasonCodes: state.verificationReasonCodes,
    platformSignatureLocallyVerified:
      portableVerificationSummaryForManifest(manifest).platformSignatureLocallyVerified,
    signatureKind: state.signatureKind,
    signatureVerified: state.signatureVerified,
    notarizationRequired: state.notarizationRequired,
    notarizationVerified: state.notarizationVerified,
    verificationChecks: state.verificationChecks,
  };
  syncReviewedSidecars(manifest);
  manifest.updateEligibility.requiredPredicates.platformSignatureLocallyVerified =
    portableVerificationSummaryForManifest(manifest).platformSignatureLocallyVerified;
}

function applySidecarVerificationStates(manifest, sidecarStates) {
  if (!Array.isArray(manifest.sidecarRuntimes)) return;
  const statesByName = new Map(sidecarStates.map((entry) => [entry.name, entry.state]));
  manifest.sidecarRuntimes = manifest.sidecarRuntimes.map((sidecar) => ({
    ...sidecar,
    signing: {
      ...sidecar.signing,
      ...statesByName.get(sidecar.name),
    },
  }));
}

function sidecarVerificationStates(manifest, policy, inputs) {
  const sidecars = Array.isArray(manifest.sidecarRuntimes) ? manifest.sidecarRuntimes : [];
  const inputsByName = new Map(inputs.map((input) => [input.name, input]));
  return sidecars.map((sidecar) => {
    const input = inputsByName.get(sidecar.name);
    if (input === undefined) fail(`sidecar verification input missing for ${sidecar.name}`);
    return {
      name: sidecar.name,
      state: verificationStateFor(sidecarTarget(sidecar), policy, input),
    };
  });
}

function syncReviewedSidecars(manifest) {
  if (!Array.isArray(manifest.sidecarRuntimes) || manifest.sidecarRuntimes.length === 0) {
    delete manifest.releaseImpact.reviewedBinding.sidecarRuntimes;
    return;
  }
  manifest.releaseImpact.reviewedBinding.sidecarRuntimes = JSON.parse(
    JSON.stringify(manifest.sidecarRuntimes),
  );
}

function productionVerificationFailures(manifest) {
  if (manifest.security.verificationStatus !== "verified-production") {
    return manifest.security.verificationReasonCodes;
  }
  return sidecarProductionFailures(manifest);
}

function sidecarProductionFailures(manifest) {
  if (!Array.isArray(manifest.sidecarRuntimes)) return [];
  return manifest.sidecarRuntimes
    .filter((sidecar) => sidecar.signing?.verificationStatus !== "verified-production")
    .flatMap((sidecar) => sidecarFailureReasonCodes(sidecar));
}

function sidecarFailureReasonCodes(sidecar) {
  const reasons = sidecar.signing?.verificationReasonCodes ?? ["verification-input-missing"];
  return reasons.map((reason) => `${sidecar.name}:${reason}`);
}

function assertProductionVerified(manifest) {
  const failures = productionVerificationFailures(manifest);
  if (failures.length > 0) fail(failures.join(", "));
}

function writeOutputs(manifestPath, manifest) {
  const manifestAbsolute = resolve(manifestPath);
  const stageRoot = dirname(dirname(manifestAbsolute));
  const summaryPath = summaryOutputPath(stageRoot, manifest.security?.verificationSummaryPath);
  mkdirSync(dirname(summaryPath), { recursive: true });
  writeFileSync(
    summaryPath,
    JSON.stringify(portableVerificationSummaryForManifest(manifest), null, 2) + "\n",
  );
  writeFileSync(manifestAbsolute, JSON.stringify(manifest, null, 2) + "\n");
}

function summaryOutputPath(stageRoot, summaryPath) {
  if (typeof summaryPath !== "string" || summaryPath.length === 0) {
    fail("manifest security.verificationSummaryPath must be set");
  }
  return assertContainedPath(stageRoot, join(stageRoot, summaryPath));
}

export function runPortableRuntimeSigningVerify(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const manifest = readPortableManifest(options.manifest);
  const target = portableTargetByName(manifest.artifact?.platformTarget);
  if (target === undefined) fail("manifest artifact.platformTarget is unsupported");
  const sidecars = Array.isArray(manifest.sidecarRuntimes) ? manifest.sidecarRuntimes : [];
  let verificationInput;
  try {
    verificationInput = readPortableVerificationInput(
      options.verificationInput,
      target,
      options.policy,
      sidecars,
    );
  } catch (error) {
    if (error instanceof PortableVerificationInputError) fail(error.message);
    throw error;
  }
  const sidecarStates = sidecarVerificationStates(
    manifest,
    options.policy,
    verificationInput.sidecarRuntimes,
  );
  applyVerificationState(
    manifest,
    verificationStateFor(target, options.policy, verificationInput),
    sidecarStates,
  );
  writeOutputs(options.manifest, manifest);
  if (options.policy === "production") assertProductionVerified(manifest);
  const failures =
    options.policy === "production"
      ? validatePortableCandidateManifest(manifest)
      : validatePortableStagingManifest(manifest);
  if (failures.length > 0) fail(failures.join("\n  - "));
  console.log(
    `portable-signing verify: PASS ${manifest.artifact.platformTarget} ${manifest.security.verificationStatus}`,
  );
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runPortableRuntimeSigningVerify();
}
