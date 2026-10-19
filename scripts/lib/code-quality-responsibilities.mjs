import {
  executeResponsibilityProofs,
  responsibilityProofToolIdentity,
} from "./code-quality-responsibility-proofs.mjs";
import {
  createSymbolResolver,
  exportFactKey,
  collectiveHelperBudgetDetails,
} from "./code-quality-symbols.mjs";
import { compareStrings } from "./compare-strings.mjs";

function inventoryFile(subject, path) {
  return subject.inventory.files.find((file) => file.path === path);
}

function proofConsumerKind(record) {
  return [
    "diagnostic-checker",
    "public-parser",
    "raw-own-property-reader",
    "raw-property-observation",
    "typed-parameter-recheck",
    "raw-canonical-json-decoder",
  ].includes(record.kind);
}

export function resolveRoles(resolver, record) {
  const proof = proofConsumerKind(record);
  const exports = new Map();
  return Object.fromEntries(
    ["input", "transform", "output", "consumer"].map((role) => {
      const selector = record[role];
      if (role === "consumer")
        return [
          role,
          proof ? resolver.resolveProofConsumer(selector) : resolver.resolveExport(selector),
        ];
      const key = exportFactKey(selector, proof);
      if (key !== undefined && exports.has(key)) return [role, structuredClone(exports.get(key))];
      const facts = proof
        ? resolver.resolveProofExport(selector)
        : resolver.resolveExport(selector);
      if (key !== undefined) exports.set(key, structuredClone(facts));
      return [role, structuredClone(facts)];
    }),
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
          !(proofConsumerKind(record) && role === "consumer"),
      )
    )
      reasons.push("nonproduction-responsibility-source");
    if (role !== "consumer" && facts.signatures.length !== 1)
      reasons.push("ambiguous-responsibility-signature");
  }
  return reasons;
}

function pairedProofProducer(record) {
  return ["raw-own-property-reader", "raw-canonical-json-decoder"].includes(record.kind);
}

function canonicalDecoderIdentityReasons(record, roles, reasons) {
  if (record.kind !== "raw-canonical-json-decoder") return;
  if (JSON.stringify(roles.input.identities) !== JSON.stringify(roles.transform.identities))
    reasons.push("mismatched-canonical-decoder-producer");
  if (record.consumer.owner !== record.owner) reasons.push("foreign-responsibility-owner");
}

function diagnosticIdentityReasons(record, roles, reasons) {
  if (proofConsumerKind(record) && !pairedProofProducer(record)) {
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
      reasons.push(
        record.kind === "public-parser"
          ? "mismatched-public-parser-producer"
          : "mismatched-diagnostic-producer",
      );
    if (record.consumer.owner !== record.owner) reasons.push("foreign-responsibility-owner");
  }
}

function rawReaderIdentityReasons(record, roles, reasons) {
  if (record.kind !== "raw-own-property-reader") return;
  const identity = (role) =>
    JSON.stringify(roles[role].identities.map(({ owner, producer }) => ({ owner, producer })));
  if (identity("input") !== identity("transform")) reasons.push("mismatched-raw-reader-producer");
  if (record.consumer.owner !== record.owner) reasons.push("foreign-responsibility-owner");
  if (roles.input.signatures[0]?.result.kind !== "unknown") reasons.push("nonraw-reader-output");
}

function signatureReasons(record, roles) {
  const reasons = [];
  diagnosticIdentityReasons(record, roles, reasons);
  rawReaderIdentityReasons(record, roles, reasons);
  canonicalDecoderIdentityReasons(record, roles, reasons);
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
  if (record.kind === "raw-own-property-reader")
    return [resolver.rawReaderFacts(roles.input.identities[0]).slot];
  if (record.kind === "raw-property-observation")
    return resolver.propertyObservationFacts(roles.input.identities[0]).slots;
  if (record.kind === "typed-parameter-recheck")
    return resolver.typedRecheckFacts(roles.input.identities[0], record.input.parameterIndex).slots;
  if (record.kind === "raw-canonical-json-decoder")
    return [
      resolver.canonicalDecoderFacts(roles.input.identities[0], roles.output.identities[0]).slot,
    ];
  return rawResponsibilitySlots(resolver, record, roles);
}

