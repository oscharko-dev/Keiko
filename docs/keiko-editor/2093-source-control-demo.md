# Epic #2093 source-control loop demo

This is the reproducible closure walkthrough for Epic #2093 (Built-in editor M5 — source control in
the editor). It demonstrates the complete local read-side loop: staged and unstaged gutter markers,
an inline hunk peek, bounded blame, marker-based conflict resolution with undo, explicit save, file
tree status propagation, Git Client interlock, and the docked agent's governed read-only Git context.
It does not stage, commit, push, merge, or otherwise widen delivery authority from the editor.

## Verified preparation

### Build and start Keiko

From a clean checkout, use Node.js 22 or later and npm:

```bash
npm install
npm run build
npm run dev:start
```

Open the loopback URL printed by `dev:start` (normally `http://127.0.0.1:1983`). If port 1983 is
occupied, the command prints the next selected loopback port. Select the fixture directory created
below as the active workspace.

> Final preparation result: **PASS** — the clean build/package sequence and production UI build
> completed on 2026-07-11. The hermetic automated walkthrough used the configured loopback test URL
> `http://127.0.0.1:32183`; `dev:start` remains free to choose the next loopback port interactively.

### Create a hermetic source-control fixture

Run the following outside the Keiko checkout. It uses repository-local identity and signing config,
does not contact a remote, creates one partially staged file, and intentionally leaves one file in a
real unmerged state. The merge exit code of `1` is expected and is asserted.

```bash
export KEIKO_SOURCE_CONTROL_DEMO_ROOT="$(mktemp -d)"
git init -q "$KEIKO_SOURCE_CONTROL_DEMO_ROOT"
git -C "$KEIKO_SOURCE_CONTROL_DEMO_ROOT" config user.name "Keiko Demo"
git -C "$KEIKO_SOURCE_CONTROL_DEMO_ROOT" config user.email "keiko-demo@example.invalid"
git -C "$KEIKO_SOURCE_CONTROL_DEMO_ROOT" config commit.gpgsign false
mkdir -p "$KEIKO_SOURCE_CONTROL_DEMO_ROOT/src"

printf '%s\n' \
  'export const title = "base";' \
  'export const staged = "base";' \
  'export const unstaged = "base";' \
  > "$KEIKO_SOURCE_CONTROL_DEMO_ROOT/src/source-control.ts"
printf '%s\n' 'export const choice = "base";' \
  > "$KEIKO_SOURCE_CONTROL_DEMO_ROOT/src/conflict.ts"
git -C "$KEIKO_SOURCE_CONTROL_DEMO_ROOT" add -- src/source-control.ts src/conflict.ts
git -C "$KEIKO_SOURCE_CONTROL_DEMO_ROOT" commit -q -m "Create source-control demo"

git -C "$KEIKO_SOURCE_CONTROL_DEMO_ROOT" branch demo-theirs
printf '%s\n' 'export const choice = "ours";' \
  > "$KEIKO_SOURCE_CONTROL_DEMO_ROOT/src/conflict.ts"
git -C "$KEIKO_SOURCE_CONTROL_DEMO_ROOT" add -- src/conflict.ts
git -C "$KEIKO_SOURCE_CONTROL_DEMO_ROOT" commit -q -m "Choose ours"

git -C "$KEIKO_SOURCE_CONTROL_DEMO_ROOT" switch -q demo-theirs
printf '%s\n' 'export const choice = "theirs";' \
  > "$KEIKO_SOURCE_CONTROL_DEMO_ROOT/src/conflict.ts"
git -C "$KEIKO_SOURCE_CONTROL_DEMO_ROOT" add -- src/conflict.ts
git -C "$KEIKO_SOURCE_CONTROL_DEMO_ROOT" commit -q -m "Choose theirs"
git -C "$KEIKO_SOURCE_CONTROL_DEMO_ROOT" switch -q -

set +e
git -C "$KEIKO_SOURCE_CONTROL_DEMO_ROOT" merge --no-edit demo-theirs
merge_exit=$?
set -e
test "$merge_exit" -eq 1

printf '%s\n' \
  'export const title = "base";' \
  'export const staged = "staged";' \
  'export const unstaged = "base";' \
  > "$KEIKO_SOURCE_CONTROL_DEMO_ROOT/src/source-control.ts"
git -C "$KEIKO_SOURCE_CONTROL_DEMO_ROOT" add -- src/source-control.ts
printf '%s\n' \
  'export const title = "base";' \
  'export const staged = "staged";' \
  'export const unstaged = "unstaged";' \
  > "$KEIKO_SOURCE_CONTROL_DEMO_ROOT/src/source-control.ts"

git -C "$KEIKO_SOURCE_CONTROL_DEMO_ROOT" status --porcelain=v1
git -C "$KEIKO_SOURCE_CONTROL_DEMO_ROOT" diff --cached --numstat -- src/source-control.ts
git -C "$KEIKO_SOURCE_CONTROL_DEMO_ROOT" diff --numstat -- src/source-control.ts
git -C "$KEIKO_SOURCE_CONTROL_DEMO_ROOT" ls-files -u -- src/conflict.ts
git -C "$KEIKO_SOURCE_CONTROL_DEMO_ROOT" blame --line-porcelain -- src/source-control.ts
```

The preparation procedure was executed during documentation authoring on 2026-07-11. Its assertions
and inspections produced these content-free facts:

