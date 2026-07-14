---
title: "Architecture and public surface"
description: "Check package direction, shared contracts, ADRs, and exported runtime surfaces"
when: "Pull requests that change package dependencies, cross-package contracts, public exports, server or UI boundaries, ADRs, or package manifests"
actions: "Post a comment with the applicable package-direction, contract-boundary, ADR-index, build, and package-surface verification checklist; identify violations as blocking review findings"
---

# Architecture and public-surface checks

- Confirm dependencies still point inward according to ADR-0019.
- Confirm shared wire types are owned by `keiko-contracts` and are not re-declared.
- Confirm public exports and packaged runtime surfaces have deterministic local proof.
- Confirm an architectural behavior change is recorded in an existing or new indexed ADR.
- Require reuse or extension of an existing subsystem before accepting new parallel surface area.
