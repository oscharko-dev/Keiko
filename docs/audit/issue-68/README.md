# Issue #68 Shell Audit Evidence

This directory contains curated browser evidence for the Issue #68 audit pass. The screenshots were captured from a live local `keiko ui` BFF using a temporary SQLite database outside the repository and a temporary seeded project. They contain no secrets, provider configuration, runtime logs, or repository file contents.

## Browser Captures

| Artifact                                                   | Viewport   | Purpose                                                                                                                                                    |
| ---------------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [desktop-shell.png](./desktop-shell.png)                   | 1440 x 900 | Desktop shell with project sidebar, central chat/composer, default chat model, workflow modes, secondary Config/Evidence links, and right workspace tools. |
| [desktop-focus.png](./desktop-focus.png)                   | 1440 x 900 | Keyboard focus evidence for visible focus styling against the dark Keiko theme.                                                                            |
| [mobile-shell.png](./mobile-shell.png)                     | 390 x 844  | Compact mobile shell with collapsed project rail, bottom workspace tool bar, unclipped composer controls, and no horizontal overflow.                      |
| [mobile-sidebar-overlay.png](./mobile-sidebar-overlay.png) | 390 x 844  | Mobile sidebar expanded as an overlay so it does not shrink or destabilize the chat workspace.                                                             |

## Measured Browser Invariants

- Desktop `1440 x 900`: document `scrollWidth` equals `clientWidth` (`1440`), project sidebar width `240`, main width `1144`, right tool rail width `56`, model select width `1021`.
- Mobile `390 x 844` collapsed: document `scrollWidth` equals `clientWidth` (`390`), project rail width `48`, main width `342`, bottom tool bar width `390`, model select width `262`.
- Mobile `390 x 844` expanded sidebar: document `scrollWidth` equals `clientWidth` (`390`), sidebar overlay width `240`, main stays width `390`, bottom tool bar stays width `390`.
- Model dropdown options are the registry-order `kind === "chat"` slice only: `Qwen3-Coder-480B-A35B-Instruct-FP8`, `Qwen/Qwen3-Coder-Next-FP8`, `Devstral-2-123B-Instruct-2512`, `gpt-oss-120b`, `Mistral-Small-3.1-24B-Instruct-2503`, `Qwen2.5-Coder-7B-Instruct`, `gemma-4-31b-it`.
- The selected default model is `Mistral-Small-3.1-24B-Instruct-2503`.
