# ADR-0115: Portable-first Browser Install Suppression

## Status

Accepted

## Date

2026-07-07

## Context

ADR-0024 introduced a browser-managed Progressive Web App install surface for the npm-era
Keiko pilot. That decision was correct for the previous delivery model: users installed Keiko
with npm, started a local server, and could optionally ask Chrome or Edge to create a
browser-owned standalone app shortcut.

Portable product delivery v2 changes the promoted product path. Keiko now ships as
platform-specific portable release assets with a bundled Node.js runtime, thin native launchers,
managed first-run setup, and a governed one-click portable update path. In that product model,
the browser toolbar action labeled `Install Keiko` creates a conflicting second install concept:
it installs a browser-managed shortcut for the current local URL, but it does not install the
bundled Keiko payload, does not create the managed install root, and does not participate in
portable updater v2.

ADR-0099 already separates PWA/service-worker refresh from product package mutation. ADR-0114
defines GitHub Release Assets and managed portable installs as the portable install/update
authority. This ADR resolves the remaining UX conflict between the historical browser PWA
surface and the new portable-first product delivery path.

## Decision

Keiko no longer promotes browser-managed PWA installation as a product installation path for
ordinary users.

The UI shell must not advertise an installable web app manifest to the browser. Chromium-family
browsers must not show a normal toolbar `Install Keiko` affordance for the local Keiko UI. The
in-product install banner and iOS add-to-home guidance are not rendered in the desktop shell.

Keiko may keep browser branding assets such as favicons, app icons, theme color, and static shell
cache/update recovery where they do not create a second user-facing product installation path.
The service worker remains a static-shell cache and update-recovery component only; it must not
be described or tested as an install-enabling mechanism.

Portable ZIP/native launcher installation is the promoted path:

1. Download the platform-specific GitHub Release Asset.
2. Extract it.
3. Double-click `Keiko.exe` or `Keiko.app`.
4. Complete one-button managed setup.
5. Use the managed app registration and portable updater v2 for future starts and updates.

Users who previously installed a browser-managed Keiko PWA may remove that shortcut from their
browser or operating-system app list. Removing it does not uninstall Keiko, remove `.keiko`
runtime state, or affect portable updater v2.

## Consequences

### Positive

- Users see one install concept instead of two.
- Portable updater v2 remains tied to attested managed product installs, not browser shortcuts.
- The browser chrome no longer suggests an install action that cannot install or update the
  bundled Keiko payload.
- Existing favicon/browser branding and static shell cache boundaries can remain without becoming
  a product delivery mechanism.

### Negative

- The historical npm-era PWA install workflow is no longer a promoted path.
- Existing PWA-specific verification artifacts become historical rather than active release gates.
- Users who already created browser-managed shortcuts may need to remove them manually if they
  cause confusion.

### Neutral

- This ADR does not remove the npm package or npm/Yarn compatibility update path.
- This ADR does not introduce Electron, Tauri, WebView embedding, installers, tray apps, or
  enterprise-managed rollout.
- This ADR does not change API caching prohibitions, CSP, loopback host binding, evidence
  redaction, or update authority.

## Superseded Decisions

This ADR supersedes ADR-0024 Surface A and the ADR-0024 requirements that Keiko must expose a
browser PWA install prompt, in-product install banner, browser install matrix, and Lighthouse PWA
installability gate as active product requirements.

ADR-0024 remains historical context for the original npm pilot and remains relevant only for the
security boundaries that still apply to retained static-shell browser assets: no secrets in public
metadata, no `/api/*` response caching, no evidence/model/workspace data in CacheStorage, and no
automatic desktop/browser mutation.

## Verification

- UI metadata tests assert that the root document does not advertise a web app manifest.
- Manifest metadata is retained as non-standalone browser metadata rather than a PWA install
  contract.
- Service-worker tests assert that `/manifest.webmanifest` is not intercepted or cached.
- Portable launch/setup smoke remains the install-path gate for ordinary users.

## Related

- ADR-0024: Installable Keiko PWA Architecture
- ADR-0099: Governed in-app updates and release-impact contract
- ADR-0114: Portable managed install and release-asset update authority
- Issue #1944: Epic: Portable product delivery v2
- Issue #2084: Suppress browser PWA install prompt for portable-first delivery
