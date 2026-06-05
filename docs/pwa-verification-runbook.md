# PWA Verification Runbook

## Purpose

This runbook captures the manual evidence required by ADR-0024 D10 before Epic #121
(Installable Keiko PWA) can be closed. The automated tests in
`packages/keiko-server/src/installability.test.ts` cover the headless gates (manifest
content-type, service worker reachability, CSP headers, icon assets, API cache policy).
This runbook covers what requires a real browser and a real desktop: the install prompt,
standalone window behavior, Lighthouse PWA scoring, service worker cache inspection, and
launcher shortcut end-to-end on macOS and Windows.

Captured evidence (screenshots, Lighthouse exports, Lighthouse JSON) is attached to the
final closure comment on GitHub issue #121. It is not committed to the repository.

---

## Prerequisites

- Node.js >= 22 and npm >= 10 installed.
- Keiko installed: `npm install -g @oscharko-dev/keiko` or from the local build via `npm start`.
- One of the following browsers at the specified minimum version:
  - Chrome >= 111
  - Edge >= 111
  - Chromium >= 111
- For the launcher section: a macOS or Windows machine (Linux is first-class for browser
  install but the launcher is also exercised on Linux with the `.desktop` file path).

---

## Browser PWA install matrix

Perform the following checklist for each first-class combination. Mark each row in the
evidence capture template at the end of this document.

### Checklist steps (repeat for each first-class row)

1. Start Keiko:

   ```
   keiko start --open
   ```

   Confirm the terminal prints a local URL and the browser opens to the Keiko UI.

2. Open Chrome DevTools (F12 or Cmd+Option+I). Navigate to **Application > Manifest**.
   Confirm each of the following:

   | Field            | Expected value                          |
   | ---------------- | --------------------------------------- |
   | Name             | Keiko                                   |
   | Short name       | Keiko                                   |
   | Display          | standalone                              |
   | Theme color      | #4EBA87                                 |
   | Background color | #1B1E23                                 |
   | Icons            | 4 entries (192/512 standard + maskable) |

3. Navigate to **Application > Service Workers**. Confirm:
   - One service worker registered at `/sw.js` with scope `/`.
   - Status is **Activated and is running**.

4. Click the browser install button. On Chrome and Edge this appears as an install icon
   in the address bar. On Chromium builds without the toolbar icon, open the three-dot
   menu and select **Install Keiko** or **Create shortcut**. Confirm:
   - The install prompt displays the name **Keiko** and the Keiko icon.

5. Accept the install. Confirm:
   - A standalone Keiko window opens without browser chrome (no address bar).
   - The Keiko icon appears in the OS taskbar (Windows), Dock (macOS), or application
     shelf (Linux).

6. Run a workflow from inside the installed standalone window. Any keiko command that
   produces output in the UI is sufficient (for example, open a project and trigger
   a verification run).

7. Navigate to **Application > Cache Storage > keiko-shell-v1**. Confirm:
   - Zero entries whose URL starts with `/api/`.
   - Entries present include: index HTML, `/manifest.webmanifest`, icon files,
     and `/_next/static/` chunks.

8. Open **Lighthouse** (in DevTools Lighthouse tab or via the standalone CLI). Select
   the **Progressive Web App** category only. Run the audit against the local URL.
   Confirm: PWA score >= 90. Record the score number and the audit URL.

### First-class matrix

| Browser  | Platform | Target                      |
| -------- | -------- | --------------------------- |
| Chrome   | macOS    | All 8 checklist steps above |
| Chrome   | Windows  | All 8 checklist steps above |
| Chrome   | Linux    | All 8 checklist steps above |
| Edge     | macOS    | All 8 checklist steps above |
| Edge     | Windows  | All 8 checklist steps above |
| Chromium | Linux    | All 8 checklist steps above |

---

## Documented fallback rows

The following browsers and platforms do not support the browser install prompt. Per
ADR-0024 D3, these are documented fallbacks; no automated verification gate is required.

