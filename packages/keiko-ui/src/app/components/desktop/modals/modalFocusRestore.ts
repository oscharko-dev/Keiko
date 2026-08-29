// Deterministic modal close target shared by dialog surfaces (MD-05, WCAG 2.4.3). A modal is a
// sibling of `.app`; React runs its cleanup before AppShell's effect removes `.app[inert]`, so an
// opener inside that background must wait one animation frame before receiving programmatic focus.

function focusModalFallback(): void {
  const next =
    document.querySelector<HTMLElement>('.window[data-top="true"]') ??
    document.querySelector<HTMLElement>(".ws-fab") ??
    document.body;
  next.focus({ preventScroll: true });
}

function restoreModalFocus(opener: HTMLElement | null): void {
  if (opener?.isConnected === true && opener !== document.body) {
    opener.focus({ preventScroll: true });
    return;
  }
  focusModalFallback();
}

export function restoreModalFocusAfterUnlock(opener: HTMLElement | null): void {
  if (document.querySelector(".app[inert]") === null) {
    restoreModalFocus(opener);
    return;
  }
  requestAnimationFrame(() => restoreModalFocus(opener));
}
