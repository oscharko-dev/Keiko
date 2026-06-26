# Local Runtime Capabilities

Issue #1385 adds a read-only runtime inventory for Keiko's local BFF. The endpoint is:

```text
GET /api/runtime/capabilities
GET /api/runtime/capabilities?root=/absolute/registered/project
```

The route is intentionally non-blocking. Missing Git, Node, package managers, language toolchains,
or container engines are reported as structured capability states and never prevent core editor
loading or basic file editing.

## Supported Capability Families

Host executable presence is detected for:

- Git: `git`
- Node runtime: `node`
- Package managers: `npm`, `pnpm`, `yarn`
- Language toolchains: `python3`, `java`, `go`, `rustc`, `cargo`, `shellcheck`
- Container engines: `docker`, `podman`

When a registered project root is supplied, Keiko also reports command-source metadata from safe
workspace manifests:

- `package.json` script names for `test`, `build`, `lint`, and `typecheck`
- `packageManager` metadata in `package.json`
- Lockfiles: `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`
- Common manifests: `Cargo.toml`, `go.mod`, `pyproject.toml`, `pom.xml`, `build.gradle`,
  `build.gradle.kts`, and `Dockerfile`

Only relative workspace paths and script names are returned. Script bodies, source text, absolute
tool paths, environment values, raw command output, and Git configuration are not returned.

## Optional Prerequisites

Install only the tools needed for the workflows you use. Keiko reports unavailable tools with
remediation hints, but no listed tool is mandatory for the editor itself.

- Git workflows need `git` available on `PATH`.
- Node package workflows need `node` plus the relevant package manager.
- Python, Java, Go, Rust, and Shell language workflows need their corresponding host tools.
- Container-backed workflows need Docker or Podman available on `PATH`; the capability detector
  does not contact the daemon or start containers.

## Safety Model

Runtime detection is metadata-only:

- It does not execute `npm`, `pnpm`, `yarn`, `bun`, `pip`, `poetry`, `cargo`, `go`, `gradle`, `mvn`,
  `docker`, `podman`, or `git`.
- It does not run package scripts, lifecycle hooks, Gradle wrappers, Make targets, Git hooks, or
  workspace-defined commands.
- It does not read `.git/config` or trust repository Git configuration.
- Executables resolving inside the workspace, through a workspace symlink, or through group/world
  writable POSIX paths are reported as unavailable by policy.
- Detection is deadline-bound and best-effort; partial inventory is safer than blocking the editor.