- expected merge exit code `1`;
- `UU src/conflict.ts` and `MM src/source-control.ts` in porcelain status;
- one added and one removed line in both staged and unstaged numstat;
- three unmerged index entries and three marker lines for `src/conflict.ts`; and
- three blame records for `src/source-control.ts`.

Remove the fixture after the walkthrough with `rm -rf "$KEIKO_SOURCE_CONTROL_DEMO_ROOT"`.

## Full walkthrough

### 1. Distinguish staged and unstaged changes in the gutter

1. Select `$KEIKO_SOURCE_CONTROL_DEMO_ROOT` as the active Keiko workspace and open
   `src/source-control.ts` in the built-in editor.
2. Observe distinct staged and unstaged gutter decorations. Their accessible metadata identifies
   both the layer (`staged` or `unstaged`) and change kind; the distinction is not color-only.
3. Activate a gutter marker. Confirm that the inline hunk peek opens for that exact layer and hunk,
   presents the shared add/delete/context semantics, exposes truncation when applicable, moves focus
   to its dismiss control, and closes with Escape.
4. Use the explicit Git refresh action. Confirm that the read is repeated without staging or writing
   repository state.

### 2. Read blame and open the existing Git Client

1. Toggle blame for `src/source-control.ts` through the editor action.
2. Confirm that the line annotations contain bounded author display name, relative age, and an
   abbreviated commit identifier. They must not contain author email or source-line text from the
   blame protocol.
3. Activate a committed blame entry by keyboard or pointer. Confirm that the existing governed Git
   Client opens at the validated SHA-1 or SHA-256 object identifier.
4. Toggle blame off. Confirm that its decorations are removed independently of gutter decorations.

Blame is for the current working tree and current revision only. Blame-at-revision is a known limit,
not an implicit fallback.

### 3. Resolve a conflict in the buffer, undo, and save explicitly

1. Open `src/conflict.ts`. Confirm that the tab and status surface report one conflict and that the
   editor highlights the marker-based ours/theirs regions.
2. Invoke next/previous conflict navigation and then **Accept Theirs**. Confirm that only the
   recognized block changes and the editor becomes dirty; Git remains unmerged because no save,
   index update, or stage operation is implicit.
3. Undo once. Confirm that the complete conflict resolution is reversed as one normal editor edit.
4. Invoke **Accept Ours**. Confirm that the buffer now contains the ours line without marker or base
   content.
5. Save explicitly. Confirm that the save succeeds, the buffer is no longer dirty, and source-control
   reads refresh. Saving writes the file only; it does not mark the Git index resolved.

The v1 surface is intentionally marker-based. It is not a three-way merge editor.

### 4. Inspect file and directory status propagation

1. Open the Files window for the same root.
2. Confirm that `src/conflict.ts` carries the conflicted badge and that its parent `src` directory
   propagates the conflicted state before resolution.
3. Confirm that `src/source-control.ts` carries the appropriate modified state and that ignored files,
   when present, are dimmed rather than presented as ordinary changes.
4. After the explicit save, use the existing focus/explicit-refresh seam and confirm that stale tree
   status is replaced. Push-driven watch refresh remains deferred to M7.

### 5. Use the Editor and Git Client interlock

1. From the editor, choose **Open Git diff**. Confirm that the existing Git Client opens for the same
   bound root and file, using the structured hunk renderer rather than reconstructing complete file
   sides.
2. From the Git Client's changed-file list, open the file in the editor. Confirm that the editor
   reveals the first changed line.
3. Record the line-only behavior: the current interlock has no per-column reveal contract.

### 6. Read source-control state through a docked agent

1. Dock an agent session to `src/conflict.ts` in the same workspace and request coding context through
   the existing governed M3 context assembly.
2. Confirm that the bounded Git-context projection reports the unresolved conflict and includes only
   the allowed diff/blame context needed for reasoning.
3. Inspect citations/evidence metadata. It must contain no absolute workspace path, author email,
   diff body, blame source text, secret, or Git write authority. Upstream truncation and local caps
   must remain visible through content-free omission accounting.

## Automated reproduction

- Complete real-BFF source-control loop (Chromium reference browser):
  `npm run test:e2e:editor-source-control-2235`.
- Focused contained Git-read, conflict-race, privacy, and agent-context regressions:

  ```bash
  npx vitest run \
    packages/keiko-git/src/runner.test.ts \
    packages/keiko-server/src/gitBlameParser.test.ts \
    packages/keiko-server/src/gitRoutes.test.ts \
    packages/keiko-editor/src/components/conflict-bridge.test.ts \
    packages/keiko-server/src/editor/codingContextProviders.test.ts
  npm test --workspace @oscharko-dev/keiko-ui -- \
    src/app/components/desktop/widgets/gitObjectId.test.ts
  ```

- Editor performance and resilience evidence: `npm run check:perf-evidence`, the editor performance
  Playwright gate, and `npm run check:editor-bundle-size`.
- Full release-affecting coverage chain: `npm run test:coverage:quality`.
- Linux-authoritative editor bundle evidence: `npm run check:editor-release-evidence` in Linux/CI.

The focused Vitest commands above passed 5 files / 78 tests and 1 UI file / 1 test. The final
real-BFF E2E passed 5/5 Chromium scenarios; performance, coverage, Linux release evidence, package
surface, security, and full local gate outcomes are recorded in
`2093-source-control-regression-evidence.md`.
