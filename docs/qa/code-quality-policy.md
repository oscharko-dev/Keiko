# Code-quality syntax policy

Epic #3914 defines a noncosmetic code-quality policy that supplements the existing TypeScript,
typed ESLint, UI lint, Prettier, Sonar, coverage, security and architecture gates. The source of
truth is `scripts/code-quality-policy.json`; naming and spacing rules are excluded. On `dev` the
policy runs as a shrink-only ratchet (ADR-0167 D6). Complete enforcement, including the epic's
responsibility qualifications, arrives with #3991.

## Dev ratchet

**What runs.** The required `ci` context runs:

```bash
npm run check:code-quality-policy -- --mode ratchet
```

It scans the whole repository (about 7,200 files, about 30 seconds on an Apple-silicon laptop) with all 22 rules and counts
findings per (file, rule). It compares those counts with the committed register
`scripts/code-quality-register.json`. Build packages first on a fresh checkout
(`npm run build:packages`).

**What fails.**

| Situation                                             | Result                                            |
| ----------------------------------------------------- | ------------------------------------------------- |
| A (file, rule) count is higher than the register      | Fails, naming file, rule and line of each finding |
| A file with findings has no register entry (new file) | Fails, naming file, rule and line                 |
| A (file, rule) count is lower than the register       | Fails until the register is pruned                |
| A register entry names a deleted or renamed file      | Fails as stale until the register is pruned       |
| An inline `oxlint-disable` directive or nested config | Rejected by the engine; it cannot hide a finding  |

The second output line reports the total before and after, for example `register: 46504 → 45226 (-1278)`.

**How to fix a failure.**

- _New finding:_ fix the code. Do not add a register entry or raise a count; the register is not a
  waiver mechanism. If you believe a rule is wrong for a site, raise it on #3914 instead.
- _Fewer findings, or a stale entry after a delete or rename:_ shrink the register and commit it
  with your change:

  ```bash
  npm run check:code-quality-policy -- --prune-register
  ```

  Pruning only lowers counts and removes entries. It refuses to widen the register, so it cannot
  absorb a new finding. A renamed file with findings therefore needs those findings fixed, not
  re-registered.

**Limits.**

- Counts are per file and rule. Fixing one finding and adding another of the same rule in the same
  file nets out and passes. This is the same model as the `keiko-ui` ESLint bulk-suppression
  register (`packages/keiko-ui/eslint-suppressions.json`).
- The ratchet does not run the epic's responsibility qualifications. A green ratchet means "no new
  findings", not "this code is qualified" or "this rule is enforced".
- The baseline on `dev` `18648cad9` was 46,504 findings. Epic workstreams and ordinary `dev` work
  prune the register; #3991 removes it at zero and activates full enforcement.

## Engine

The development-only runner is Oxlint 1.78.0 with its 1.78.0 plugin bridge. The MIT upstream
`oxlint-plugin-anti-slop` 0.1.2 is pinned to immutable commit
`c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b` and installed from the HTTPS archive with lockfile
integrity. `scripts/code-quality-upstream.json` records its complete source hashes; attribution
remains in the installed LICENSE (Dillon Mulroy, 2026). Keiko's existing TypeScript API compiles
those sources into a temporary ESM directory under `node_modules`, removed in `finally`. There is
no product runtime dependency, extra formatter or ESLint compatibility bridge.

All 22 rules run in one syntax census. Diagnostics are ordered by the subject inventory, then line
and column, then rule id, so report bytes do not depend on native worker arrival order. A raw match
is a diagnostic, not a proven defect.

The inventory accounts for git-tracked JS/TS plus nonignored local additions. It derives workspace,
build and package/export membership from the existing workspace graph, TypeScript's parsed configs
and real `npm pack --dry-run` output; missing metadata or unknown source owners fail. Each actual
parser visit emits an internal `Program` receipt, including for empty files, and exactly one receipt
must match every selected file. Missing, duplicate, extra or unknown diagnostics fail, as do parser,
plugin, process, configuration and inventory failures. Source and inventory identities are checked
again after scanning so concurrent edits cannot pass unmeasured bytes.

Policy validation rejects any activation shrink against the reachable policy history, and inline
Oxlint suppression directives and nested Oxlint configuration cannot turn off the policy. Reports
contain identities, counts and relative path/rule/location findings; they omit source text and
source-derived diagnostic messages.
