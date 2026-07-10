# Portable Production Signing Contract

This document is the authoritative, redacted operator contract for production signing of Keiko's
three portable release assets. It implements ADR-0121 D7 and is consumed by issues #2200, #2201, and
#2202. It does not replace the archive, manifest, or release-impact schema in the
[Portable Runtime Artifact Contract](portable-runtime-artifact-contract.md).

## Trust boundary

Production signing is available only to native jobs attached to the protected GitHub environment
`portable-release-signing`. Environment protection and workflow validation are independent controls;
both must pass.

Configure the environment to allow only selected tags matching `v*` and require the repository's
stable-release reviewers. Before a signing job references the environment or requests OIDC, the
workflow must also prove all of the following:

1. The event is a `push` of a tag; `workflow_dispatch` must never select the signing environment,
   receive its secrets, or request an Azure OIDC token.
2. `github.ref` starts with `refs/tags/v` and `github.ref_name` contains no hyphen.
3. `github.ref_name` equals `v<package.json.version>` and the package version itself is stable.
4. The checked-out commit equals the tagged commit and has passed the existing reviewed-release gates.

GitHub's Azure federated identity has this exact current trust tuple:

| Claim    | Required value                                                 |
| -------- | -------------------------------------------------------------- |
| Issuer   | `https://token.actions.githubusercontent.com`                  |
| Audience | `api://AzureADTokenExchange`                                   |
| Subject  | `repo:oscharko-dev/Keiko:environment:portable-release-signing` |

The subject is the required baseline and must not be broadened to a repository-, branch-, pull-request-,
or wildcard subject. If Azure/GitHub support for an immutable repository-id claim is adopted, add that
claim as a reviewed strengthening of this tuple before rollout; do not replace or relax the
environment-bound subject implicitly during a repository rename or transfer.

Keep workflow permissions empty by default. The protected Windows signing job receives only
`contents: read` and `id-token: write`; the protected macOS jobs receive only `contents: read` and do
not receive OIDC authority. Add another permission only when a child issue proves it is required at the
smallest job scope. Signing jobs never receive `contents: write`.

## Provider decisions

### Windows

- Provider: Azure Artifact Signing (formerly Trusted Signing).
- Account SKU: **Basic**.
- Certificate profile type: **PublicTrust**. `PublicTrust Test` is forbidden for production.
- Authentication: GitHub OIDC only; an Azure client secret is forbidden.
- Authorization: `Artifact Signing Certificate Profile Signer`, scoped only to the selected
  certificate-profile resource. Do not grant subscription, resource-group, account, or identity
  validation scope, and do not grant `Owner`, `Contributor`, or `Artifact Signing Identity Verifier`.
- Signing: SHA-256 file digest plus Azure's RFC 3161 timestamp service.
- Key custody: Azure-managed HSM; no exportable Windows signing key enters GitHub.
- Resource selection: the account and certificate-profile aliases select where the workflow signs;
  they are not embedded in the certificate and are not recoverable or durable signer identity.
- Identity binding: every signed PE must have a valid Public Trust/code-signing chain and the exact
  reviewed subscriber identity-validation EKU
  `1.3.6.1.4.1.311.97.<subscriber suffix>`. Azure rotates its short-lived leaf certificate, so leaf
  thumbprints, public keys, and certificate subjects must not be pinned. The native producer sets the
  existing `publisherChainVerified` input to `true` only when both checks pass on every PE.

Azure account/profile creation and organization validation are external prerequisites. The repository
workflow must remain testable without them and fail closed when they are unavailable.

### macOS

- Identity: Developer ID Application certificate with hardened runtime.
- Signing order: sign every embedded Mach-O and nested code object leaf-to-root, then sign the app
  bundle. Both `macos-arm64` and `macos-x64` are independently signed and verified.
- Notarization: a dedicated **team** App Store Connect API key assigned the least-privilege `Developer`
  role with `notarytool`. Individual keys, broader roles, and unrelated use are forbidden. Team keys
  apply across all apps and cannot be limited to Keiko, so the dedicated key and protected environment
  are the required isolation boundary.
- Completion: wait for an accepted notarization result, staple the ticket, validate the staple, and
  run the local Gatekeeper assessment before the archive is finalized.
