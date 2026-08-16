# The UI i18n literal gate

`npm run check:ui-i18n` answers two different questions. Knowing which one answers what avoids the
failure mode that made the German locale unreal in a shipped release.

| Question                                                            | Answered by                                          |
| ------------------------------------------------------------------- | ---------------------------------------------------- |
| Did English and German catalog entries land together?               | the catalog-update and key-parity checks             |
| Is any **individual** user-facing string still a hardcoded literal? | the untranslated-literal rule + the ratcheted ledger |

Before the literal rule existed, only the first question was asked, and only of changed `.tsx` files.
A component could route ten strings through `useTranslate` and hardcode the eleventh and the gate
stayed green; a `.ts` file was not examined at all. That is how the window-type registry — the single
table the window launcher, the New Window dialog and the Quick Access command list all render their
copy from — shipped every window title, description, launcher-field label and CTA as an English
literal that no locale switch could move, with `check:ui-i18n` reporting OK on every change to it.

## What the literal rule looks at

A string literal in one of the three positions a user actually reads it:

- JSX text — `<span>New window</span>`
- a user-facing attribute value — `aria-label`, `aria-description`, `aria-placeholder`, `alt`,
  `placeholder`, `title`, `data-tip`
- a `label` / `description` / `title` / `cta` / `scope` / `group` / `menuTitle` field of an option or
  command registry — `{ id: "unit-test-generation", label: "Unit Test Agent" }`

Scope: production `.ts` and `.tsx` under `packages/keiko-ui/src/app/` and `packages/keiko-ui/src/lib/`.
Tests, `.d.ts`, and the i18n layer itself (catalogs, the provider, `*-i18n.ts` helpers) are not
subjects.

The value must look like human copy. Machine tokens that live in the same positions — lowercase slugs
and dotted keys (`governed-assist`, `editor.command.runLint`), paths and URLs, `SCREAMING_CASE`,
numbers with units, and template literals made only of `${…}` interpolations — are not reported. The
deliberate consequence is that a lowercase single word (`"optional"`) is also not reported: precision
is chosen over recall so the gate cannot cry wolf on the hundreds of enum members and mode names in
these positions.

## The ledger

`docs/qa/ui-i18n-literal-baseline.json` records the untranslated literals that already existed when
the rule was introduced, per file. It is a ratchet, exactly like the coverage baseline
([`coverage-truth-model.md`](coverage-truth-model.md), ADR-0158):

- a literal listed there is known debt the gate tolerates;
- **any** literal not listed fails the gate, including in a file that already carries debt;
- removing a literal makes the ledger stale, which is itself a failure — regenerate with
  `npm run check:ui-i18n:baseline` so the ledger only ever shrinks.

Never add an entry to silence a new literal. `npm run check:ui-i18n:all` evaluates every tracked UI
source against the ledger and is what proves gate and tree are in sync.

## The opt-out

For a literal in one of these positions that is genuinely **not** user-facing, mark the line:

```ts
const joiner = { label: " · " }; // i18n-exempt: internal join token, never rendered as copy
```

`{/* i18n-exempt: <reason> */}` works next to JSX text, where a `//` comment is not valid. The marker
applies to its own line or the line immediately below it.

The marker lives in the source on purpose: the claim and its reason appear in the diff a reviewer
reads, instead of in an allowlist nobody opens. A reason shorter than 12 characters is itself a gate
failure, so the escape hatch cannot be used wordlessly.

## Known limits

- The two non-JSX positions (user-facing attribute values, and `label`/`description`/`title` fields
  on option/command registries) are scanned per line, not through an AST. A literal split across
  lines in one of those positions, or assembled from variables, is not seen. The JSX-text and
  string-literal-child positions ARE scanned via the TypeScript AST, so multi-line JSX text
  (`<p>\n  Hello there\n</p>`) and `<p>{"No chats"}</p>` are both visible; intra-node whitespace
  is normalized so a reindent does not churn the ledger.
- `.ts` files are parsed as TypeScript, `.tsx` files as TSX. This prevents generic syntax in
  ordinary `.ts` files (`<T>`, `ReadonlySet<...>`) from being misread as JSX — which would flood
  the ledger with code fragments — and keeps the JSX passes accurate for real UI components.
- The ledger keys on literal text, not line number, so moving a known literal within its file is
  invisible (correctly) — but so is swapping a listed literal for a different string that happens to
  match another listed entry in the same file.
- Copy in `packages/keiko-editor` and the server packages is out of scope; this gate is the Keiko UI
  package only.
