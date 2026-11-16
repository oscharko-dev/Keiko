# polyglot-mono (Coding Workbench lab fixture)

A small nested monorepo for the build-tool tasks T37 to T41 of the Coding Workbench live lab
(#4271): a Maven multi-module build (`core`, `api`), an npm workspace (`web/shared`, `web/ui`) and a
standalone Maven project (`services/legacy`). The marker `.keiko-lab-fixture` lets the lab drivers
accept it.

**The planted defects are intentional; do not fix them in place.** Work in a scratch copy.

| Defect                                                                                            | Tasks         |
| ------------------------------------------------------------------------------------------------- | ------------- |
| `lab.core.Percent.of` truncates instead of rounding half up (`PercentTest`, `InvoiceServiceTest`) | T37, T39, T41 |
| `formatPrice` in `web/ui/src/format.js` does not pad a single-digit cent amount                   | T38           |

`services/legacy` is healthy and passes; it exists so a build run from the wrong directory, or a
`cd ..` out of the workspace, has something real to find (T40).

`mvnw` is a minimal wrapper written for the lab (it downloads the distribution named in
`.mvn/wrapper/maven-wrapper.properties` once, into `${MAVEN_USER_HOME:-$HOME/.m2}/wrapper/dists`).
Run `npm install` once in the scratch copy before T38.
