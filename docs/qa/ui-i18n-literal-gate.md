# The UI i18n literal gate

`npm run check:ui-i18n` answers three different questions. Knowing which one answers what avoids the
failure mode that made the German locale unreal in a shipped release.

| Question                                                            | Answered by                                           |
| ------------------------------------------------------------------- | ----------------------------------------------------- |
| Did English and German catalog entries land together?               | the catalog-update and key-parity checks              |
| Is any **individual** user-facing string still a hardcoded literal? | the untranslated-literal rule + the ratcheted ledger  |
| Does every catalog entry actually **say** it in both languages?     | the catalog content checks + the identical-terms list |

`npm run check:ui-i18n` judges the files a change touches. `npm run check:ui-i18n:all` judges the whole
tree. CI runs both. The ledger-growth and catalog content checks run in both modes, because a catalog
can drift and a ledger can be widened in a change that touches no UI source.

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

Scope: production `.ts` and `.tsx` under `packages/keiko-ui/src/app/`, `packages/keiko-ui/src/lib/` and
`packages/keiko-editor/src/`. Tests, `.d.ts`, and the i18n layer itself (catalogs, the provider,
`*-i18n.ts` helpers) are not subjects. The editor owns no catalog, a host passes it translated labels
as props, so only this literal rule applies to it, not the catalog-update and "must use the i18n API"
rules.

The value must look like human copy. Machine tokens that live in the same positions — lowercase slugs
and dotted keys (`governed-assist`, `editor.command.runLint`), paths and URLs, `SCREAMING_CASE`,
numbers with units, and template literals made only of `${…}` interpolations — are not reported. The
deliberate consequence is that a lowercase single word in an attribute or registry field is also not
reported: precision is chosen over recall so the gate cannot cry wolf on the hundreds of enum members
and mode names in these positions. The exception is a lowercase word that is the only text of an
element (`<span>optional</span>`), which can only be copy. `<code>`, `<kbd>`, `<pre>` and `<samp>` show
their content verbatim and are exempt from that exception.

## The ledger

`docs/qa/ui-i18n-literal-baseline.json` records the untranslated literals that already existed when
the rule was introduced, per file. It is a ratchet, exactly like the coverage baseline
([`coverage-truth-model.md`](coverage-truth-model.md), ADR-0158):

- a literal listed there is known debt the gate tolerates;
- **any** literal not listed fails the gate, including in a file that already carries debt;
- removing a literal makes the ledger stale, which is itself a failure — regenerate with
  `npm run check:ui-i18n:baseline` so the ledger only ever shrinks.

Never add an entry to silence a new literal. `npm run check:ui-i18n:all` evaluates every tracked
source against the ledger and is what proves gate and tree are in sync.

The gate enforces that the ledger only shrinks by comparing it with the ledger at the fork point from
the base branch. Comparison is per text across files, so a rename or a literal moving between files
adds no debt, while a known literal copied into a second file does. A base ledger that cannot be read
fails the gate. The one sanctioned growth is a change that strengthens the scanner so it sees literals
already in the tree: raise `LITERAL_LEDGER_GENERATION` in the script and regenerate the ledger in that
same change, so the bump and every new entry appear in the diff. Bumping it for any other reason is a
gate bypass.

## The catalog content checks

Key parity cannot see what a catalog says. These checks read every catalog map in `keiko-ui` through
the TypeScript AST on every run ([`scripts/lib/ui-i18n-catalog-content.mjs`](../../scripts/lib/ui-i18n-catalog-content.mjs))
and fail on:

- a key one language declares and the other does not, or a language map with no counterpart;
- a German value that is empty against a non-empty English one;
- a `{placeholder}` set that differs between the languages. Order may differ, German word order does;
- a value identical in both languages, unless it is locale neutral (only punctuation and placeholders,
  a URL, a route, a glob) or listed in
  [`ui-i18n-identical-terms.json`](ui-i18n-identical-terms.json).

The identical-terms list names values, not keys, so a product name needs one entry however many
surfaces show it. Adding a value is a claim that German really uses the same term, and the diff shows
that claim to a reviewer. A listed value no catalog uses any more fails the gate, so the list cannot
keep blessing a term that is gone.

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

- The JSX-text and JSX-attribute positions are scanned via the TypeScript AST. That covers
  multi-line JSX text (`<p>\n  Hello there\n</p>`), string-literal expression containers
  (`<p>{"No chats"}</p>`), and both directly-quoted and expression-valued user-facing
  attributes (`ariaLabel="Foo"`, `aria-label={cond ? "A" : "B"}`, `title={label ?? "Fallback"}`).
  Recursion also covers template substitutions (`` `${cond ? "A" : "B"}` ``), conditional and
  logical operators (`??` / `||` / `&&`), string concatenations (`"A" + name`), transparent
  wrappers (`as const`, `satisfies T`, `!`), and call arguments (`definedOr(x, "fallback")`).
  Intra-node whitespace is normalized so a reindent or rewrap does not churn the ledger.
- Registry-field positions (the `LABEL_FIELD_NAMES` set on option/command objects) are scanned both
  per line and through the AST. The line pass reads a quoted value that starts on the field's own
  line. The AST pass covers the rest: a value the formatter moved to the next line, conditional and
  logical expressions, and quoted keys. A value assembled from variables is still not seen, and nor
  is a method-shorthand field (`label() { … }`).
- A lowercase word as an expression (`<span>{"optional"}</span>`) is not reported, only as JSX text.
- A catalog's content is only compared where it is a plain string. A concatenation or a function keeps
  its key in the parity check, but its value cannot be read. The identical-value check also proves
  nothing about a German value that is different but still English.
- `.ts` files are parsed as TypeScript, `.tsx` files as TSX. This prevents generic syntax in
  ordinary `.ts` files (`<T>`, `ReadonlySet<...>`) from being misread as JSX — which would flood
  the ledger with code fragments — and keeps the JSX passes accurate for real UI components.
- The ledger keys on literal text, not line number, so moving a known literal within its file is
  invisible (correctly) — but so is swapping a listed literal for a different string that happens to
  match another listed entry in the same file.
- Copy produced by the server packages is out of scope. This gate covers what the UI and the editor
  hold in source, not a message a server sends for the UI to show.
- A static scan cannot prove a string assembled at runtime is translated.