- Identity binding: compare the verified signer with the reviewed
  `APPLE_DEVELOPER_ID_IDENTITY` alias and `APPLE_TEAM_ID`.

For each run, decode the P12 and P8 only beneath `$RUNNER_TEMP` into newly created owner-only files and
import the certificate into a newly created temporary keychain. Generate the keychain password at run
time, mask it immediately, and pass sensitive values through protected input channels rather than
command-line arguments or logs. Mask any derived sensitive value before use. An always-run cleanup step
must delete the temporary keychain and decoded files; cleanup failure fails the job and blocks upload.

## Configuration references

All references are scoped to `portable-release-signing`. Values are provisioned outside the repository.
Names may be documented; live values must not appear in commits, manifests, evidence, logs, issues, or
pull requests.

| Reference                                         | GitHub storage                 | Purpose                                          |
| ------------------------------------------------- | ------------------------------ | ------------------------------------------------ |
| `AZURE_CLIENT_ID`                                 | Environment variable (`vars`)  | OIDC workload application/client id              |
| `AZURE_TENANT_ID`                                 | Environment variable (`vars`)  | Azure tenant id                                  |
| `AZURE_SUBSCRIPTION_ID`                           | Environment variable (`vars`)  | Azure subscription selection                     |
| `AZURE_ARTIFACT_SIGNING_ENDPOINT`                 | Environment variable (`vars`)  | Artifact Signing service endpoint                |
| `AZURE_ARTIFACT_SIGNING_ACCOUNT_NAME`             | Environment variable (`vars`)  | Basic account alias                              |
| `AZURE_ARTIFACT_SIGNING_CERTIFICATE_PROFILE_NAME` | Environment variable (`vars`)  | Approved PublicTrust profile alias               |
| `AZURE_ARTIFACT_SIGNING_IDENTITY_EKU`             | Environment variable (`vars`)  | Full reviewed subscriber identity-validation EKU |
| `APPLE_DEVELOPER_ID_IDENTITY`                     | Environment variable (`vars`)  | Reviewed Developer ID identity alias             |
| `APPLE_TEAM_ID`                                   | Environment variable (`vars`)  | Reviewed Apple team id                           |
| `APPLE_NOTARY_KEY_ID`                             | Environment variable (`vars`)  | Dedicated Developer-role team key id             |
| `APPLE_NOTARY_ISSUER_ID`                          | Environment variable (`vars`)  | Dedicated team key issuer id                     |
| `APPLE_DEVELOPER_ID_CERT_P12_BASE64`              | Environment secret (`secrets`) | Base64-encoded Developer ID certificate bundle   |
| `APPLE_DEVELOPER_ID_CERT_PASSWORD`                | Environment secret (`secrets`) | Password for the certificate bundle              |
| `APPLE_NOTARY_KEY_P8_BASE64`                      | Environment secret (`secrets`) | Base64 dedicated Developer-role team notary key  |

`AZURE_CLIENT_ID`, tenant/subscription identifiers, service location, account/profile aliases, the
full reviewed subscriber identity-validation EKU, and Apple public identifiers are configuration, not
authentication secrets. They remain protected environment variables so rotation and environment review
are centralized. `AZURE_ARTIFACT_SIGNING_IDENTITY_EKU` must contain the complete
`1.3.6.1.4.1.311.97.<subscriber suffix>` value, not a prefix or certificate-profile alias. There is
deliberately no `AZURE_CLIENT_SECRET` reference.

Content-free evidence may retain the existing target, stable tag, source commit, SHA-256 digests,
Booleans, enums, bounded reason codes, and an approved resource/identity alias where an existing schema
allows it. The raw subscriber EKU must not appear in posted or committed evidence; native verification
reduces its comparison to a workflow-local bounded identity-match Boolean. The current verifier does
not add that field: its producer sets the existing `publisherChainVerified` Boolean to `true` only when
the chain and exact identity match both pass on every PE. `signing-verification.json` retains its
existing schema. Private material and raw provider/tool output are never evidence.

## Native provenance and verification handshake

Signing success is not a caller declaration. For each target, one protected native-runner job must:

