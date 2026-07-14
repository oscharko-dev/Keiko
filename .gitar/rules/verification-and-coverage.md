---
title: "Verification and coverage"
description: "Require local-first regression proof and non-vacuous current-head quality evidence"
when: "Pull requests that change executable source, tests, fixtures, quality gates, coverage configuration, generated evidence, or CI behavior"
actions: "Auto-apply owning-layer fixes for attributable failures, add failure-first regression and boundary tests, and post the local pre-PR, coverage-reserve, current-head evidence, and affected-area gate checklist; keep vacuous, stale, skipped, or remote-only proof blocking"
---

# Verification and coverage checks

- Require a regression test that fails without the behavioral fix.
- Require empty, malformed, boundary, hostile, and both-guard-branch coverage where applicable.
- Require local reproduction before a remote repair push and a full local pre-PR rerun afterward.
- Require changed executable source to map to real coverage with reserve above the enforced floor.
- Treat skipped, cancelled, stale, unparseable, or wrong-producer evidence as blocking.
