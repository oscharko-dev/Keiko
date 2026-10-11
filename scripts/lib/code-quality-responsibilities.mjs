import { createSymbolResolver } from "./code-quality-symbols.mjs";
import { compareStrings } from "./compare-strings.mjs";

function inventoryFile(subject, path) {
  return subject.inventory.files.find((file) => file.path === path);
}

function resolveRoles(resolver, record) {
  if (record.kind !== "diagnostic-checker")
    return Object.fromEntries(
      ["input", "transform", "output", "consumer"].map((role) => [
        role,
        resolver.resolveExport(record[role]),
      ]),
    );
  return Object.fromEntries(
    ["input", "transform", "output", "consumer"].map((role) => [
      role,
      role === "consumer"
        ? resolver.resolveProofConsumer(record[role])
        : resolver.resolveProofExport(record[role]),
    ]),
  );
}

function ownershipReasons(subject, record, roles) {
  const reasons = [];
  for (const role of ["input", "transform", "output", "consumer"]) {
    const facts = roles[role];
    const expectedOwner = role === "consumer" ? record.consumer.owner : record.owner;
    if (facts.identities.some((identity) => identity.owner !== expectedOwner))
      reasons.push("foreign-responsibility-owner");
    if (
      facts.identities.some(
        (identity) =>
          !inventoryFile(subject, identity.producer.path)?.production &&
          !(record.kind === "diagnostic-checker" && role === "consumer"),
      )
    )
      reasons.push("nonproduction-responsibility-source");
    if (role !== "consumer" && facts.signatures.length !== 1)
      reasons.push("ambiguous-responsibility-signature");
  }
  return reasons;
}

function diagnosticIdentityReasons(record, roles, reasons) {
  if (record.kind === "diagnostic-checker") {
    const producer = JSON.stringify(
      roles.input.identities.map(({ owner, producer }) => ({ owner, producer })),
    );
    if (
      [roles.transform, roles.output].some(
        (facts) =>
          JSON.stringify(facts.identities.map(({ owner, producer }) => ({ owner, producer }))) !==
          producer,
      )
    )
      reasons.push("mismatched-diagnostic-producer");
    if (record.consumer.owner !== record.owner) reasons.push("foreign-responsibility-owner");
  }
}

function signatureReasons(record, roles) {
  const reasons = [];
  diagnosticIdentityReasons(record, roles, reasons);
  const output = roles.output.signatures[0]?.result.kind;
  if (record.kind === "validator" && ["unknown", "any"].includes(output))
    reasons.push("unchecked-validator-output");
  if (
    record.kind === "validator" &&
    roles.output.signatures[0]?.result.indexes?.some((type) =>
      ["unknown", "any"].includes(type.kind),
    )
  )
    reasons.push("unchecked-validator-dictionary");
  if (
    record.rules.includes("anti-slop/no-unknown-returns") &&
    roles.consumer.signatures.some((signature) =>
      ["unknown", "any"].includes(signature.result.kind),
    )
  )
    reasons.push("unknown-domain-output");
  return reasons;
}

function consumerSignatureReason(facts) {
  if (facts.signatures.length === 0) return "noncallable-responsibility-consumer";
  if (facts.signatures.length !== 1) return "ambiguous-responsibility-consumer";
  return null;
}

function structuralStatus(reasons, consumerReason) {
  if (reasons.length) return "invalid";
  return consumerReason ? "incomplete" : "ready";
}

function proofFacts(subject, resolver, record) {
  return record.proofs.map((path) => {
    const file = inventoryFile(subject, path);
    if (!file) throw new TypeError("unaccounted-responsibility-proof");
    return { ...resolver.sourceIdentity(path), executed: false };
  });
}

function responsibilitySlots(resolver, record, roles) {
  if (roles.input.identities.length !== 1 || roles.output.identities.length !== 1)
    throw new TypeError("ambiguous-responsibility-producer");
  const input = resolver.callableSlots(roles.input.identities[0]);
  const parameter = input.parameters[record.input.parameterIndex];
  if (parameter?.type.kind !== "unknown")
    throw new TypeError("unresolved-responsibility-raw-parameter");
  const slots = resolver.rawCheckingSlots(roles.input.identities[0], record.input.parameterIndex);
  if (record.kind === "structural-redactor") {
    const output = resolver.callableSlots(roles.output.identities[0]);
    if (output.result?.type.kind !== "unknown")
      throw new TypeError("unresolved-structural-redactor-return");
    slots.push({ ...output.result, rule: "anti-slop/no-unknown-returns" });
  }
  return slots.filter((slot) => record.rules.includes(slot.rule));
}

