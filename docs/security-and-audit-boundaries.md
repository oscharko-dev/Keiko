# Security Boundaries

Keiko is a local coding assistant. It is designed for bounded, auditable work in regulated
engineering environments, not for standing or unbounded authority or hosted multi-user operation.

## Enforced controls

| Area                  | Boundary                                                                                                                                                                                                                                                                                                                                                                                                            |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UI network surface    | The product binds to loopback only. No remote listener is part of the supported runtime model.                                                                                                                                                                                                                                                                                                                      |
| Model access          | Productive model calls route through `@oscharko-dev/keiko-model-gateway` only. UI and workspace surfaces do not bypass the gateway or import provider SDKs directly.                                                                                                                                                                                                                                                |
| Workspace containment | Repository reads and writes stay inside the selected project path and pass through containment and `realpath` checks.                                                                                                                                                                                                                                                                                               |
| Command execution     | Verification and tool execution route through `@oscharko-dev/keiko-tools` terminal-policy allowlists. Arbitrary shell execution is not an approved UI or workspace surface.                                                                                                                                                                                                                                         |
| Patch application     | Generated patches enter governed preflight. Review occurs when the shared mode/resource/risk policy returns `approval-required`; policy-allowed patches may apply inside a validated Authority Envelope without another prompt. Structural, containment, sensitive-path, secret, budget, transaction, and reconciliation gates remain mandatory.                                                                    |
| Evidence              | Evidence is redacted before persistence and written only through approved evidence surfaces. Some evidence sub-manifests, including Quality Intelligence and Prompt Enhancement records, are integrity-hashed and fail reads when the hash no longer matches; this is tamper-evident, not tamper-proof, and does not encrypt the underlying local files.                                                            |
| Durable UI state      | Raw secrets, customer data, private logs, and evidence payloads must not be stored in durable UI state. UI persistence may store only approved metadata such as evidence references.                                                                                                                                                                                                                                |
| Undo scope            | Undo/redo must not rewrite evidence, applied patches, verification records, or model-call records.                                                                                                                                                                                                                                                                                                                  |
| Credentials           | API tokens and related secrets are accepted only from local configuration, local environment, or explicit local setup flows. Persisted local credentials (model-gateway API keys, Figma PAT) are sealed with AES-256-GCM in local vaults; `keiko.config.json` holds only references, never plaintext secrets (ADR-0046). They are never returned to the browser, logged intentionally, or serialized into evidence. |
| Memory                | The memory vault is local-only and uses approved Keiko state locations. Workspace-local memory paths are rejected. Audit events are redacted before persistence.                                                                                                                                                                                                                                                    |

## Workspace trust-boundary rules

ADR-0030 adds five non-negotiable workspace rules:

1. No UI bypass of the Model Gateway.
2. No escape of workspace path containment.
3. No arbitrary shell commands.
4. No undo rewrite of evidence, patches, verification, or model-call records.
5. No raw secrets or token-bearing artifacts in durable UI state.

These rules are enforced by the existing package boundaries, descriptor validation, terminal policy,
redaction primitives, and architecture/test gates.

## Operator responsibilities

- Run Keiko only on repositories you are allowed to inspect.
- Keep tokens, gateway config files, `.env`, `.keiko/`, and exported evidence out of version control unless your process explicitly requires them.
- Review every diff that policy marks `approval-required`; inspect allowed changes through the
  Changes and bounded audit surfaces as part of the delivery process.
- Treat evidence and memory diagnostics as review material and handle them under your delivery process.
- Stop immediately if a credential appears in output or evidence.

## Known limits

- Keiko is not a sandbox and does not provide OS-level isolation.
- Verification can execute repository-authored scripts.
- Evidence and workflow artifacts are ordinary local files. Most are not encrypted; Quality Intelligence and Prompt Enhancement sub-manifests are hash-checked on read for tamper evidence, but a local attacker can still delete, replace, or roll back files outside Keiko's control.
- The workspace foundation does not introduce WebRTC; that surface is not approved.
- Keiko is not a hosted web service and does not provide multi-user authentication.

## Practical rule

Use Keiko as a bounded coding agent under one of the three confirmed autonomy modes. Do not treat
**Full access** as autonomous release, merge, authority-widening, or secret-handling permission.
