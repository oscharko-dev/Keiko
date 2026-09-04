// Schema requirements for the versioned architecture document, not a runtime catalog.
export const REQUIRED_OWNERS = [
  "genericTypes",
  "digestPrimitives",
  "descriptorsCompiler",
  "handlers",
  "policy",
  "runtimeBinding",
  "adapterProjections",
  "workspaceSearch",
  "evidence",
];
export const REQUIRED_AXES = [
  "toolRef",
  "alias",
  "catalogRevision",
  "profile",
  "adapterDialect",
  "adapterRuntime",
  "descriptorDigest",
  "projectionDigest",
];
export const REQUIRED_STATUSES = [
  "completed",
  "denied",
  "invalid",
  "busy",
  "cancelled",
  "timeout",
  "failed",
];
export const REQUIRED_PHASES = [
  "projection",
  "bind-ready",
  "bind-unavailable",
  "invocation-started",
  "terminal",
  "discarded",
];
export const REQUIRED_CONSUMERS = [
  "3406",
  "3412",
  "3413",
  "3409",
  "3386",
  "3414",
  "3407",
  "3408",
  "3415",
  "3390",
];
export const REQUIRED_BOUNDS = [
  "maxArgumentBytes",
  "maxResultBytes",
  "maxSchemaDepth",
  "maxObjectKeys",
  "maxArrayItems",
  "maxStringBytes",
  "maxCursorBytes",
  "maxCursorLifetimeMs",
  "maxCompatibilityLifetimeMs",
  "maxQueryCharacters",
  "maxSearchHits",
  "maxSearchFiles",
  "maxSearchFileBytes",
  "maxSearchDurationMs",
  "maxSnippetBytes",
  "maxSearchOutputBytes",
  "maxSearchGlobsPerList",
  "maxSearchGlobCharacters",
  "maxSearchInventory",
  "maxSearchYieldCandidates",
];
export const REQUIRED_INTERFACE_FIELDS = {
  ToolRef: "canonicalId,contractVersion",
  ToolDescriptor:
    "toolRef,description,inputSchema,resultSchema,effects,actionMapping,policyReferences,handlerRequirement,bounds,idempotency,cancellation,descriptorDigest",
  CatalogProfile:
    "profile,catalogRevision,toolRefs,nativeExtensions,adapterDialect,adapterRuntime,compatibility",
  CompiledToolProjection:
    "catalogRevision,profile,adapterDialect,adapterRuntime,tools,nativeExtensions,projectionDigest",
  ToolResultEnvelope:
    "schemaVersion,invocationId,toolRef,projectionDigest,status,reason,effectStarted,metrics,page,data",
  CatalogManifest:
    "schemaVersion,catalogRevision,profile,projectionDigest,toolRefs,descriptorDigests,bounds,compatibility",
  LifecycleOperationContract: "schemaVersion,phase,op,requiredFields,provenance",
  CatalogToolBinder: "projection,handlerBindings,authorityPort,budgetPort,approvalPort,logPort",
  BoundToolSet: "catalogRevision,profile,projectionDigest,handlerSetDigest,readiness",
  OfferedToolSet: "binding,offerId,toolRefs,expiresAt",
  DispatchContext:
    "binding,offerId,invocationId,correlationId,workspaceIdentity,workspaceRevision,authority,action,idempotencyKey,signal,deadlineAt,budgetPort",
  CursorBinding:
    "toolRef,requestDigest,workspaceIdentity,workspaceRevision,profile,projectionDigest,expiresAt,budgetReservationId,nonce,pageSequence",
  InvocationReceipt:
    "invocationId,reservationId,settlementId,budgetDisposition,effectStarted,status",
  BoundToolInvocation: "kind,toolRef,projectionDigest,offerId,arguments",
  LegacyToolInvocation: "kind,name,arguments,legacyBinding",
  HarnessRunBinding: "runId,signal,budgetPort,runCounters,runSettlement",
  H1Handler: "request,result,readiness,signal,containment,evidence",
  OpenCodeProjection: "projection,source,launchProfile,protocol,ipc,prompt,configuration",
  H1Provenance:
    "schemaVersion,integrationPr,sourceHead,treeDigest,verificationRef,reviewRef,catalogRevision,profile,projectionDigest,handlerSetDigest,currentHead",
  ChildProjection: "projection,boundInvocation,inheritedAuthority,budgetPort,signal,eventSink",
  EditorProjection: "projection,boundInvocation,activeSubset,policyPort,eventSink",
  CatalogCloseout:
    "schemaVersion,currentHead,artifactDigest,catalogRevision,profiles,projectionDigests,handlerSetDigests,h1EvidenceRef,h1EvidenceDigest,migrationCount,checks,platform,runtime",
};
export const REQUIRED_CONSUMER_INTERFACES = {
  3406: [
    "",
    "ToolRef,ToolDescriptor,CatalogProfile,CompiledToolProjection,ToolResultEnvelope,CatalogManifest",
  ],
  3412: ["", "LifecycleOperationContract"],
  3413: [
    "CompiledToolProjection,ToolResultEnvelope,LifecycleOperationContract",
    "CatalogToolBinder,BoundToolSet,OfferedToolSet,DispatchContext,CursorBinding,InvocationReceipt",
  ],
  3409: [
    "CatalogToolBinder,OfferedToolSet,InvocationReceipt,ToolResultEnvelope",
    "BoundToolInvocation,LegacyToolInvocation,HarnessRunBinding",
  ],
  3386: ["ToolRef", "H1Handler"],
  3414: [
    "CompiledToolProjection,BoundToolInvocation,CatalogToolBinder,H1Handler",
    "OpenCodeProjection,H1Provenance",
  ],
  3407: [
    "CompiledToolProjection,BoundToolInvocation,CatalogToolBinder,OpenCodeProjection",
    "ChildProjection",
  ],
  3408: ["CompiledToolProjection,BoundToolInvocation,CatalogToolBinder", "EditorProjection"],
  3415: [
    "CatalogManifest,LifecycleOperationContract,InvocationReceipt,HarnessRunBinding,OpenCodeProjection,H1Provenance,ChildProjection,EditorProjection",
    "CatalogCloseout",
  ],
  3390: ["CatalogCloseout", ""],
};
export const REQUIRED_STATUS_REASONS = {
  completed: "none",
  denied:
    "authority-invalid,authority-expired,authority-revoked,hard-denial,approval-required,approval-rejected,budget-exhausted,workspace-denied,effect-denied",
  invalid:
    "unknown-tool,unoffered-tool,ambiguous-alias,invalid-arguments,version-mismatch,projection-mismatch,unsupported-capability,cursor-invalid,cursor-expired,cursor-replayed,workspace-stale,replay-conflict,recovery-required",
  busy: "invocation-in-flight,capacity-exhausted",
  cancelled: "explicit-cancellation,parent-cancelled",
  timeout: "deadline-exceeded",
  failed:
    "handler-unavailable,handler-mismatch,handler-failed,result-contract-failed,effect-outcome-unknown,budget-port-failed",
};
