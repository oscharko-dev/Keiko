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
   start reuses the cached volumes and takes seconds. Worktrees of one repository share that
   server, its persisted administrator credential, and its cache.
2. Provisions a local analysis token. There is no account, no secret and no network dependency.
3. Partitions committed branch changes plus staged, unstaged, and untracked working-tree files into
   disjoint main-code and test inventories before analysis. A production path is never also passed
   through `sonar.test.inclusions`, because that would suppress main-code rules on the file.
4. Analyses those files under
   a checkout-scoped project key (`keiko-local-<hash>`), so several checkouts or agent sessions on
   one machine can run the lane concurrently without overwriting each other's analysis state or
   revoking each other's in-flight token.
5. Prints the findings that land **on files this branch changed against `origin/dev`**, and exits
   non-zero if there are any. If a changed path cannot be expressed as an exact Sonar inclusion
   (for example, a Next.js `[capsuleId]` route), analysis safely expands to the whole project while
   the report and verdict remain losslessly filtered to the changed-file set.

```bash
npm run gates:sonar          # findings on your diff — the pre-push question
npm run gates:sonar:all      # every finding in the project
npm run gates:sonar:stop     # stop the server, keep its cache
./docker/gates/run-sonar.sh --base main   # diff against another base
```

If port 9234 is occupied by another local analyzer, select an unused loopback port. The port is
part of the Compose-project identity, so this starts an isolated server and leaves the existing
container and volumes untouched:

```bash
KEIKO_LOCAL_SONAR_PORT=9235 npm run gates:sonar
KEIKO_LOCAL_SONAR_PORT=9235 npm run gates:sonar:stop
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

So read a clean run as _"no known rule violation on my diff"_ — which is exactly the local question
you need answered before pushing — and never as _"SonarCloud will be green"_. Required PR CI uses
the cloud profile and, since incidents #3377 and #3380, disables both the analysis cache and
Cloud's injected sensor cache. A Runner-hosted immutable validator requires zero cache hits, an
exact miss receipt for Sonar's complete eligible JS/TS inventory, and architecture-UDG receipts
whose total exactly matches SonarJasmin's own planned-file count, so the pre-merge result has the
same fresh source surface as the following `dev` scan.

## When it disagrees with CI

If SonarCloud reports something this did not, first compare the scanner's `Included sources` and
`Included tests` inventories. A changed production path in the test inventory is a local gate defect
and must be repaired before relying on the scan. Once classification agrees, check the profile
difference above and add a genuinely cloud-only rule to the table at the top of this document with
the pull request that hit it. If this reports something SonarCloud does not, fix it anyway: the rule
is real, and the organisation's profile can change.

## Troubleshooting

| Symptom                                   | Cause and fix                                                                                                                                                                                                                                        |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Port 9234 is already allocated            | Another analyzer is active. Run with an unused `KEIKO_LOCAL_SONAR_PORT` as shown above; do not stop or delete an unrelated server.                                                                                                                   |
| `could not obtain a local analysis token` | The selected server's persisted password and credential file disagree. Stop that same port, remove only its repository/port-scoped `sonar-data` volume and reported credential file, then re-run. Never delete a different Compose project's volume. |
| The server never becomes healthy          | SonarQube needs roughly 2 GB. Raise Docker Desktop's memory limit, then re-run.                                                                                                                                                                      |
| `base origin/dev cannot be resolved`      | Fetch first (`git fetch origin`). Because the diff cannot be determined, analysis and verdict fail closed to the whole project.                                                                                                                      |
| `no diff against origin/dev`              | The diff is known to be empty. Analysis covers the whole project because Sonar cannot accept an empty inclusion, but the verdict remains filtered to zero changed files.                                                                             |
| The scan is slow on the first run         | Expected: the analyzer downloads its Node runtime once into a cached volume. Later runs reuse it.                                                                                                                                                    |