1. validate the stable tag and required configuration before obtaining credentials;
2. stage the target and determine the pre-signing payload scope;
3. sign every required executable or code object;
4. verify the complete signed payload using native platform tools;
5. on Windows, require the Public Trust/code-signing chain and exact configured subscriber
   identity-validation EKU on every PE; on macOS, compare the verified signer with the stable reviewed
   identity alias;
6. finalize the archive, calculate its SHA-256 digest, and bind the verified payload result to that
   archive without modifying it afterward;
7. create the bounded verifier input and run `scripts/verify-portable-runtime-signing.mjs` with
   `--policy production`; and
8. upload the target only when the manifest and summary both say `verified-production` and cleanup has
   succeeded.

The Boolean checks are valid only with same-job provenance tying them to the final artifact digest,
stable tag, source commit, target, and reviewed identity/profile. They are not replayable between jobs,
runs, targets, or rebuilt archives. The Ubuntu assembler may check manifests, evidence, and digests, but
it must never synthesize a Boolean, convert a staging declaration into success, or promote any target
that did not arrive as `verified-production` from its protected native job.

The exact current verifier input is a JSON object with no keys other than:

```json
{
  "reasonCodes": [],
  "verificationChecks": {
    "publisherChainVerified": true,
    "timestampVerified": true
  },
  "sidecarRuntimes": [
    {
      "name": "runtime-name",
      "reasonCodes": [],
      "verificationChecks": {
        "publisherChainVerified": true,
        "timestampVerified": true
      }
    }
  ]
}
```

For either macOS target, replace each Windows `verificationChecks` object with exactly:

```json
{
  "developerIdVerified": true,
  "notarizationVerified": true,
  "stapleVerified": true,
  "assessmentVerified": true
}
```

`reasonCodes` and `sidecarRuntimes` are optional; `verificationChecks` is required. A sidecar entry has
exactly `name`, optional `reasonCodes`, and required platform-specific `verificationChecks`. Unknown
keys, unknown or duplicate sidecars, non-Booleans, or redaction failures are rejected. The input must
not be extended with provider responses, certificate data, identities, digests, paths, or logs; those
bindings are workflow invariants and existing manifest/provenance fields, not a second schema.

The verifier writes the existing `evidence/signing-verification.json` projection with `policy`,
`status`, `target`, `signatureKind`, `signatureVerified`, `notarizationRequired`,
`notarizationVerified`, `platformSignatureLocallyVerified`, `reasonCodes`, `sidecarRuntimes`, and
`verificationChecks`. The portable artifact contract remains authoritative for its manifest and
sidecar fields.

## Failure and evidence semantics

Only these existing bounded reason codes may be supplied or emitted; provider-specific text must never
be copied into evidence:

| Code                                 | Exact use                                                                                      |
| ------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `credential-unavailable`             | A protected credential becomes unavailable or unusable after the native phase has started.     |
| `verification-tool-unavailable`      | The required native signing/verifying tool cannot be executed.                                 |
| `verification-input-missing`         | The production verifier receives no input, or a manifest sidecar has no matching input.        |
| `windows-publisher-chain-unverified` | Derived when `publisherChainVerified` is false, including a PE chain or identity-EKU mismatch. |
| `windows-timestamp-unverified`       | Derived whenever `timestampVerified` is false.                                                 |
| `macos-developer-id-unverified`      | Derived whenever `developerIdVerified` is false.                                               |
| `macos-notarization-unverified`      | Derived whenever `notarizationVerified` is false.                                              |
| `macos-staple-unverified`            | Derived whenever `stapleVerified` is false.                                                    |
| `macos-assessment-unverified`        | Derived whenever `assessmentVerified` is false.                                                |
| `staging-unverified`                 | Emitted for the secret-free staging policy.                                                    |
| `non-production-artifact`            | Emitted for development or pull-request verification.                                          |
| `non-production-unsigned-allowed`    | Emitted with unsigned development or pull-request verification.                                |

Preflight failure before native signing starts, including a missing required environment variable or a
failed stable-tag guard, terminates the job before creating a production verifier input and may produce
no signing summary. Once native signing has started, a failure may write an ephemeral, content-free
`verification-failed` summary using only the mapping above. Failure artifacts, summaries, and manifests
must not be uploaded, assembled, published, or promoted. Raw provider responses, notarization history,
certificate bodies, private keys, passwords, tokens, private paths, tool command lines, and tool
stdout/stderr are forbidden from durable evidence.

