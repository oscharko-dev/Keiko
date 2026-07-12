# Hosted feedback GitHub App configuration contract

Issue publication is disabled by default. The hosted runtime does not read a GitHub key or target
file, construct the adapter, allocate publication database pools, run readiness inspection, start a
poll timer, or contact GitHub unless all four settings below are present:

- `KEIKO_FEEDBACK_GITHUB_APP_ID`
- `KEIKO_FEEDBACK_GITHUB_PRIVATE_KEY_FILE`
- `KEIKO_FEEDBACK_GITHUB_PRIVATE_KEY_ROTATED_AT`
- `KEIKO_FEEDBACK_GITHUB_TARGETS_POLICY_FILE`

An absent set is the supported disabled mode. A partial or invalid set fails startup before any
listener binds. A configured runtime validates the secure files and completes GitHub permission and
installation readiness inspection before binding listeners.

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

## Publication worker settings

The following settings are optional only after the four-value boundary is enabled. Defaults and
bounds are deliberately conservative:

| Setting                                           | Default |   Allowed range |
| ------------------------------------------------- | ------: | --------------: |
| `KEIKO_FEEDBACK_GITHUB_MAX_CONCURRENT_DELIVERIES` |       4 |            1–32 |
| `KEIKO_FEEDBACK_GITHUB_POLL_INTERVAL_MS`          |    1000 |    100–30000 ms |
| `KEIKO_FEEDBACK_GITHUB_LEASE_DURATION_MS`         |   60000 |  5000–300000 ms |
| `KEIKO_FEEDBACK_GITHUB_CIRCUIT_COOLDOWN_MS`       |   30000 | 1000–3600000 ms |

The runtime allocates a dedicated publication state pool and a physically distinct installation
session pool; the latter is sized exactly to the configured maximum concurrent deliveries. Neither
pool is shared with anonymous intake or maintainer review. This keeps blocked GitHub calls from
consuming request-plane database capacity.

## Operations and recovery

Every delivery reconciles the approved marker before considering creation. An exact match records
the internal linkage without a POST. Search absence is non-authoritative: only durable
create-eligible state may proceed through token preflight, durable create arming, and one private
POST. Possibly committed state remains reconciliation-only.

Transient provider failures use bounded backoff and per-installation circuit cooling while the
seven-day durable outbox buffers delivery. Provider or circuit outages therefore do not make the
anonymous intake readiness endpoint fail. Invalid local configuration, signing-key custody, or
startup permission inspection prevents publication startup. Shutdown lowers readiness, stops
polling, aborts in-flight GitHub transport, drains workers to the configured runtime deadline, and
then closes the isolated pools.

Circuit state is content-free and durable in PostgreSQL, so the threshold of three consecutive
provider failures, cooldown, and single half-open probe apply across replicas and restarts. A
successful marker search alone does not reset failures; reset is atomic with final issue linkage.
When the queue is empty the runtime runs one probe and exponentially backs off to at most 30
seconds. Finding work resets the delay and immediately fills only the configured bounded lanes.

Repeated unexpected local worker or storage failures lower only the publication health facet and
emit the safe diagnostic shape below. A subsequent successful storage/provider worker cycle
restores that facet; anonymous intake readiness stays independent. Shutdown uses one shared drain
deadline for transport cancellation, worker settlement, and publication-pool closure. At the
deadline, checked-out publication clients are discarded without consuming or closing intake or
maintainer connections.

Operators can inspect this facet on the management listener with `GET /ready/publication`. A running
service with publication disabled returns HTTP 200 with `{ "status": "disabled" }`; an enabled,
running, healthy worker returns HTTP 200 with `{ "status": "ok" }`; degradation or any shutdown
state returns HTTP 503 with
`{ "status": "unavailable" }`. The existing `GET /ready` endpoint remains the anonymous intake
readiness signal and is not lowered by GitHub provider, circuit, or publication-worker outages.

Diagnostics contain only a category, failure code, count, and elapsed timing. They never contain
approved title/body bytes, reconciliation markers, target/repository strings, tokens, or key data.