function bindConsumer(resolver, record, roles, consumerReason, reasons) {
  if (consumerReason || reasons.length) return null;
  const binding =
    record.kind === "diagnostic-checker"
      ? resolver.diagnosticBinding(record.consumer, roles.transform.identities[0])
      : resolver.consumerCalls(
          roles.consumer.identities[0],
          roles.transform.identities[0],
          record.consumer.owner,
        );
  if (!binding.bound) reasons.push("unbound-responsibility-consumer");
  return binding;
}

function assessRecord(subject, resolver, record, files) {
  const selected = new Set(files.map((file) => file.path));
  const paths = [record.input, record.transform, record.output, record.consumer].map(
    (selector) => selector.consumerPath,
  );
  if (record.kind !== "diagnostic-checker" && paths.some((path) => !selected.has(path)))
    return pendingRecord(record, "incomplete", ["partial-responsibility-scope"]);
  try {
    const roles = resolveRoles(resolver, record);
    if (
      record.kind === "diagnostic-checker" &&
      !roles.input.identities.every((identity) => selected.has(identity.producer.path))
    )
      return pendingRecord(record, "incomplete", ["partial-responsibility-scope"]);
    const reasons = [
      ...ownershipReasons(subject, record, roles),
      ...signatureReasons(record, roles),
    ];
    const consumerReason = consumerSignatureReason(roles.consumer);
    const binding = bindConsumer(resolver, record, roles, consumerReason, reasons);
    const proofs = proofFacts(subject, resolver, record);
    const slots =
      reasons.length || consumerReason ? [] : responsibilitySlots(resolver, record, roles);
    resolver.assertCurrent();
    return {
      ...pendingRecord(
        record,
        structuralStatus(reasons, consumerReason),
        consumerReason ? [...reasons, consumerReason] : reasons,
      ),
      roles,
      ...(binding ? { consumerBinding: binding } : {}),
      proofs,
      slots,
    };
  } catch {
    return pendingRecord(record, "incomplete", ["unresolved-responsibility-facts"]);
  }
}

function adaptedFinding(finding, assessments) {
  for (const assessment of assessments) {
    if (assessment.structural !== "ready") continue;
    const slot = assessment.slots.find(
      (candidate) =>
        candidate.path === finding.path &&
        candidate.rule === finding.rule &&
        candidate.line === finding.line &&
        candidate.column === finding.column,
    );
    if (slot) return { finding, responsibilityId: assessment.id, slot };
  }
  return null;
}

export function adaptResponsibilityDiagnostics(assessed, responsibilities) {
  const adaptations = [];
  const violations = assessed.violations.filter((finding) => {
    const adaptation = adaptedFinding(finding, responsibilities.assessments);
    if (!adaptation) return true;
    adaptations.push(adaptation);
    return false;
  });
  return { ...assessed, violations, adaptations };
}

function pendingRecord(record, structural, reasons) {
  const rejected = structural === "invalid";
  return {
    id: record.id,
    owner: record.owner,
    kind: record.kind,
    rules: record.rules,
    structural,
    semantic: rejected ? "rejected" : "pending",
    reasons: [...new Set(reasons)],
    obligations: rejected ? [] : ["runtime-proof-not-evaluated", "consumer-proof-not-evaluated"],
  };
}

export function assessPolicyResponsibilities(subject, policy, files = subject.inventory.files) {
  const manifest = new Map();
  for (const record of policy.responsibilities ?? []) {
    if (record.kind !== "diagnostic-checker") continue;
    const owner = subject.inventory.packages.find((entry) => entry.name === record.consumer.owner);
    if (!owner || !record.proofs.includes(record.consumer.consumerPath)) continue;
    const paths = manifest.get(owner.directory) ?? [];
    paths.push(record.consumer.consumerPath);
    manifest.set(owner.directory, [...new Set(paths)].sort(compareStrings));
  }
  const resolver = createSymbolResolver(
    subject,
    {},
    [...manifest].map(([owner, paths]) => ({ owner, paths })),
  );
  try {
    const assessments = (policy.responsibilities ?? []).map((record) =>
      assessRecord(subject, resolver, record, files),
    );
    resolver.assertCurrent();
    const count = (key, value) => assessments.filter((record) => record[key] === value).length;
    return {
      assessments,
      counts: {
        ready: count("structural", "ready"),
        incomplete: count("structural", "incomplete"),
        invalid: count("structural", "invalid"),
        qualified: count("semantic", "qualified"),
        pending: count("semantic", "pending"),
        rejected: count("semantic", "rejected"),
      },
    };
  } finally {
    resolver.close();
  }
}