A provider outage, rejection, revoked identity, partial target result, failed Boolean, or failure in
any sidecar produces no promotable target. The workflow maps the observable failed checks to the bounded
platform codes; it does not invent an outage/rejection code or retain the provider body. All three
targets must independently reach `verified-production` before the reviewed bundle is portable-complete.

Secret-free tag and manual staging remains `unverified-staging`. It must not select the protected
environment, request OIDC, read Apple secrets, or become production evidence. In particular,
`workflow_dispatch` is staging-only even when dispatched against a stable tag.

## Authoritative provider references

- [Azure Artifact Signing overview](https://learn.microsoft.com/en-us/azure/artifact-signing/overview)
- [Azure Artifact Signing setup](https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart)
- [GitHub OIDC authentication for Azure](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-azure)
- [Apple Developer ID](https://developer.apple.com/support/developer-id/)
- [Apple App Store Connect API keys](https://developer.apple.com/documentation/appstoreconnectapi/creating-api-keys-for-app-store-connect-api)
- [Apple notarization](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution)

## Rotation, revocation, and outage response

Routine secret or resource replacement must not require a repository change. Stage and verify the
replacement in the protected environment before removing the previous Apple credential or changing an
Azure workload, account, or profile reference. The dedicated Apple replacement key must retain the
`Developer` role and no unrelated use. Because Azure rotates short-lived leaf certificates, normal leaf
rotation requires no configuration or thumbprint change when the reviewed subscriber EKU remains the
same.

An intentional Azure subscriber identity EKU or Apple Developer ID team/identity change is a
trust-boundary change: amend this contract through review, update the protected expected identity,
rerun platform qualification, and invalidate earlier identity-bound receipts before promotion. An
Azure account/profile alias change with the same verified subscriber EKU is resource rotation, not
durable signer-identity rotation, but it still requires replacement verification before use.

On suspected compromise:

1. disable the `portable-release-signing` environment and its deployment approvals;
2. disable/delete the Azure federated credential and revoke the affected Azure profile or Apple
   certificate/API key;
3. clear affected environment secrets and stop all in-flight release runs;
4. invalidate unpromoted receipts and artifacts produced since the last trusted run; and
5. provision a replacement, update reviewed aliases when identity changes, and rerun the full #2202
   qualification before restoring promotion.

Apple Developer ID revocation can affect already distributed software. Escalate immediately to the
release owner and security owner to determine release withdrawal, replacement signing, and customer
communication. During an Azure, Apple, GitHub OIDC, timestamp, or notarization outage, keep staging
available but fail production signing closed; do not bypass verification or publish a partial bundle.

## SmartScreen limitation

A valid Authenticode signature proves publisher identity and integrity. It does not guarantee immediate
Microsoft SmartScreen reputation or warning-free first launch for every new file hash. Qualification
requires the approved verified publisher, SHA-256 signature, RFC 3161 timestamp, and local verification;
SmartScreen reputation is observed but is not asserted as a Keiko-controlled outcome.

## Child implementation interfaces

- **#2200 (Windows):** implements the protected native Windows signing job, exact Azure trust/RBAC
  boundary, `AZURE_ARTIFACT_SIGNING_IDENTITY_EKU`, valid Public Trust/code-signing chain plus exact EKU
  verification on every PE, digest binding, Windows verifier input, and fail-closed upload. Account and
  profile aliases remain resource selectors, not signer identity.
- **#2201 (macOS):** implements both protected native macOS targets, leaf-to-root hardened-runtime
  signing, dedicated Developer-role team notary key, per-run credential/keychain hygiene,
  notarization/stapling/assessment, identity binding, macOS verifier input, and fail-closed upload.
- **#2202 (qualification):** proves all three target artifacts and their sidecars arrive from the native
  jobs with matching digests, identities, manifests, summaries, and release-impact bindings; proves
  staging/manual paths remain secret-free; and proves the assembler/publisher cannot create success.

Changes to these interfaces require a reviewed update to this contract and ADR-0121 when they alter
trust authority. Implementation details that preserve the boundary remain owned by the child issue.
