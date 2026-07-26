# Local SonarQube — run this before every pull request

```bash
npm run gates:sonar
```

**Run it before you open or update a pull request against `dev`. Not after. Not "if the diff looks
risky".** A finding SonarCloud reports is a full CI round and a review round; a finding this command
reports costs a minute.

## Why this exists — the gap it closes

`npm run check:sonar-rules` runs `eslint-plugin-sonarjs`. That plugin carries **279 rules in every
published version up to and including 4.2.0**, verified against the npm registry. The SonarJS
analyzer SonarCloud runs carries hundreds more, and the rules that have actually cost this repository
CI rounds live in that difference:

| Rule    | What it wants                                                   | In the ESLint plugin? |
| ------- | --------------------------------------------------------------- | --------------------- |
| `S7786` | `TypeError` / `RangeError`, not `Error`, after a type check     | no                    |
| `S7755` | `.at(-1)`, never `[x.length - 1]`                               | no                    |
| `S7778` | one `Array#push` with several arguments, not consecutive pushes | no                    |
| `S7776` | a `Set`, not `.includes()` on a constant array                  | no                    |

Shell rules SonarCloud runs and no local tool reproduces — check these by hand on a changed `.sh`:

| Rule             | What it wants                                      |
| ---------------- | -------------------------------------------------- |
| `shelldre:S7688` | `[[ … ]]`, never `[ … ]`                           |
| `shelldre:S7679` | bind a positional parameter to a named local first |
| `shelldre:S131`  | every `case` has a `*)` default                    |

A green `check:sonar-rules` therefore says **nothing** about these. Only a real analyzer does, which
is what this command runs. The `Coverage and SonarCloud` job demands **zero** unresolved issues, so a
single MINOR of this class fails the required `ci` context.

## What it does, exactly

1. Starts a **self-hosted** SonarQube (digest-pinned, bound to `127.0.0.1:9234`) from
   `docker/gates/sonar-compose.yml`. First start pulls the image and takes a few minutes; every later
   start reuses the cached volumes and takes seconds.
2. Provisions a local analysis token. There is no account, no secret and no network dependency.
3. Analyses the working tree under a checkout-scoped project key (`keiko-local-<hash>`), so
   several checkouts or agent sessions on one machine can run the lane concurrently without
   overwriting each other's analysis state or revoking each other's in-flight token.
4. Prints the findings that land **on files this branch changed against `origin/dev`**, and exits
   non-zero if there are any.

```bash
npm run gates:sonar          # findings on your diff — the pre-push question
npm run gates:sonar:all      # every finding in the project
npm run gates:sonar:stop     # stop the server, keep its cache
./docker/gates/run-sonar.sh --base main   # diff against another base
```

## What it is not

**It never talks to sonarcloud.io.** A local scan must not publish an analysis over the real
project's pull-request result, so it uses its own project key on its own server. Nothing it produces
is evidence, and nothing downstream may treat it as a verdict.

**It does not analyse shell.** SonarQube Community ships no shell analyzer — `api/languages/list`
has no shell entry and the `shelldre:*` rules do not exist on it — while SonarCloud runs them. A
clean local run therefore says **nothing** about a changed `.sh` file. The lane compensates by
running `shellcheck -S warning` over the changed shell scripts and failing on findings; install it
(`brew install shellcheck`) or the run says out loud that they went unchecked. shellcheck is not a
complete substitute: SonarCloud's `shelldre:S7679` (bind a positional parameter to a name) and
`shelldre:S7688` (`[[` over `[`) have no shellcheck equivalent, so review changed shell by hand
against those two as well.

**It is not the gate.** The verdict stays with SonarCloud on the pull request
([`local-gates.md`](local-gates.md)). Two things differ by construction:

- the quality **profile** is SonarQube's built-in "Sonar way", not the organisation's profile, so a
  rule the organisation activated or silenced may differ;
- **coverage is not imported**, on purpose — coverage has its own gate
  (`npm run check:coverage:new-code`) and importing it here would double the runtime for no signal.

So read a clean run as _"no known rule violation on my diff"_ — which is exactly the question you
need answered before pushing — and never as _"SonarCloud will be green"_.

## When it disagrees with CI

If SonarCloud reports something this did not, the cause is almost always the profile difference
above. Add the rule to the table at the top of this document with the pull request that hit it, so
the next person knows to check it by hand. If this reports something SonarCloud does not, fix it
anyway: the rule is real, and the organisation's profile can change.

## Troubleshooting

| Symptom                                   | Cause and fix                                                                                                                                                                          |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `could not obtain a local analysis token` | The server is up but the bootstrap failed. `npm run gates:sonar:stop`, then `docker volume rm gates_sonar-data` and re-run — the first-run password change is recorded in that volume. |
| The server never becomes healthy          | SonarQube needs roughly 2 GB. Raise Docker Desktop's memory limit, then re-run.                                                                                                        |
| `no diff against origin/dev`              | Fetch first (`git fetch origin`). The scan falls back to reporting every finding in the project.                                                                                       |
| The scan is slow on the first run         | Expected: the analyzer downloads its Node runtime once into a cached volume. Later runs reuse it.                                                                                      |
