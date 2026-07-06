import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertContainedPath,
  createPortableVerificationChecks,
  findPortableMetadataRedactionFailures,
  PORTABLE_VERIFICATION_POLICIES,
  portableTargetByName,
  portableVerificationSummaryForManifest,
  readPortableManifest,
  validatePortableManifest,
} from "./portable-runtime.mjs";

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

function exactInputKeys(input) {
  return Object.keys(input).sort();
}

function readVerificationInput(path, target, policy) {
  const emptyChecks = createPortableVerificationChecks(target.platformTarget, false);
  if (path === undefined) {
    return {
      reasonCodes: policy === "production" ? ["verification-input-missing"] : [],
      verificationChecks: emptyChecks,
    };
  }
  const input = readPortableManifest(path);
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    fail("verification input must be a JSON object");
  }
  for (const key of exactInputKeys(input)) {
    if (!["reasonCodes", "verificationChecks"].includes(key)) {
      fail(`unsupported verification input key: ${key}`);
    }
  }
  const redactionFailures = findPortableMetadataRedactionFailures(input, "verificationInput");
  if (redactionFailures.length > 0) fail(redactionFailures.join("\n  - "));
  const reasonCodes = readReasonCodes(input.reasonCodes);
  const verificationChecks = readVerificationChecks(input.verificationChecks, target);
  return { reasonCodes, verificationChecks };
}

function readReasonCodes(value) {
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string" || entry.length === 0)
  ) {
    fail("verification input reasonCodes must be a string array");
  }
  return [...new Set(value)];
}

function readVerificationChecks(value, target) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("verification input verificationChecks must be an object");
  }
  const allowedKeys =
    target.nodePlatform === "win32"
      ? ["publisherChainVerified", "timestampVerified"]
      : ["developerIdVerified", "notarizationVerified", "stapleVerified", "assessmentVerified"];
  for (const key of exactInputKeys(value)) {
    if (!allowedKeys.includes(key)) fail(`unsupported verification check key: ${key}`);
  }
  const checks = {};
  for (const key of allowedKeys) {
    if (typeof value[key] !== "boolean") fail(`verification input ${key} must be a boolean`);
    checks[key] = value[key];
  }
  return checks;
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

function applyVerificationState(manifest, state) {
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
  manifest.updateEligibility.requiredPredicates.platformSignatureLocallyVerified =
    portableVerificationSummaryForManifest(manifest).platformSignatureLocallyVerified;
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
  const verificationInput = readVerificationInput(
    options.verificationInput,
    target,
    options.policy,
  );
  applyVerificationState(manifest, verificationStateFor(target, options.policy, verificationInput));
  writeOutputs(options.manifest, manifest);
  const failures = validatePortableManifest(manifest, { allowUnverified: true });
  if (failures.length > 0) fail(failures.join("\n  - "));
  if (
    options.policy === "production" &&
    manifest.security.verificationStatus !== "verified-production"
  ) {
    fail(manifest.security.verificationReasonCodes.join(", "));
  }
  console.log(
    `portable-signing verify: PASS ${manifest.artifact.platformTarget} ${manifest.security.verificationStatus}`,
  );
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runPortableRuntimeSigningVerify();
}
