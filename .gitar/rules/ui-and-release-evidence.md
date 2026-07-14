---
title: "UI and release evidence"
description: "Protect i18n, accessibility, visual proof, release impact, and platform-authoritative evidence"
when: "Pull requests that change keiko-ui, user-visible behavior, design-system assets, global CSS, editor bundles, release metadata, or operator documentation"
actions: "Post a comment with the applicable EN/DE i18n, accessibility, focus, visual-proof, editor-evidence, release-impact, and troubleshooting verification checklist; identify stale or non-authoritative evidence as a blocking review finding"
---

# UI and release-evidence checks

- Require English/German catalog parity and no hard-coded user-facing strings.
- Require keyboard, focus, narrow-layout, contrast, reduced-motion, and axe coverage as applicable.
- Treat `globals.css` and editor release fingerprints as pinned evidence surfaces.
- Require Linux evidence where the repository declares Linux authoritative.
- Require release-impact and troubleshooting updates for user-visible or operator-visible behavior.
