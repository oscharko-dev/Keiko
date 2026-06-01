# Security and audit boundaries

Audience: security reviewers and regulated-engineering reviewers assessing Keiko for a pilot. This document states what Keiko's boundaries enforce and, just as plainly, what they do not. Where a limit exists, it is named.

Keiko runs on a developer machine or a CI runner. Its trust boundary is local: there is no managed control plane, no multi-user server, and no remote UI in Wave 1. The boundaries below are the controls that hold within that local model.

The single hard invariant across every surface: **no change reaches a branch without a human reviewer.** Keiko proposes; a person decides.

---

## Boundary summary

| Boundary          | Control                                                            | Source                             |
| ----------------- | ------------------------------------------------------------------ | ---------------------------------- |
| Workspace access  | Always-on deny list; lexical + realpath containment                | [ADR-0005](adr/README.md#adr-0005) |
| Command execution | Allowlist, no shell, ephemeral HOME, resource bounds, symlink gate | [ADR-0006](adr/README.md#adr-0006) |
| Verification      | Per-command timeout and memory ceiling; abort handling             | [ADR-0007](adr/README.md#adr-0007) |
| Patch (tests)     | Production-code guard; dry-run default; gated apply                | [ADR-0008](adr/README.md#adr-0008) |
| Patch (fixes)     | Source-edit scope guard; sensitive-path rejection; gated apply     | [ADR-0009](adr/README.md#adr-0009) |
| Evidence storage  | Redaction at construction; atomic, contained writes; retention     | [ADR-0010](adr/README.md#adr-0010) |
| Local UI          | Loopback bind; DNS-rebinding defence; strict CSP; gated apply      | [ADR-0011](adr/README.md#adr-0011) |
| Credentials       | Env/config only, never flags; never logged                         | [ADR-0003](adr/README.md#adr-0003) |

---

## Workspace access

Keiko reads files only inside the detected workspace, and only through a boundary-checked path.

- **Always-on deny patterns.** Secret-shaped and noise files are never read, regardless of `.gitignore`. The deny list is unconditional. The frozen `DEFAULT_DENY_PATTERNS` are, in full:
  - secrets: `.env`, `.env.*` (except `.env.example`), `*.pem`, `*.key`, `id_rsa`, `id_ed25519`, `id_ecdsa`, `id_dsa`, `*.p12`, `*.pfx`, `.npmrc`
  - deps: `node_modules`
  - build: `dist`, `build`, `out`, `coverage`
  - caches: `.cache`, `.next`, `.turbo`
  - vcs: `.git`
  - logs: `*.log`
  - os: `.DS_Store`
- **Two-tier path safety.** Lexical containment runs first (`resolveWithinWorkspace`), then realpath/symlink enforcement at the IO edge. A path that escapes the root — through `..`, an absolute reference outside the root, or a symlink whose real path leaves the workspace — throws `PathEscapeError` before any read.

The context surface (`keiko context`) is dry-run by construction: it calls no model and creates no agent session.

See [ADR-0005](adr/README.md#adr-0005).

---

## Command execution

The tool layer exposes two capabilities: a command runner and a patch applier. The command runner is bounded on several axes.

- **Deny-by-default executable rules.** Only read-only default executables can run. The executable name must be bare, is matched by `basename`, is then resolved to a trusted absolute executable path, and workspace-controlled `PATH` resolutions are rejected. The frozen `DEFAULT_COMMAND_RULES` are:
  - `npm` — read-only inspection subcommands only (`audit`, `ls`, `list`, `outdated`, `view`, `info`, `help`, `ping`); install/script/account/registry mutation is denied by omission.
  - `git` — a read-only allowlist (`status`, `diff`, `log`, `show`, `rev-parse`, `ls-files`, `describe`, `blame`, `cat-file`); mutating subcommands such as `push`, `reset`, `checkout`, `commit`, and `merge` are denied.
  - Raw interpreters and package runners such as `node` and `npx` are not model-facing defaults. Keiko's deterministic verification workflow uses an explicit verification-only rule set for `npm test`/`npm run` and targeted `npx` test invocations.
  - Any other executable is rejected before it is spawned. Operators can narrow the rules further via configuration.
- **No shell.** Commands are spawned directly, with no shell interpretation, so quoting and metacharacters cannot inject a second command.
- **Ephemeral HOME.** Each command runs with `HOME` (and `USERPROFILE`) redirected to a per-run empty temporary directory, so a home-directory credential lookup (`~/.npmrc`, `~/.git-credentials`, `~/.aws/…`) resolves to nothing.
- **Environment name allowlist.** The child receives only a frozen allowlist of environment variable names copied from the parent, never a spread of the full environment.
- **Resource bounds.** A wall-clock timeout, an output cap, and a per-run command-execution ceiling.
- **Workspace-rooted working directory.** Commands run with their working directory set to the workspace root unless a workspace-relative cwd is requested. Cwd realpaths that escape the workspace or resolve into always-denied paths are rejected before spawn.

See [ADR-0006](adr/README.md#adr-0006).

### What command execution does NOT do

The honest limits, stated in [ADR-0006](adr/README.md#adr-0006):

- **Repository script execution is remote-code-execution by design.** `npm test` and `npm run` in the verification workflow run repository-authored code. The sandbox bounds the _process environment_, not the _semantics_ of those scripts. A reviewer must trust the repository's own scripts to the same degree they would when running them by hand.
- **No network isolation.** Wave 1 adds no OS-level network namespace or firewall. A command can reach the network if the host can.
- **No filesystem isolation beyond the workspace boundary.** Path containment is enforced in-process; it is not a chroot or a container mount namespace.

The boundary protects the host outside the workspace. It does not protect the workspace from code the workspace itself contains.

---

## Verification resource limits

`keiko verify` and the apply path of each workflow run the project's gates through the command runner above, under per-command limits.

- **Per-command resource limits.** Each command runs under a wall-clock timeout and a best-effort memory ceiling, read from `/proc` VmRSS where available.
- **Cancellation.** An `AbortSignal` stops a run; the orchestrator distinguishes a resource-exceeded abort from a user cancellation in the reported outcome.

The memory ceiling is best-effort and depends on `/proc` availability; treat it as a guardrail, not a hard cgroup limit.

See [ADR-0007](adr/README.md#adr-0007).

---

## Patch review

Both workflows produce a diff. Neither writes by default.

- **Dry-run by default.** Each workflow stops at a reviewable diff. Writing requires an explicit `--apply`, after which verification runs.
- **Unit-test generation: production-code guard.** The generated patch may only create or modify test files. A patch touching a non-test path is rejected, fail-closed. A prompt-injected diff cannot reach source files. See [ADR-0008](adr/README.md#adr-0008).
- **Bug investigation: source-edit scope guard.** A fix may edit source, but a patch touching a sensitive path (`.git/`, `.github/`, `.husky/`, lockfiles) is rejected. The guarded path is normalised to the resolved write form before the sensitive-path check, so prefix tricks cannot slip past it. See [ADR-0009](adr/README.md#adr-0009).
- **Verified vs hypothesis.** The investigation report separates facts the workflow established (parsed failure frames, whether the patch validates and applied) from the model's unverified hypothesis. A reviewer can see which claims are checked and which are not.

Applying a patch is an explicit, opt-in action. The default output is a diff for a human to read.

---

## Secret redaction

Credentials never enter logs, events, or persisted evidence.

- **Credentials from env/config only.** API keys come from environment variables or a config file, never CLI flags, so they stay out of shell history and process listings.
- **Never logged.** Keys never appear in logs, errors, or serialised output.
- **Redaction at construction.** Evidence manifests are redacted as they are built; there is no code path that writes an unredacted manifest. Secret-shaped strings, environment values, and known literal credentials are removed before anything is written.

See [ADR-0003](adr/README.md#adr-0003) and [ADR-0010](adr/README.md#adr-0010).

---

## Evidence storage

`keiko run`, workflow runs launched from the local UI, and `keiko evaluate` (offline and live) persist an evidence manifest for audit. `keiko gen-tests` and `keiko investigate` print a reviewable report but do not persist a manifest; `keiko verify` and `keiko context` are read-only summaries that persist nothing.

- **Redaction before persist** (above): no unredacted manifest is ever written.
- **Atomic, contained writes.** Each manifest is written with an exclusive-create (`O_EXCL`) open into a directory whose real path is verified to be inside the evidence root.
- **Retention.** The newest runs are kept up to a maximum; older runs are rotated out. Rotation deletes only ledger-created manifest files inside the contained directory, ordered by the manifest's recorded finish time, never by filesystem mtime.
- **Schema versioning.** Every manifest carries a stable schema version; readers reject an unknown version rather than guessing at the shape.
- **Not tamper-evident, not encrypted at rest.** Manifests are ordinary developer-writable JSON files; a local actor with filesystem access can edit or delete them. Wave 1 provides confinement, redaction, and `.gitignore` exclusion — not cryptographic integrity or encryption at rest. Immutable-ledger infrastructure is out of scope (see [ADR-0010](adr/README.md#adr-0010)).

Inspect manifests with `keiko evidence list` and `keiko evidence show <runId>`. The default location is `$KEIKO_EVIDENCE_DIR` or `.keiko/evidence` under the workspace.

See [ADR-0010](adr/README.md#adr-0010).

---

## Local UI

The UI is a single-user, local-only surface. It consumes the same audited layer as the CLI, so it inherits the dry-run discipline and the controls above.

- **Loopback bind.** The server binds `127.0.0.1` only; it never listens on a public interface.
- **DNS-rebinding defence.** Every request's `Host` and `Origin` headers are validated against an allowlist.
- **Strict CSP.** A Content-Security-Policy with per-asset hashes; no inline script executes unless hashed.
- **Secret redaction.** The backend redacts secrets before any response reaches the browser; evidence is redacted on disk.
- **Gated apply.** The browser cannot apply a patch without the same explicit, dry-run-default gate the CLI uses.

Multi-user access, authentication, and remote hosting are out of scope for Wave 1. See [ADR-0011](adr/README.md#adr-0011) and the [local UI runbook](ui-runbook.md).

---

## No unattended merge

This is a hard epic invariant, not a configurable option. Across the CLI, the SDK, and the UI:

- The default for every workflow is a dry-run diff.
- Applying a change is an explicit, opt-in action that writes to the working tree and runs verification.
- Keiko never commits, pushes, opens a pull request, or merges. A human reviews every diff and owns the decision to integrate it.

There is no mode in which Keiko merges code on its own.

---

## Wave 1 security limitations

What Keiko **does** guarantee in Wave 1:

- File reads stay inside the workspace; secret-shaped files are never read.
- Only allowlisted executables run, with no shell, an ephemeral HOME, and resource bounds.
- Patches are dry-run by default; the test workflow cannot touch non-test files, and the fix workflow cannot touch sensitive paths.
- Evidence is redacted before it is written and stored in a contained directory.
- The UI is reachable only from the loopback interface, with DNS-rebinding defence and a strict CSP.
- Credentials are never taken from flags, and never logged or persisted.
- No change is merged without a human.

What Keiko **does not** guarantee in Wave 1 — state these plainly to stakeholders:

- **It is not OS-level isolation.** There is no container, VM, network namespace, or chroot. Allowlisted commands run repository-authored code with the host's privileges and network access.
- **The memory ceiling is best-effort.** It depends on `/proc` and is not a hard kernel-enforced limit.
- **It is single-user and local.** There is no authentication, no authorization model, and no audit of who ran what across users. Operating-system file permissions are the access control.
- **It does not vet model output for correctness.** Guards constrain _where_ a patch may write and _whether_ it validates; they do not judge whether the change is correct. That is the human reviewer's job.
- **Offline evaluation does not measure model safety or quality.** See the [Go/No-Go criteria](pilot/go-no-go.md).
- **OCR and embedding models are not callable.** Their methods are Wave 2.

Treat Keiko as bounded developer assistance with a strong audit trail, run inside whatever isolation your own environment provides — not as a substitute for that isolation.

---

## Related documents

- [README — Security and audit boundaries](../README.md#security-and-audit-boundaries) — the short summary
- [Customer pilot runbook](pilot/runbook.md) — review expectations and evidence handling
- [Go/No-Go criteria](pilot/go-no-go.md) — what evaluation does and does not establish
- [Architecture decisions](adr/README.md) — compact decision log
