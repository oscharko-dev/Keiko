# PWA Installability Contract

This document describes the user-facing installability experience for Keiko as a Progressive
Web App (PWA). It is an operational companion to
[ADR-0024](adr/ADR-0024-installable-pwa-architecture.md) and covers the first-run user
journey, the browser and platform support matrix, the reversibility model, and scope boundaries.

## Structural limitation

A browser-installed PWA cannot start the local Keiko Node.js server by itself. The OS shortcut
or browser app launcher that results from PWA installation opens a browser window to a fixed
URL. If the Keiko server is not already running, the browser will show a connection error.

This is not a defect. The explicit launcher command (delivered in issue #125) bridges this gap
by starting the server and opening the app in a single user action. The two surfaces are
distinct and complementary; neither replaces the other.

## First-run user journey

The following steps describe the complete flow from a fresh npm installation to a running
installed PWA. Each step is user-initiated or browser-native; no step happens automatically.

### Step 1 — Install Keiko

```
npm install -g @oscharko-dev/keiko
# or: yarn global add @oscharko-dev/keiko
# or: pnpm add -g @oscharko-dev/keiko
# or: npx @oscharko-dev/keiko start
```

The install produces no desktop artifacts, no browser profile changes, and no shortcuts. Your
file system is not modified outside the npm global prefix.

### Step 2 — Start the local server

```
keiko start
```

Keiko starts a local HTTP server bound to `127.0.0.1` on the configured port (default: 3000).
The terminal displays the local URL.

### Step 3 — Open the browser

Keiko prints the URL to the terminal and, on supported platforms, may open the default browser
automatically. If the browser does not open automatically, navigate to the printed URL manually.

The Keiko UI loads as a standard browser tab at this point.

### Step 4 — Accept the browser install prompt (Chromium-family browsers)

On Chrome, Edge, or Chromium on macOS, Windows, or Linux, the browser evaluates the web app
manifest and service worker and, when criteria are met, displays an install affordance. This
may appear as:

- An install icon in the browser address bar.
- A banner or dialog initiated by the Keiko first-run guidance UI.
- A manual "Install Keiko" option in the browser menu.

Click the install option and confirm in the browser dialog. The browser creates a standalone
application window entry in the OS application shelf, Dock, or Start menu.

On Firefox and Safari, no browser install prompt is available. See the browser matrix below for
documented fallback instructions.

### Step 5 — Launch the installed app

After installation, Keiko appears as a named application in the OS application shelf. Activating
it opens a standalone browser window (without browser chrome) to `http://localhost:<port>/`.

The Keiko server must be running before you activate the installed app. If the server is not
running, the window displays a connection error. Start the server with `keiko start` first, then
activate the installed app.

### Step 6 — Optional: create an OS launcher shortcut

To create a shortcut that starts the server and opens the app in one action, run:

```
keiko launcher install
```

This command generates a platform-appropriate shortcut file in a user-accessible location and
prints the file path. The exact path depends on your operating system:

- **Linux:** `~/.local/share/applications/keiko.desktop`
- **macOS:** `~/Applications/Keiko Launcher.command`
- **Windows:** `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Keiko.bat`

No administrator privileges are required. The shortcut is not created automatically; this
command is always explicit. To delete a shortcut you previously created, run `keiko launcher
remove`, which removes the recorded shortcut after verifying its content has not been tampered
with.

### Step 7 — Relaunch flow

On subsequent uses:

**With the installed browser PWA only:** Start `keiko start` in a terminal, then activate the
installed app from the OS application shelf.

**With the OS launcher shortcut:** Activate the shortcut. It starts the server and opens the
app. Subsequent activations while the server is already running open a new window without
starting a second server instance.

## Browser and platform support matrix

| Browser / engine  | Platform(s)           | Install prompt              | Display mode `standalone` | Maskable icons | Known limitations                                                                                        |
| ----------------- | --------------------- | --------------------------- | ------------------------- | -------------- | -------------------------------------------------------------------------------------------------------- |
| Chrome ≥ 111      | macOS, Windows, Linux | Yes (`beforeinstallprompt`) | Yes                       | Yes            | None for `localhost`; HTTPS not required for `localhost` origin                                          |
| Edge ≥ 111        | macOS, Windows        | Yes (`beforeinstallprompt`) | Yes                       | Yes            | Edge may show its own install UI in addition to the in-page prompt                                       |
| Chromium          | macOS, Windows, Linux | Yes (`beforeinstallprompt`) | Yes                       | Yes            | Varies by Chromium build; distro-packaged builds may differ in install UI appearance                     |
| Firefox ≥ 124     | macOS, Windows, Linux | No                          | No                        | No             | Firefox does not implement `beforeinstallprompt` or display mode `standalone`. Bookmark the tab instead. |
| Safari ≥ 17 macOS | macOS                 | No                          | No                        | No             | Safari on macOS does not support PWA install. Bookmark the tab instead.                                  |
| Safari iOS ≥ 16.4 | iOS, iPadOS           | No (manual only)            | Yes (Add to Home Screen)  | Yes            | User must tap Share > Add to Home Screen manually. No in-page install prompt.                            |

**Fallback instruction for Firefox and Safari (macOS):** Bookmark `http://localhost:<port>/`
in your browser. Use `keiko start` to start the server before opening the bookmark. Use
`keiko launcher install` to generate an OS shortcut that handles server start.

**Fallback instruction for Safari on iOS/iPadOS:** Navigate to `http://localhost:<port>/` on
your iOS device while connected to the same network as the Keiko server. Tap the Share button,
then tap Add to Home Screen. This creates a home screen icon that opens Keiko in a standalone
view. The Keiko server must be reachable from the device.

## The five-minute trust narrative

Keiko is a developer tool. The first five minutes of use establish whether an enterprise user
trusts it as a product.

When Keiko installs via npm, nothing visible changes on the user's desktop. This is intentional:
enterprise endpoint controls commonly flag tools that write desktop artifacts during install.
Keiko does not trigger those controls.

When the user starts Keiko and navigates to the UI, the branded icon and standalone window
communicate that this is a managed application with a defined identity, not a temporary
localhost page. The Keiko name, the green accent mark, and the consistent application chrome
appear the same way on every Chromium-family browser and platform.

The install prompt — when the browser offers it — is a browser-native security gesture. The
browser has verified that the site meets PWA criteria (manifest, service worker, icons) before
offering the option. The user's click on "Install" is informed consent, not a silent side
effect of an installer script.

The result is a product that installs like a developer tool and presents itself like an
enterprise application: branded, stable, and reversible.

## Reversibility

### Removing the installed browser PWA

**Chrome / Edge / Chromium on macOS and Linux:**
Right-click the app icon in the OS application shelf or Dock. Select "Remove from Chrome" or
"Uninstall". The browser removes the shortcut entry and the service worker registration.
Alternatively, navigate to `chrome://apps` (or `edge://apps`), find Keiko, and select Remove.

**Chrome / Edge on Windows:**
Right-click the app icon in the Start menu or Taskbar. Select "Uninstall". The browser removes
the Start menu entry and service worker registration.

**Safari on iOS/iPadOS:**
Long-press the Keiko icon on the home screen. Select Remove App > Remove from Home Screen.

Uninstalling the PWA does not affect the npm package, the local server, or any evidence data.

### Removing the OS launcher shortcut

Run:

```
keiko launcher remove
```

This command reads the recorded shortcut path and deletes the file. If the shortcut was moved
manually, you can delete it at its original location, which `keiko launcher status` displays.

### Removing Keiko entirely

```
npm uninstall -g @oscharko-dev/keiko
```

This removes the npm package. It does not remove the installed browser PWA (the browser manages
that independently) or any local data under `~/.keiko/`. Remove those separately if needed:

```
keiko launcher remove          # remove OS shortcut, if created
# then uninstall PWA from the browser (see above)
# then delete local data if desired:
rm -rf ~/.keiko
```

## Out of scope

The following are not delivered by Epic #121 or documented here:

- **Native installers.** No MSI, DMG, PKG, Flatpak, Snap, AppImage, Electron bundle, or
  Tauri bundle. These are potential future epics; they are not part of this release.
- **Enterprise software distribution.** No SCCM, Intune, Munki, Jamf, or MDM-managed
  deployment package.
- **Customer-specific branding.** The Keiko manifest, icons, and theme colors are static
  production values. No per-tenant or per-organization customization is supported.
- **Offline mode.** Keiko requires the local Node.js server to be running. A service worker
  that serves cached API responses is explicitly prohibited (see ADR-0024 D6). If the server
  is not running, the UI shows a connection error.
- **Push notifications, background sync, or periodic sync.** The service worker scope is
  limited to static shell asset caching.
- **Multiple concurrent Keiko instances on different ports.** Each port is a separate browser
  origin with a separate service worker and PWA installation. Managing multiple installations
  is a user-space concern; Keiko does not orchestrate it.

## Verification

Cross-platform installability verification is documented in [`pwa-verification-runbook.md`](pwa-verification-runbook.md). The runbook lists the manual evidence required by ADR-0024 D10 before Epic #121 can be closed. Automated installability gates are covered by `packages/keiko-server/src/installability.test.ts`.
