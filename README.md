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
  <a href="https://sonarcloud.io/summary/new_code?id=oscharko-dev_Keiko"><img alt="Quality gate" src="https://sonarcloud.io/api/project_badges/measure?project=oscharko-dev_Keiko&metric=alert_status"></a>
  <img alt="Local first" src="https://img.shields.io/badge/runtime-local--first-1F2937.svg">
</p>

<p align="center">
  <a href="https://github.com/oscharko-dev/Keiko-for-Quality"><picture>
    <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/oscharko-dev/Keiko-for-Quality/quality-cards/cards/oscharko-dev/Keiko-light.svg">
    <img src="https://raw.githubusercontent.com/oscharko-dev/Keiko-for-Quality/quality-cards/cards/oscharko-dev/Keiko.svg" width="340" alt="Reviewed by Keiko for Quality">
  </picture></a>
</p>

<p align="center">
  <a href="#download">Download</a>
  ·
  <a href="#quickstart-with-npm">npm</a>
  ·
  <a href="#whats-in-03">What's in 0.3</a>
  ·
  <a href="https://github.com/oscharko-dev/Keiko/blob/dev/CONTRIBUTING.md">Contributing</a>
  ·
  <a href="https://github.com/oscharko-dev/Keiko/blob/dev/SECURITY.md">Security policy</a>
</p>

---

Keiko turns a repository, your documents and your models into one calm place to work: chat with the models you configure, understand a codebase, generate reviewable tests, investigate bugs, run verification — and keep a memory of what was learned along the way. Everything runs on your machine, every action stays within the authority you grant, and everything Keiko does leaves redacted evidence a human can review.

## What you get

- **A workspace that understands your repository** — inspect, search and reason over real code, not snippets.
- **Chat with your own models** — bring the endpoints you already trust; Keiko never ships or hides credentials.
- **A coding workbench with a managed agent runtime** — the bundled OpenCode sidecar plans and edits inside a verified sandbox, under autonomy modes you choose.
- **Test generation, bug investigation, verification** — reviewable outcomes with honest state: no green over a broken gateway, every refusal names its reason.
- **Memory that learns from experience** — decisions and findings persist locally and sharpen future answers; local knowledge retrieval runs on a fast approximate-nearest-neighbour index.
- **Governance you can show an auditor** — human-controlled autonomy, fail-closed trust boundaries, and body-free evidence: counts, hashes and statuses, never your content.

## Download

The desktop packages install in one step and include everything — Node.js runtime and the OpenCode coding sidecar bundled, nothing else to install.

**[Download the latest release →](https://github.com/oscharko-dev/Keiko/releases/latest)**

| Platform              | Package                                                  |
| --------------------- | -------------------------------------------------------- |
| macOS (Apple Silicon) | `keiko-macos-arm64.zip`                                  |
| macOS (Intel)         | `keiko-macos-x64.zip`                                    |
| Windows x64           | `keiko-windows-x64-setup.exe` or `keiko-windows-x64.zip` |

First launch: macOS asks once for **System Settings → Privacy & Security → Open Anyway** (the 0.3 line ships as an evaluation build without an Apple developer signature — stated plainly in every release). Windows shows the SmartScreen notice once — **More info → Run anyway**. Keiko then opens at `http://127.0.0.1:1983`.

## Quickstart with npm

For developers who prefer the package manager path:

```bash
npm install -g @oscharko-dev/keiko
```

```bash
keiko init && keiko start
```

Run it inside a project with a `package.json`; the UI opens at `http://127.0.0.1:1983` (`keiko stop` shuts it down, `keiko start --port <n>` picks another port). Configure a chat model in Settings, add a project path, and start working. The coding sidecar ships with the desktop packages above and with repository checkouts — the npm install reports it honestly as unavailable rather than pretending.

## What's in 0.3

- Multi-root editor workspaces with an explicit **Workspace Trust** gate — a new workspace stays restricted until you grant trust.
- Editor profiles, portable profile import/export, and per-file local history with a keyboard-operable timeline.
- Faster local knowledge: retrieval now runs on an approximate-nearest-neighbour index, built on demand from vectors you already have.
- Honest readiness everywhere — Coding Workbench, Chat, Git, Prompt Enhancer, MemoriaViva and Quality Intelligence report real state, and every refused action carries a copyable support id.
- Voice turns carry their attachments and document context; interrupting an answer cancels only that answer.
- Governed Git delivery authenticates on every network path and tells offline apart from authentication failure.
- First public download release: evaluation desktop packages for macOS and Windows with the OpenCode sidecar included.

## Principles

- **Human-controlled by design.** You select the task, the autonomy mode and the authority envelope; hard limits fail closed.
- **Local-first.** Your repositories, memory and evidence live on your machine.
- **Evidence over trust.** Manifests and audit exports carry counts, scopes and hashes — never raw content.
- **Honest state.** No silent failure, no green over broken.

## Requirements

Node.js 24.18 LTS and npm 11.16 for the npm path — the desktop packages bring their own runtime.

## Learn more

- [Documentation](https://github.com/oscharko-dev/Keiko/tree/dev/docs) — architecture decisions, design system, troubleshooting
- [Contributing](https://github.com/oscharko-dev/Keiko/blob/dev/CONTRIBUTING.md) — the quality bar and how changes land
- [Security policy](https://github.com/oscharko-dev/Keiko/blob/dev/SECURITY.md) — reporting and boundaries
- [Report a finding](https://github.com/oscharko-dev/Keiko/blob/dev/docs/user-finding-report.md) — structured, account-free intake

## License

[Apache 2.0](https://github.com/oscharko-dev/Keiko/blob/dev/LICENSE) — © Oliver Scharkowski
