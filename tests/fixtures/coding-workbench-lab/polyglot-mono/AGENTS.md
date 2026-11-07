# AGENTS.md

- Java 17, Maven multi-module (`core`, `api`); `services/legacy` is a standalone Maven project.
- Build and test with the wrapper: `./mvnw -B verify`, or one module with `./mvnw -B -pl api -am verify`.
- The web workspaces live under `web/` (`npm test` at the root runs them).
- Keep amounts in integer cents; never use floating point for money.
