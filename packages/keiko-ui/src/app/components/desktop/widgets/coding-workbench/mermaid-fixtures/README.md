# Mermaid output fixtures

What Mermaid 11.17.2 really draws for six diagram types, with the Coding Workbench's own
configuration (`mermaidConfig` in `../codingWorkbenchDiagram.ts`, dark theme), rendered by
`mermaid.render` in Chromium. `codingWorkbenchDiagram.test.ts` checks the SVG allowlist against these
files, so the allowlist is proven against real renderer output and not only against hand-written SVG.

Each file covers something a hand-written SVG does not:

| File            | Covers                                                                                        |
| --------------- | --------------------------------------------------------------------------------------------- |
| `flowchart.svg` | `marker-end="url(#…)"`, `filter`/`feDropShadow`, gradients, `classDef` and `style` attributes |
| `sequence.svg`  | `symbol` definitions and markers                                                              |
| `pie.svg`       | a stylesheet referencing a gradient by id                                                     |
| `sankey.svg`    | gradient ids that do not carry the diagram id                                                 |
| `treemap.svg`   | `clipPath` references                                                                         |
| `journey.svg`   | a `switch` offering HTML in a `foreignObject` beside its plain SVG fallback                   |

The test fails when `packages/keiko-ui/package.json` pins another Mermaid version. To capture the
files again for that version, render each source below with `mermaid.render("keiko-diagram-<n>", …)`
in Chromium (Playwright), numbering the sources from 1 in this order, after
`mermaid.initialize(mermaidConfig(true))`, and rename this folder to the new version:

1. `flowchart LR` · `A[Start] --> B{Ok?}` · `B -->|yes| C[Done]` · `B -.-> D((Retry))` ·
   `classDef hot fill:#f96,stroke:#333` · `class A hot` · `style C fill:#bbf`
2. `sequenceDiagram` · `Alice->>Bob: Hello` · `Bob-->>Alice: Hi`
3. `pie title Pets` · `"Dogs" : 386` · `"Cats" : 85`
4. `sankey-beta` · `A,B,10` · `B,C,5`
5. `treemap-beta` · `"A"` · `  "B": 10`
6. `journey` · `title Day` · `section Go` · `  Walk: 5: Me`

Each `·` is a line break.
