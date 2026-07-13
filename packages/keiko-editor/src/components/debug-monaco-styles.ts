import type { MonacoDisposable } from "./completion-bridge.js";

let nextScope = 0;

function scopeName(): string {
  nextScope += 1;
  return `keiko-debug-${String(nextScope)}`;
}

function styleText(scope: string): string {
  const root = `[data-keiko-debug-decorations="${scope}"]`;
  return `${root} .keiko-debug-breakpoint { width: 10px; height: 10px; margin: 3px auto 0; border-radius: 50%; background: var(--ed-breakpoint); border: 1px solid var(--ed-breakpoint); }
${root} .keiko-debug-breakpoint-conditional { background: radial-gradient(circle at 50% 0, transparent 0 22%, var(--ed-breakpoint) 23%); }
${root} .keiko-debug-breakpoint-logpoint { border-radius: 1px; background: var(--ed-logpoint); border-color: var(--ed-logpoint); }
${root} .keiko-debug-breakpoint-ring { background: transparent; border: 2px solid var(--ed-breakpoint-disabled); }
${root} .keiko-debug-breakpoint-hit { box-shadow: 0 0 0 3px var(--ed-breakpoint-ring), 0 0 0 6px color-mix(in oklch, var(--ed-breakpoint-ring) 20%, transparent); }
${root} .keiko-debug-inline-value { color: var(--ed-inlay-value-fg); background: var(--ed-inlay-value-bg); border-radius: 5px; padding: 0 6px; margin-left: 10px; }`;
}

/**
 * Installs a uniquely scoped decoration stylesheet for one mounted Monaco container. It relies only
 * on the host's existing editor tokens, keeps generated debug values out of global CSS, and removes
 * both the style element and scope marker on disposal.
 */
export function installDebugMonacoStyles(container: HTMLElement): MonacoDisposable {
  const scope = scopeName();
  const document = container.ownerDocument;
  const style = document.createElement("style");
  style.setAttribute("data-keiko-debug-decoration-style", scope);
  style.textContent = styleText(scope);
  container.setAttribute("data-keiko-debug-decorations", scope);
  document.head.append(style);
  return {
    dispose(): void {
      if (container.getAttribute("data-keiko-debug-decorations") === scope) {
        container.removeAttribute("data-keiko-debug-decorations");
      }
      style.remove();
    },
  };
}
