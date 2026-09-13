<p align="center">
  <img src="https://raw.githubusercontent.com/oscharko-dev/Keiko/dev/packages/keiko-ui/public/keiko-logo.svg" alt="Keiko logo" width="144" />
</p>

<h1 align="center">Keiko</h1>

<p align="center"><strong>Ex experientia disco</strong></p>

<p align="center">
  The governed agentic workspace for professional knowledge work.<br />
  Local-first. Human-controlled. It learns from experience.
</p>

<p align="center">
  <a href="https://github.com/oscharko-dev/Keiko/blob/dev/LICENSE"><img alt="License" src="https://img.shields.io/badge/license-Apache%202.0-4EBA87.svg"></a>
  <a href="https://github.com/oscharko-dev/Keiko/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/oscharko-dev/Keiko/actions/workflows/ci.yml/badge.svg?branch=dev"></a>
  <a href="https://github.com/oscharko-dev/Keiko/actions/workflows/codeql.yml"><img alt="CodeQL" src="https://github.com/oscharko-dev/Keiko/actions/workflows/codeql.yml/badge.svg?branch=dev"></a>
  <img alt="Local first" src="https://img.shields.io/badge/runtime-local--first-1F2937.svg">
</p>

<p align="center">
  <a href="https://sonarcloud.io/project/overview?id=oscharko-dev_Keiko"><img alt="Quality gate" src="https://sonarcloud.io/api/project_badges/measure?project=oscharko-dev_Keiko&metric=alert_status"></a>
  <a href="https://sonarcloud.io/project/overview?id=oscharko-dev_Keiko"><img alt="Lines of code" src="https://sonarcloud.io/api/project_badges/measure?project=oscharko-dev_Keiko&metric=ncloc"></a>
  <a href="https://sonarcloud.io/project/overview?id=oscharko-dev_Keiko"><img alt="Coverage" src="https://sonarcloud.io/api/project_badges/measure?project=oscharko-dev_Keiko&metric=coverage"></a>
  <a href="https://sonarcloud.io/project/overview?id=oscharko-dev_Keiko"><img alt="Maintainability" src="https://sonarcloud.io/api/project_badges/measure?project=oscharko-dev_Keiko&metric=sqale_rating"></a>
  <a href="https://sonarcloud.io/project/overview?id=oscharko-dev_Keiko"><img alt="Security" src="https://sonarcloud.io/api/project_badges/measure?project=oscharko-dev_Keiko&metric=security_rating"></a>
</p>

<p align="center">
  <a href="https://www.oscharko.dev">Product page</a>
  ·
  <a href="#download">Download</a>
  ·
  <a href="#install-with-npm">npm</a>
  ·
  <a href="#whats-in-10">What's in 1.0</a>
  ·
  <a href="https://github.com/oscharko-dev/Keiko/blob/dev/CONTRIBUTING.md">Contributing</a>
  ·
  <a href="https://github.com/oscharko-dev/Keiko/blob/dev/SECURITY.md">Security policy</a>
</p>

---

Keiko turns your repository, your documents and your models into one calm place to work: chat with the models you configure, understand a codebase, generate reviewable tests, investigate bugs, and keep a memory of what was learned along the way. Everything runs on your machine, and every action stays inside the authority you grant.

## What you get

- **A workspace that understands your repository** — inspect, search and reason over real code, not snippets.
- **Your own models** — bring the endpoints you already trust; Keiko never ships or hides credentials.
- **A coding workbench** — plan and edit inside a verified sandbox, under an autonomy mode you choose. It can take an issue all the way to a pull request in one governed run.
- **Tests, investigations, verification** — reviewable outcomes with honest state: no green over a broken gateway, and every refusal names its reason.
- **Memory that learns from experience** — decisions and findings persist locally and sharpen future answers.
- **Evidence you can show an auditor** — counts, hashes and statuses; never your content.

## Download

The desktop packages install in one step and include everything — runtime and coding sidecar bundled, nothing else to install.

**[Download the latest release →](https://github.com/oscharko-dev/Keiko/releases/latest)**

| Platform              | Package                                                  |
| --------------------- | -------------------------------------------------------- |
| macOS (Apple Silicon) | `keiko-macos-arm64.zip`                                  |
| macOS (Intel)         | `keiko-macos-x64.zip`                                    |
| Windows x64           | `keiko-windows-x64-setup.exe` or `keiko-windows-x64.zip` |
| Linux x64             | `keiko-linux-x64.zip`                                    |

Keiko is an open-source project and does not yet buy Apple and Microsoft code-signing certificates, so macOS and Windows ask once before the first launch: on macOS **System Settings → Privacy & Security → Open Anyway**, on Windows SmartScreen **More info → Run anyway**. Every release states this plainly. Keiko then opens at `http://127.0.0.1:1983`.

## Install with npm

```bash
npm install -g @oscharko-dev/keiko
```

```bash
keiko init && keiko start
```

Run it inside a project with a `package.json`. The UI opens at `http://127.0.0.1:1983` — `keiko stop` shuts it down, `keiko start --port <n>` picks another port. Requires Node.js `>=24.18.0 <25 || >=26.3.0 <27`; the desktop packages bring their own runtime. The coding sidecar ships with the desktop packages and with repository checkouts — the npm install reports it honestly as unavailable rather than pretending.

## What's in 1.0

1.0 is the first stable major. The published surface is unchanged from 0.3.17 — nothing was added, removed or renamed — so what changes is the promise around it: **`1.x` is the supported line, and a breaking change to it requires a new major release.**

- Updates are production-ready on Windows, macOS and Linux, and a failed update preserves the complete current install.
- The Coding Workbench takes an issue to a pull request in one governed run, and an approved changeset edit now lands instead of expiring beneath the decision.
- Linux x64 joins macOS and Windows as a downloadable package, with its coding runtime shipping qualified and generated code reaching the network only through the gateway boundary.
- Windows installs through a native bootstrap, with the setup executable's digest bound into the published manifest.
- Every Git outcome can be reconstructed from the activity log alone.
- Grounded retrieval is bounded on large workspaces, and local knowledge retrieval runs on a fast approximate-nearest-neighbour index.
- Security: Next.js 16.3.3 closes two critical advisories.

## Principles

- **Human-controlled by design.** You select the task, the autonomy mode and the authority envelope; hard limits fail closed.
- **Local-first.** Your repositories, memory and evidence live on your machine, and Keiko serves loopback only.
- **Evidence over trust.** Manifests and audit exports carry counts, scopes and hashes — never raw content.
- **Honest state.** No silent failure, no green over broken.

## Learn more

- [oscharko.dev](https://www.oscharko.dev) — the product page
- [Documentation](https://github.com/oscharko-dev/Keiko/tree/dev/docs) — architecture decisions, design system, troubleshooting
- [Operator runbook](https://github.com/oscharko-dev/Keiko/blob/dev/docs/ui-runbook.md) — the full operator reference
- [Contributing](https://github.com/oscharko-dev/Keiko/blob/dev/CONTRIBUTING.md) — the quality bar and how changes land
- [Security policy](https://github.com/oscharko-dev/Keiko/blob/dev/SECURITY.md) — reporting and boundaries
- [Report a finding](https://github.com/oscharko-dev/Keiko/blob/dev/docs/user-finding-report.md) — structured, account-free intake

## License

[Apache 2.0](https://github.com/oscharko-dev/Keiko/blob/dev/LICENSE) — © Oliver Scharkowski
