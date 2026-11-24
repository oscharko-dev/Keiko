# Window Content Not Loaded After A Keiko Update

## Reload a tab that still runs the previous Keiko version

| Field             | Value                                                                               |
| ----------------- | ----------------------------------------------------------------------------------- |
| Severity          | Medium                                                                              |
| Surface           | Local UI                                                                            |
| Stable identifier | `Part of Keiko could not be loaded`, `data-window-body-crashed="chunk-load"` marker |

**Symptom**

A window opened in a browser tab that stayed open across a Keiko update or restart shows
“Part of Keiko could not be loaded” with a **Reload Keiko** button instead of its content. Other
windows that were already open keep working. Keiko 1.5.8 and earlier showed “This window hit an
error” in the same situation, with a Retry button that could not recover it.

**Root Cause**

The browser tab keeps the program files of the version it loaded. Keiko loads the code of most
windows only when a window is first opened. After `keiko update apply` and a restart, the server
ships the new version, and the old tab asks for a file the new version no longer contains. The
server answers that request with `404 NOT_FOUND`, and the window reports the failure as
unavailable instead of internal. Re-rendering cannot recover it, because the browser keeps the
failed request; only a page load fetches the current version.

When the tab is re-paired through the launcher link in the same tab, Keiko compares the server
version with the first version the page read after it loaded, and reloads the page by itself when
they differ. That check is skipped, and the notice above shows when the tab next opens a window,
in two cases: the tab regained its session through another tab's pairing, or the tab could not
read the server version before the update (its first health read failed).

**Diagnostic Steps**

```bash
keiko status
keiko support export   # prints the path of the private report it writes
keiko support analyze <report.json> --json
```

The client diagnostic `[keiko] window body crashed: <window type>: ChunkLoadError` with
`errorKind: "unavailable"` confirms this entry, as does an `http request` line with status `404`
for a route under `/_next/`. A window failure with `errorKind: "internal"` is a different defect;
report it with the support report.

**Resolution**

1. Press **Reload Keiko** in the window, or reload the browser tab.
2. Keiko restores the open windows after the reload; the app session stays valid.
3. Close other tabs that still show the previous version, or reload them as well.
