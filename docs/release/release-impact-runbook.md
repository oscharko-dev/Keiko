# Release-Impact Runbook

This runbook explains how maintainers and agents produce the structured release-impact metadata required by [ADR-0099](../adr/ADR-0099-governed-in-app-updates-and-release-impact-contract.md).

The source of truth is [`release-impact.catalog.json`](../../release-impact.catalog.json). The catalog is validated by [`scripts/check-release-impact.mjs`](../../scripts/check-release-impact.mjs) and is bundled in the root npm package.

## When To Fill Metadata

Fill release-impact metadata for any change that affects observable UX, reliability, performance, security, installation, update behavior, compatibility, local state, evidence semantics, or user-facing workflow behavior.

Use `internal-only` only when the change is genuinely hidden from default patch notes. Internal-only entries may appear in default patch notes only when they affect observable UX, reliability, performance, security, installation, update behavior, or compatibility.

## Required Fields

Every release-impacting issue and PR must record:

- User-visible change.
- Release-note category and priority.
- Release-note bullet.
- Supported-from versions.
- Affected state stores.
- User action required and remediation.
- Release-owner review evidence, including an `approvalReference` that points to the issue, PR, or release approval record.

Before publish, `release:publish` and `prepublishOnly` require a machine-checkable approval reference in one of two forms, both verified through the GitHub API and both bound to a login listed in `KEIKO_RELEASE_OWNER_GITHUB_LOGINS`:

- `github-pr-review:<owner>/<repo>#<pr>#<review>` — the referenced review must exist in the current GitHub repository and be `APPROVED`.
- `github-issue-comment:<owner>/<repo>#<issue>#<comment>` — the referenced comment must exist on the referenced issue in the current GitHub repository, be authored by an allowed release owner, and carry the literal phrase `Approved-for-publish: <package-name>@<version>` for the exact root package version being published **on a trimmed line of its own**, outside any Markdown code fence and outside any blockquote. A phrase merely embedded in a sentence, quoted in a denial, shown inside a fenced example, or cited on a `>` blockquote line documents the phrase — it never grants the approval. This form exists because GitHub refuses self-approval of one's own pull requests, which a solo release owner can never satisfy; it carries the same intent — a durable, GitHub-verified owner approval artifact — at the same strictness (owner decision, 2026-08-08).

Bare issue references without a verified approval comment are acceptable while metadata is being prepared, but they are not sufficient to publish.

User findings stay reporter-simple. Reporters provide reproduction and impact; maintainers or agents fill the normalized release-impact triage block after confirming the defect and intended fix.

### Feature PRs and release-cut PRs

A feature or fix PR records the normalized fields above in its PR body or linked issue. Until both
its target package version and release-owner approval reference exist, do not invent them and do not
append the change to an already published package version. The PR must state that catalog insertion
is deferred and preserve the prepared metadata for release planning.

The release-cut or release-metadata PR appends the prepared record to
`release-impact.catalog.json` after the target package version is decided and the required
release-owner approval evidence exists. That PR owns catalog deduplication, version/tag binding, and
the publish-mode approval-reference check. This lifecycle split keeps feature review complete without
mutating an append-only release artifact prematurely.

## Taxonomy

Use these release-note categories:

| Category                         | Use                                                                                                 |
| -------------------------------- | --------------------------------------------------------------------------------------------------- |
| `critical-security`              | Security or supply-chain fixes that materially affect trust, update eligibility, or safe execution. |
| `update-notes`                   | Update behavior, packaging, release metadata, or operator workflow changes.                         |
| `state-or-compatibility-changes` | Local state, schema, compatibility, migration, or remediation changes.                              |
| `new-additions`                  | New user-visible capabilities.                                                                      |
| `improvements`                   | User-visible capability improvements that are not defect fixes.                                     |
| `fixes`                          | Bug fixes and corrected behavior.                                                                   |
| `ui-polish`                      | Visual, accessibility, copy, or interaction refinements.                                            |
| `internal-only`                  | Changes hidden from default patch notes unless they create observable impact.                       |

Use these priorities: `critical`, `high`, `normal`, `low`, and `internal`.

Use only the ADR-0099 remediation values: `no-action-required`, `restart-required`, `repair-required`, `local-knowledge-reindex-required`, `migration-required`, and `manual-review-required`.

## Catalog Rules

Published catalog entries are append-only. Do not edit a published entry to change meaning after release.

For corrections:

- Add a new entry with a new `id`.
- Set `correctionOf` or `supersedes`.
- Provide `correctionRationale`.
- Keep the original entry in the catalog for audit history.
- Re-run `npm run check:release-impact`.

The current root package version must have at least one reviewed `latest` entry tied to `package.json` and `v<package.json version>`. A release may contain multiple reviewed entries when one package version carries several user-relevant impact records. Each current entry must include `supportedFrom: ["0.2.0"]` or a broader reviewed baseline path that explicitly includes `0.2.0`.

When a previous stable tag contains a bundled release-impact catalog, `npm run check:release-impact` compares published rows from that tag against the current catalog. Published rows must remain byte-for-byte equivalent after JSON normalization; corrections and superseding records are additive and must reference retained catalog entry ids.

## Deduplication

Before adding a release-note bullet:

1. Search the current issue, child issues, PR body, and catalog for an equivalent bullet.
2. Keep one concise customer-readable bullet per product change.
3. Prefer the broadest accurate issue/PR as the source when several implementation slices support one outcome.
4. Mark narrow implementation details as `internal-only` unless they create observable impact.

Duplicate default patch-note bullets fail `npm run check:release-impact`. During release-note generation, issue or PR references are stripped from default user-facing bullets and retained in the technical traceability footer for entries that are public by default, so duplicate human-facing notes are collapsed before GitHub Release metadata is written. Non-observable `internal-only` entries and entries with `defaultPatchNotes: false` stay out of the public GitHub Release body, including the technical details block.

## Exceptions

Critical security or emergency breaking exceptions require release-owner review before publish metadata can be used.

Breaking exceptions must record:

- Rationale.
- User-visible warning text.
- Whether the carry-forward path is verified.
- The named carry-forward path when one-click update eligibility is allowed.

If carry-forward is not verified, the update remains manual and `oneClickEligible` must be `false`.

## Verification

Run:

```sh
npm run check:release-impact
```

`npm run release:plan -- --tag beta` and `npm run release:publish -- --tag <tag>` also run the release-impact gate. The release plan prints the generated GitHub Release notes between `BEGIN KEIKO RELEASE NOTES` and `END KEIKO RELEASE NOTES` markers without publishing a live release. Release-note generation fails closed when public notes contain obvious local filesystem paths, private key material, or common secret-token patterns. The gate fails when metadata is missing, invalid, contradictory, duplicated, not reviewed, not bundled, or not tied to the current package version.