| Browser / platform     | Limitation                                                                                            | What to verify manually                                                                                                                                         |
| ---------------------- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Firefox (any platform) | No `beforeinstallprompt` event; no install prompt; no standalone mode. Bookmark the page as fallback. | Navigate to the Keiko URL. Confirm the page loads cleanly with no console errors. Confirm `keiko launcher install` produces a working shortcut.                 |
| Safari >= 17 (macOS)   | No PWA install. No standalone mode on macOS Safari as of Safari 17. Bookmark the page as fallback.    | Same: page loads cleanly, no console errors.                                                                                                                    |
| Safari on iOS >= 16.4  | No `beforeinstallprompt`. Use Share > Add to Home Screen manually.                                    | Tap Share, tap **Add to Home Screen**. Confirm the home screen icon shows the Keiko icon. Tap the icon. Confirm the launched standalone app shows the Keiko UI. |
| Chrome on iOS          | iOS WebKit restriction: same behavior as Safari on iOS. Use Add to Home Screen.                       | Same as Safari iOS above.                                                                                                                                       |

---

## Launcher command verification (ADR-0024 D8)

Perform the following steps on both macOS and Windows. Record the output for each step
in the evidence capture template.

### macOS

Expected shortcut path: `~/Applications/Keiko Launcher.command`

1. Dry run:

   ```
   keiko launcher install --dry-run
   ```

   Confirm: the command prints the expected path and the shortcut file content.
   Confirm: no file is created at that path.

2. Install:

   ```
   keiko launcher install
   ```

   Confirm: the command prints a confirmation message and the path.
   Confirm: the file exists at `~/Applications/Keiko Launcher.command`.
   Confirm: the file content matches the printed template (no unexpected shell commands).

3. Status:

   ```
   keiko launcher status
   ```

   Confirm: the output shows the shortcut path and status `ok`.

4. Invoke the shortcut: double-click the `.command` file in Finder or run it in a
   terminal. Confirm: the Keiko server starts and the browser opens to the Keiko UI.

5. Remove:

   ```
   keiko launcher remove
   ```

   Confirm: the command prints a confirmation.
   Confirm: the file at `~/Applications/Keiko Launcher.command` is deleted.
   Confirm: `keiko launcher status` reports no active shortcut.

### Windows

Expected shortcut path: `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Keiko.bat`

Perform the same five steps as macOS above. For step 4, double-click the `.bat` file
or locate it in the Start menu. For step 5, confirm the file is deleted and
`keiko launcher status` reports no active shortcut.

### Linux

Expected shortcut path: `~/.local/share/applications/keiko.desktop`

Perform the same five steps. For step 4, use the desktop environment's application
launcher or run the `.desktop` file directly.

---

## Evidence capture template

For each first-class matrix row, fill in the following. Attach screenshots as image
files to the Epic #121 closure comment on GitHub.

```
Row: <Browser> / <Platform> / <Date> / <Tester>

[ ] Lighthouse PWA score: ___  (screenshot filename: ___)
[ ] DevTools Application > Manifest screenshot: ___
[ ] DevTools Application > Service Workers screenshot: ___
[ ] DevTools Application > Cache Storage (after workflow run) screenshot: ___
[ ] Install prompt screenshot: ___
[ ] Standalone app window screenshot: ___
[ ] Launcher install path: ___
[ ] Launcher file content (first 5 lines): ___
[ ] keiko launcher remove confirmation: ___
[ ] Security review sign-off (ADR-0024 D10): reviewer ___ / date ___
```

---

## Where evidence lives

All captured screenshots, Lighthouse exports, and filled evidence templates are attached
to the closure comment on GitHub issue #121. They are not committed to this repository.
Screenshots are local build artifacts; the runbook references artifact links from that
comment rather than embedding binary content in version control.

---

## Known limitations of this run

The automated installability tests in `packages/keiko-server/src/installability.test.ts`
cover headless gates only. They cannot verify:

- **Lighthouse PWA score**: Lighthouse requires a real browser with DevTools; there is no
  headless Lighthouse gate in this iteration. Adding one would require a new dev dependency
  (lighthouse CLI or puppeteer), which the "no new runtime dependency" invariant from
  ADR-0024 D2 and the spec forbids.
- **Service worker cache inspection**: whether the cache contains only static assets after a
  workflow run cannot be asserted without a real browser session. The automated test asserts
  that `/api/health` carries `Cache-Control: no-store` and that static assets do not, which
  is the necessary precondition; the DevTools inspection step in this runbook confirms the
  runtime behavior.
- **Install prompt appearance**: the `beforeinstallprompt` event and the browser install UI
  require a real browser and a real user interaction; they cannot be automated in a Node.js
  test environment.
- **Standalone window behavior**: verifying that the installed app opens as a standalone
  window (no browser chrome) requires a real OS and browser.

The manual steps in this runbook are the designated gate for all of the above.
