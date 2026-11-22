# Coding Workbench run cannot resolve dependencies from an internal repository

| Field             | Value                                                                                                        |
| ----------------- | ------------------------------------------------------------------------------------------------------------ |
| Severity          | High                                                                                                         |
| Surface           | Run engine / Workspace                                                                                       |
| Stable identifier | Activity Log operation `coding-runtime.repository-relay` and `coding-runtime.native-build-settings.admitted` |

**Symptom**

A Coding Workbench run builds a Maven or npm project and the build fails while it fetches a parent
POM, a plugin or a package: the build output reports an unresolvable artifact, an unauthorized or
forbidden answer, a refused connection to the repository, or (below Full access) an offline-mode
message. The run then cannot verify its change and does not end as succeeded. The same build works
in your own terminal.

**Root Cause**

Keiko keeps your repository credential out of the run's settings and files. Keiko reads your
user-level `~/.m2/settings.xml`, `~/.m2/settings-security.xml` and `~/.npmrc`, and binds each
mirror, repository and registry it can resolve to a per-run, read-only credential relay on the
run's loopback address
([ADR-0184](../adr/ADR-0184-repository-credential-relay-for-coding-runs.md)). A repository that
Keiko cannot resolve or bind is left out, and the run reaches it without a credential. The closed
reasons are listed in `relayRefusalReasons` of the build-settings line. The relay also refuses a
request or a response that breaks its rules: a path outside the repository layout, a compressed
answer, a response that contains the credential, a repository that rejects the credential, or an
exhausted budget.

One limit applies on macOS. A credential written as `${env.NAME}` (Maven) or `${NAME}` (npm) is read
from Keiko's own environment. If you exported that variable in the shell that starts Keiko, the
value is part of Keiko's process arguments and environment, and the operating system lets any
process of your user read it, including a shell the model runs (ADR-0137 D10, ADR-0184 D2). Keiko
cannot remove it from there. Credentials kept in the settings file or the npm config do not have
this limit: a run can read neither `~/.m2/settings.xml` nor `~/.npmrc`.

**Diagnostic Steps**

```bash
keiko support export   # prints the path of the private report it writes
keiko support analyze <report.json> --json
```

In the timeline, find the run's `coding-runtime.native-build-settings.admitted` line. Its
`relayMavenBoundCount` and `relayNpmBoundCount` say how many repositories were bound, and
`relayRefusalReasons` says why others were left out. Then read the run's
`coding-runtime.repository-relay` lines: a `refused` or `failed` outcome carries the closed
`reason`, and the `settled` line counts requests, upstream client and server errors and bytes.

- `url-interpolated`, `interpolation-unsupported`, `env-unavailable`: the repository URL contains a
  placeholder, or a credential placeholder names an environment variable Keiko cannot read. Keiko
  never reads its own or a model provider's variables.
- `credential-too-short`, `credential-incomplete`, `encrypted-master-missing`,
  `encrypted-decrypt-failed`: the credential cannot be used as written.
- `id-missing`, `id-ambiguous`: a Maven repository has no id, or one id names two URLs (in a mirror
  or in any profile, active or not). Such an id is relayed for none of its repositories.
- `rewrite-missed`: Keiko could not point every element of a bound repository at the relay, so it
  left that repository out rather than send its credential to the wrong place.
- `profile-inactive`: the repository belongs to a profile that is not active (not in
  `activeProfiles` and not active by default). It is not relayed and gets no credential; a build that
  activates the profile with `-P` fails with a 401 for exactly this reason.
- `upstream-rejected`: the repository answered the credential with an authentication failure.
- `credential-in-response`: a served file contains the credential.
- `npm_config_offline` / `ENOTCACHED` below Full access with `relayNpmBoundCount` above zero: not
  expected, because a bound npm registry lifts the shell's offline setting. With `relayNpmBoundCount`
  at zero no registry was bound, so the shell stays offline below Full access.
- A build works only while the credential is exported in the shell that starts Keiko, or your
  settings use `${env.NAME}` or `${NAME}`: the credential is in Keiko's environment, see the limit
  above.
- No relay line at all and no bound repository: the repository is not in your user-level files, or
  it belongs to a profile that is not active.

**Resolution**

1. For a rejected credential, renew it where you keep it (`~/.m2/settings.xml` or `~/.npmrc`), then
   start a new run.
2. Write the repository URL without placeholders. Prefer the credential itself in
   `~/.m2/settings.xml` (plain or Maven-encrypted) or in `~/.npmrc`. If you use `${env.NAME}` (Maven)
   or `${NAME}` (npm), only in the credential fields and with a variable that is not Keiko's own,
   know that on macOS a run's shell can read it from Keiko's environment.
3. Give each Maven repository an `id` and make the `servers` entry use the same id.
4. Use a repository token instead of a short or common password. A credential of fewer than eight
   characters is not bound, and a short one that also occurs in a served file is refused.
5. Put the repository in a profile named in `activeProfiles` (or active by default), or use a
   mirror.
6. Do not copy credentials into the project, the run's folder or its environment, and do not export
   them into the environment that starts Keiko; the relay exists so that the run never needs them.
   Keiko's boundary that keeps credentials out of a run must stay.