function rawResponsibilitySlots(resolver, record, roles) {
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

function publicParserConsumer(resolver, record, roles, reasons) {
  const binding = resolver.parserBinding(record.consumer, roles.transform.identities[0]);
  if (binding.status === "invalid") reasons.push("unchecked-public-parser-output");
  return binding;
}

function rawReaderConsumer(resolver, record, roles, reasons) {
  const witness = resolver.consumerCalls(
    roles.output.identities[0],
    roles.input.identities[0],
    record.owner,
  );
  const binding = resolver.parserBinding(record.consumer, roles.output.identities[0]);
  if (binding.status === "invalid") reasons.push("unchecked-raw-reader-validator-output");
  return {
    ...binding,
    bound: binding.bound && witness.bound,
    status: binding.status === "ready" && !witness.bound ? "incomplete" : binding.status,
    readerWitness: witness,
  };
}

function typedOrCanonicalConsumer(resolver, record, roles) {
  return record.kind === "typed-parameter-recheck"
    ? resolver.typedRecheckBinding(record.consumer, roles.transform.identities[0])
    : resolver.canonicalDecoderBinding(
        record.consumer,
        roles.transform.identities[0],
        roles.output.identities[0],
      );
}

function bindConsumer(resolver, record, roles, consumerReason, reasons) {
  if (consumerReason || reasons.length) return null;
  if (record.kind === "raw-own-property-reader")
    return rawReaderConsumer(resolver, record, roles, reasons);
  if (record.kind === "raw-property-observation") {
    const binding = resolver.observationBinding(record.consumer, roles.transform.identities[0]);
    if (!binding.bound) reasons.push("unsupported-property-observation-consumer");
    return binding;
  }
  if (record.kind === "public-parser")
    return publicParserConsumer(resolver, record, roles, reasons);
  if (["typed-parameter-recheck", "raw-canonical-json-decoder"].includes(record.kind))
    return typedOrCanonicalConsumer(resolver, record, roles);
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

function bindingConsumerReason(record, binding, consumerReason) {
  if (binding?.status !== "incomplete") return consumerReason;
  if (record.kind === "raw-own-property-reader")
    return binding.readerWitness.bound
      ? "unsupported-raw-reader-public-proof-binding"
      : "unsupported-raw-reader-validator-witness";
  if (record.kind === "typed-parameter-recheck") return "unsupported-typed-recheck-binding";
  if (record.kind === "raw-canonical-json-decoder") return "unsupported-canonical-decoder-binding";
  return record.kind === "public-parser" ? "unsupported-public-parser-binding" : consumerReason;
}

function proofScopeIdentities(record, roles) {
  return pairedProofProducer(record)
    ? [...roles.input.identities, ...roles.output.identities]
    : roles.input.identities;
}

function assessRecord(subject, resolver, record, files) {
  const selected = new Set(files.map((file) => file.path));
  const paths = [record.input, record.transform, record.output, record.consumer].map(
    (selector) => selector.consumerPath,
  );
  if (!proofConsumerKind(record) && paths.some((path) => !selected.has(path)))
    return pendingRecord(record, "incomplete", ["partial-responsibility-scope"]);
  try {
    const roles = resolveRoles(resolver, record);
    if (
      proofConsumerKind(record) &&
      !proofScopeIdentities(record, roles).every((identity) => selected.has(identity.producer.path))
    )
      return pendingRecord(record, "incomplete", ["partial-responsibility-scope"]);
    const reasons = [
      ...ownershipReasons(subject, record, roles),
      ...signatureReasons(record, roles),
    ];
    const signatureReason = consumerSignatureReason(roles.consumer);
    const binding = bindConsumer(resolver, record, roles, signatureReason, reasons);
    const consumerReason = bindingConsumerReason(record, binding, signatureReason);
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
  const collective = collectiveAdaptation(finding, assessments);
  if (collective) return collective;
  for (const assessment of assessments) {
    if (assessment.structural !== "ready") continue;
    if (
      [
        "raw-own-property-reader",
        "raw-property-observation",
        "typed-parameter-recheck",
        "raw-canonical-json-decoder",
      ].includes(assessment.kind) &&
      assessment.semantic !== "qualified"
    )
      continue;
    const slot = assessment.slots.find(
      (candidate) =>
        candidate.path === finding.path &&
        candidate.rule === finding.rule &&
        candidate.line === finding.line &&
        candidate.column === finding.column,
    );
    if (slot && objectFormQualified(assessment, slot, assessments))
      return { finding, responsibilityId: assessment.id, slot };
  }
  return null;
}

function canonicalObjectIdentity(identity) {
  return identity && { owner: identity.owner, producer: identity.producer };
}

function objectRootIdentity(root, record, slot) {
  return (
    root.index === 0 &&
    root.identity?.producer?.path === slot.path &&
    root.identity.owner === record.owner &&
    record.roles?.input?.identities?.length === 1 &&
    JSON.stringify(canonicalObjectIdentity(root.identity)) ===
      JSON.stringify(canonicalObjectIdentity(record.roles.input.identities[0]))
  );
}

function objectRootReadiness(record, slot) {
  return (
    record.kind === "public-parser" &&
    record.structural === "ready" &&
    record.semantic === "qualified" &&
    record.owner === slot.producerIdentity?.owner &&
    Array.isArray(record.rules) &&
    record.rules.includes("anti-slop/no-object-parameters") &&
    record.consumerBinding?.bound === true &&
    record.consumerBinding.status === "ready"
  );
}

function objectProofSelector(entry) {
  return (
    entry &&
    Object.keys(entry).sort(compareStrings).join(",") === "path,testName" &&
    typeof entry.path === "string" &&
    entry.path.length > 0 &&
    typeof entry.testName === "string" &&
    entry.testName.length > 0
  );
}

function objectProofsCompleted(required, record) {
  if (
    !Array.isArray(required) ||
    required.length === 0 ||
    new Set(required.map((entry) => JSON.stringify(entry))).size !== required.length
  )
    return false;
  if (
    !required.every(
      (entry) =>
        objectProofSelector(entry) &&
        Array.isArray(record.proofs) &&
        record.proofs.some((proof) => proof.path === entry.path && proof.executed === true),
    )
  )
    return false;
  return (
    JSON.stringify(record.proofAssertions) ===
    JSON.stringify(required.map((entry) => ({ ...entry, status: "passed" })))
  );
}

function completedObjectRoot(root, assessments, slot) {
  const matches = assessments.filter((entry) => entry.id === root.recordId);
  if (matches.length !== 1) return false;
  const record = matches[0];
  return (
    objectRootReadiness(record, slot) &&
    objectRootIdentity(root, record, slot) &&
    objectProofsCompleted(root.proofAssertions, record)
  );
}

function objectComponentRoots(roots) {
  if (
    !Array.isArray(roots) ||
    roots.length !== 3 ||
    roots.some((root) => !root || typeof root.recordId !== "string" || root.recordId.length === 0)
  )
    return false;
  return (
    new Set(roots.map((root) => root.recordId)).size === 3 &&
    new Set(roots.map((root) => JSON.stringify(canonicalObjectIdentity(root.identity)))).size ===
      3 &&
    roots.filter((root) => root.origin === "container").length === 2 &&
    roots.filter((root) => root.origin === "answers").length === 1
  );
}

function objectFormQualified(assessment, slot, assessments) {
  if (slot.rule !== "anti-slop/no-object-parameters") return true;
  if (assessment.kind !== "public-parser") return slot.objectForm === undefined;
  if (slot.objectForm !== "json-utf8-byte-measurement") return false;
  const roots = slot.componentRoots;
  if (!objectComponentRoots(roots)) return false;
  const expected = roots
    .filter((root) => slot.index === 0 || (slot.index === 1 && root.origin === "container"))
    .map((root) => root.recordId)
    .sort(compareStrings);
  return (
    expected.length > 0 &&
    assessment.id === expected[0] &&
    JSON.stringify(expected) === JSON.stringify(slot.contributingResponsibilityIds) &&
    roots.every((root) => completedObjectRoot(root, assessments, slot))
  );
}

function collectiveAdaptation(finding, assessments) {
  for (const assessment of assessments) {
    if (assessment.kind !== "public-parser" || assessment.structural !== "ready") continue;
    const slot = assessment.slots.find(
      (candidate) =>
        candidate.contributingResponsibilityIds?.[0] === assessment.id &&
        candidate.path === finding.path &&
        candidate.rule === finding.rule &&
        candidate.line === finding.line &&
        candidate.column === finding.column,
    );
    if (slot && objectFormQualified(assessment, slot, assessments))
      return { finding, responsibilityId: assessment.id, slot };
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

function addDeclaredProofPaths(subject, manifest, record) {
  for (const path of record.proofs) {
    const owner = subject.inventory.packages.find((entry) =>
      path.startsWith(`${entry.directory}/`),
    );
    const directory = owner?.directory ?? "";
    manifest.set(
      directory,
      [...new Set([...(manifest.get(directory) ?? []), path])].sort(compareStrings),
    );
  }
}

function responsibilityResolver(subject, policy, executeProofs = false) {
  const manifest = new Map();
  for (const record of policy.responsibilities ?? []) {
    if (executeProofs) {
      addDeclaredProofPaths(subject, manifest, record);
      continue;
    }
    if (!proofConsumerKind(record)) continue;
    const owner = subject.inventory.packages.find((entry) => entry.name === record.consumer.owner);
    if (!owner || !record.proofs.includes(record.consumer.consumerPath)) continue;
    const paths = manifest.get(owner.directory) ?? [];
    paths.push(record.consumer.consumerPath);
    manifest.set(owner.directory, [...new Set(paths)].sort(compareStrings));
  }
  return createSymbolResolver(
    subject,
    {},
    [...manifest].map(([owner, paths]) => ({ owner, paths })),
  );
}

function responsibilityAssessment(subject, policy, files, resolver) {
  const assessments = (policy.responsibilities ?? []).map((record) =>
    assessRecord(subject, resolver, record, files),
  );
  joinPublicParserSlots(policy, assessments, resolver);
  return assessments;
}

function collectiveParserGroups(policy, assessments) {
  const groups = new Map();
  for (const record of policy.responsibilities ?? []) {
    const assessment = assessments.find((entry) => entry.id === record.id);
    if (
      (record.kind !== "public-parser" && record.kind !== "diagnostic-checker") ||
      assessment.structural !== "ready" ||
      !record.proofAssertions?.length
    )
      continue;
    const identity = assessment.roles.input.identities[0];
    for (const rule of record.rules) {
      const key = JSON.stringify([identity.owner, identity.producer.path, rule]);
      const group = groups.get(key) ?? { rule, roots: [] };
      group.roots.push({ identity, index: record.input.parameterIndex, recordId: record.id });
      groups.set(key, group);
    }
  }
  return groups;
}

function joinedObjectSlots(result, policy, assessments, roots, rule, resolver) {
  resolver.assertCurrent();
  if (
    result.status === "withheld" &&
    result.reason === "unsupported-json-byte-form" &&
    result.slots.length === 0
  ) {
    withholdObjectForm(assessments, roots, rule);
    return [];
  }
  if (
    result.status !== "recognized" ||
    result.form !== "json-utf8-byte-measurement" ||
    result.slots.length !== 2
  )
    throw new TypeError("unresolved-json-byte-form");
  return result.slots.map((slot) => objectFormProofs(slot, policy));
}

function joinedSlots(policy, assessments, resolver, roots, rule) {
  try {
    if (rule === "anti-slop/no-object-parameters")
      return joinedObjectSlots(
        resolver.collectiveJsonByteMeasurement(roots),
        policy,
        assessments,
        roots,
        rule,
        resolver,
      );
    return resolver.collectiveRawCheckingSlots(roots, rule);
  } catch (error) {
    const capacity = collectiveHelperBudgetDetails(error);
    if (!capacity) throw error;
    resolver.assertCurrent();
    withholdCollectiveGroup(assessments, roots, rule, capacity);
    return [];
  }
}

function joinPublicParserSlots(policy, assessments, resolver) {
  const groups = collectiveParserGroups(policy, assessments);
  for (const { roots, rule } of groups.values()) {
    // A single root already has the unchanged legacy closure; only a join needs another graph.
    if (roots.length < 2 && rule !== "anti-slop/no-object-parameters") continue;
    for (const slot of joinedSlots(policy, assessments, resolver, roots, rule)) {
      const assessment = assessments.find(
        (entry) => entry.id === slot.contributingResponsibilityIds[0],
      );
      const existing = assessment.slots.findIndex(
        (entry) =>
          entry.path === slot.path && entry.rule === slot.rule && entry.start === slot.start,
      );
      if (existing === -1) assessment.slots.push(slot);
      else assessment.slots[existing] = slot;
    }
  }
}

function objectFormProofs(slot, policy) {
  return {
    ...slot,
    componentRoots: slot.componentRoots.map((root) => {
      const records = policy.responsibilities.filter((record) => record.id === root.recordId);
      if (records.length !== 1 || !records[0].proofAssertions?.length)
        throw new TypeError("unresolved-json-byte-component");
      return {
        ...root,
        proofAssertions: records[0].proofAssertions.map((selector) => ({ ...selector })),
      };
    }),
  };
}

function withholdObjectForm(assessments, roots, rule) {
  const identity = roots[0].identity;
  const form = {
    form: "json-utf8-byte-measurement",
    status: "withheld",
    reason: "unsupported-json-byte-form",
    owner: identity.owner,
    sourcePath: identity.producer.path,
    rule,
    requestedResponsibilityIds: roots.map((root) => root.recordId).sort(compareStrings),
  };
  for (const root of roots) {
    const record = assessments.find((entry) => entry.id === root.recordId);
    record.objectForms = [...(record.objectForms ?? []), { ...form }].sort((a, b) =>
      compareStrings(JSON.stringify(a), JSON.stringify(b)),
    );
  }
}

function withholdCollectiveGroup(assessments, roots, rule, capacity) {
  const identity = roots[0].identity;
  const closure = {
    status: "withheld",
    reason: "collective-helper-budget-exhausted",
    owner: identity.owner,
    sourcePath: identity.producer.path,
    rule,
    rootCount: roots.length,
    limit: capacity.limit,
    observedCount: capacity.observedCount,
  };
  for (const { recordId } of roots) {
    const assessment = assessments.find((entry) => entry.id === recordId);
    assessment.helperClosures = [...(assessment.helperClosures ?? []), { ...closure }].sort(
      (left, right) => compareStrings(JSON.stringify(left), JSON.stringify(right)),
    );
  }
}

function responsibilityReport(assessments) {
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
}

export function assessPolicyResponsibilities(subject, policy, files = subject.inventory.files) {
  const resolver = responsibilityResolver(subject, policy);
  try {
    const assessments = responsibilityAssessment(subject, policy, files, resolver);
    resolver.assertCurrent();
    return responsibilityReport(assessments);
  } finally {
    resolver.close();
  }
}

function proofRuntimeWitness(subject, resolver, assessments) {
  const producers = new Set(
    assessments.flatMap((record) =>
      (pairedProofProducer(record)
        ? [...record.roles.input.identities, ...record.roles.output.identities]
        : record.roles.input.identities
      ).map((identity) => identity.producer.path),
    ),
  );
  if (producers.size === 0) throw new TypeError("semantic-proof-runtime-unavailable");
  const outputs = [...subject.outputs].filter(([, source]) => producers.has(source));
  for (const producer of producers) {
    const paths = outputs.filter(([, source]) => source === producer).map(([path]) => path);
    if (
      !paths.some((path) => /\.[cm]?js$/u.test(path)) ||
      !paths.some((path) => /\.d\.[cm]?ts$/u.test(path))
    )
      throw new TypeError("semantic-proof-runtime-unavailable");
  }
  return outputs.map(([path]) => resolver.sourceIdentity(path));
}

function completedResponsibility(record, execution) {
  const observation = execution.find((entry) => entry.id === record.id);
  if (!observation) throw new TypeError("semantic-proof-assertion-missing");
  return {
    ...record,
    semantic: "qualified",
    obligations: [],
    proofs: record.proofs.map((proof) => ({
      ...proof,
      executed: observation.executedPaths.includes(proof.path),
    })),
    proofAssertions: observation.assertions,
  };
}

export async function qualifyPolicyResponsibilities(
  subject,
  policy,
  files = subject.inventory.files,
) {
  const resolver = responsibilityResolver(subject, policy, true);
  try {
    const assessments = responsibilityAssessment(subject, policy, files, resolver);
    if (assessments.length === 0 || assessments.some((record) => record.structural !== "ready"))
      return {
        ...responsibilityReport(assessments),
        execution: { status: "failed", reason: "semantic-proof-structural-incomplete" },
      };
    const tools = responsibilityProofToolIdentity(subject.root);
    const runtime = proofRuntimeWitness(subject, resolver, assessments);
    resolver.assertCurrent();
    const execution = await executeResponsibilityProofs(subject.root, policy.responsibilities);
    resolver.assertCurrent();
    if (
      JSON.stringify(tools) !== JSON.stringify(responsibilityProofToolIdentity(subject.root)) ||
      JSON.stringify(runtime) !==
        JSON.stringify(proofRuntimeWitness(subject, resolver, assessments))
    )
      throw new TypeError("semantic-proof-subject-changed");
    return {
      ...responsibilityReport(
        assessments.map((record) => completedResponsibility(record, execution.records)),
      ),
      execution: {
        status: "passed",
        invocationCount: 1,
        tools,
        runtime,
        process: execution.process,
      },
    };
  } finally {
    resolver.close();
  }
}
