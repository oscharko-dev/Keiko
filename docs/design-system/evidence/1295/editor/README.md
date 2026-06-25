# Issue #1295 — Running editor fidelity evidence

This directory is populated by the packaged-app Playwright harness:

```bash
npm run test:e2e:editor-fidelity-1295
```

The harness starts `dist/cli/index.js ui` through
`playwright.issue-1295-editor-fidelity.config.ts`, opens a synthetic temp workspace in the real
desktop shell, and records live Monaco editor evidence under this fixed directory.

Committed artifacts:

- `manifest.json` — bounded proof of route, fixture type, assertions, theme token values, Monaco
  computed values, and screenshot filenames.
- `dark-source.png`, `light-source.png`, `high-contrast-source.png` — running editor with realistic
  TSX content, tabs, gutter, syntax, status bar, embedded file tree/icons, and theme-specific
  `--ed-*` / `--ed-syn-*` values.
- `dark-find.png`, `light-find.png`, `high-contrast-find.png` — Monaco find widget with live match
  highlighting.
- `dark-split-markdown.png`, `light-split-markdown.png`, `high-contrast-split-markdown.png` — split
  pane with markdown source open through the embedded project tree, with the split-resize hover
  affordance captured in the frame.
- `dark-agent-ghost.png`, `light-agent-ghost.png`, `high-contrast-agent-ghost.png` — implemented
  agent-adjacent editor state via inline ghost text.
- `dark-resize.png` — split-pane resize behavior.
- `dark-compact-overflow.png` — compact hidden-tab chooser with all overflowed documents reachable.
- `dark-large-buffer.png` — large-buffer degraded mode with completions disabled.
- `reduced-motion-focus.png` — keyboard/focus evidence under reduced motion.

The fixture is synthetic and writes no user workspace state, traces, videos, HARs, cookies, request
bodies, or localStorage dumps.
