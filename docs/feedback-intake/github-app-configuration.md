# Hosted feedback GitHub App configuration contract

Issue publication is disabled by default. Phase B1 defines the service-side boundary but does not
wire the publication worker, HTTP routes, or UI; those remain later phases of #2076.

An operator enables the boundary with four values: a decimal GitHub App id, an absolute private-key
file path, an RFC 3339 private-key rotation timestamp, and a targets-policy file path. Partial or
invalid configuration keeps publication unready. Raw private-key material, installation tokens,
target JSON, repository names, and labels are not accepted as environment values.

Both files must be regular, single-link, owner-only files owned by the service user. Symbolic links,
multiple hard links, group/other permission bits, empty files, and oversized files are rejected.
The private key is a bounded PEM RSA key of at least 2048 bits, used only for RS256 signing. The
rotation timestamp must be no more than 90 days old. Atomic file replacement is observed at the next
signing snapshot; key bytes are never returned, logged, or serialized.

The targets-policy file is strict UTF-8 JSON with this closed shape:

```json
{
  "version": 1,
  "targets": [
    {
      "targetKey": "public-feedback",
      "installationId": "123456",
      "repositoryId": "789012",
      "owner": "example-owner",
      "repository": "example-repository",
      "labels": ["user-finding", "source:keiko"],
      "labelPolicyVersion": "labels-v1",
      "targetPolicyVersion": "target-v1"
    }
  ]
}
```

Unknown or duplicate keys, duplicate target keys or labels, control characters, non-decimal ids,
and values outside the contract bounds are rejected. The API origin is not configurable: it is
always exactly `https://api.github.com`. Each target is bound to the complete Phase A target-policy
digest over origin, repository and installation identity, canonical owner/name, exact ordered
labels, target key, label-policy version, and target-policy version.

Startup permission inspection requires a selected-repositories installation with exactly Issues
write and GitHub's mandatory Metadata read permission. Each operation mints one memory-only token
for exactly the bound repository with only Issues write permission. No generic URL or HTTP method,
redirect, alternate origin, caller-supplied repository/label, PR/project/contents/admin operation,
or browser credential surface exists.
