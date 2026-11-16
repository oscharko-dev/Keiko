# Windows development UI investigation — 2026-11-16

This is an ongoing functional investigation from `dev`
`1906b6a5f28a4ec51fa93a18a3affade7194a126`, following the published 1.5.0 UI campaign.
It is not a release qualification or a completed acceptance report.

## Environment and setup actually exercised

- Windows 11 ARM64 VM, with the supported Node 26.13.1 **x64 process** under Windows emulation.
  This does not qualify native Intel/AMD hardware.
- Eight virtual CPUs and 16 GiB RAM; about 9–10 GiB guest RAM remained free during setup.
- A complete checkout and separate development state on the Windows system volume.
  The installed 1.5.0 application's state was retained.
- Visual Studio 2022 Build Tools with the x64/x86 C++ component, verified through the signed
  Microsoft installer; Node's archive matched the upstream SHA-256 manifest.
- npm installed 1,006 packages. USearch and ripgrep provisioning, the package/root build, and
  native development-runtime staging completed. An npm update notice caused the initial
  PowerShell wrapper to report failure after installation; the subsequent build completed.
- The existing `gateway-service install --dev-lane` path completed through its UAC prompt.
  The service reports ready. No pin, confinement rule, or qualification flag was relaxed.
- The trusted development launcher serves the actual Windows Edge UI. **Connect browser**
  established the browser session. Azure/GPT-5.4 configuration was tested and saved through
  the UI with credentials entered separately from the import file.

The runtime remains `functional-not-platform-qualified`. This setup does not resolve the
published-installer finding [#4404](https://github.com/oscharko-dev/Keiko/issues/4404), whose
existing implementation owner is [#4068](https://github.com/oscharko-dev/Keiko/issues/4068).

## Current first-run blocker

The small synthetic repository contains only `package.json`, `sum.js`, and `sum.test.js`, with
two intentionally failing addition tests. Git's real UI opens it on `main` and reports a clean
tree. Its local `core.autocrlf` setting is false.

Selecting that repository in Coding Workbench offers **New local worktree**, GPT-5.4, and
**Ask for approval**. The runtime and model are available, but workspace preparation fails:
the UI asks the person to choose a branch in Git, and Start remains disabled. Retrying reproduces
the refusal. The Activity Log records a successful Git status read followed by HTTP 500 from
`POST /api/task-workspaces`, with `GitWorktreeSpawnError` at the existing worktree adapter's
repository-root probe. The specific spawn cause is still under investigation.

**No successful Coding run or product-managed test execution is claimed.**

## Repair and acceptance queue

The related confirmed findings are the stale Editor refresh warning
([#4403](https://github.com/oscharko-dev/Keiko/issues/4403)), unreadable stale Knowledge cursor
results ([#4405](https://github.com/oscharko-dev/Keiko/issues/4405)), truncated filename links
([#4406](https://github.com/oscharko-dev/Keiko/issues/4406)), and misleading Chat Skills recovery
after browser-session expiry ([#4407](https://github.com/oscharko-dev/Keiko/issues/4407)).
Fixes require failure-first targeted regressions, independent review, and real Windows UI
acceptance. Reports must distinguish a rejected operation from an executed effect and a model
claim from an actual approval card or downloadable result.

Continue with Coding, Knowledge Pods, Chat, Jira Pod, and Git, including cancellation, retry,
reload, and restart. Use Azure/GPT-5.4 first and then LiteLLM/Gemma. Model tests use only small
synthetic fixtures; the Keiko checkout is for implementation and deterministic checks. The
owner's Azure allowance is at most USD 75. Existing spend accounting must not be reset.

Publish small reviewable increments with a current PR description and auto-merge disabled.
During implementation run only affected checks; complete the final applicable coverage, test,
and gate requirements after the whole implementation. Keep every finding open until its fix
is verified and integrated. Release 1.5.0 is already published; another release is outside this
investigation.
