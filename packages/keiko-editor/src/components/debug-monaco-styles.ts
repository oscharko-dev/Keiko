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
${root} .keiko-debug-breakpoint-hit { position: relative; box-shadow: 0 0 0 3px var(--ed-breakpoint-ring), 0 0 0 6px color-mix(in oklch, var(--ed-breakpoint-ring) 20%, transparent); }
${root} .keiko-debug-breakpoint-hit::after { content: ""; position: absolute; inset-inline-start: 100%; top: 50%; margin-inline-start: 2px; transform: translateY(-50%); width: 0; height: 0; border-style: solid; border-width: 4px 0 4px 6px; border-color: transparent transparent transparent var(--ed-breakpoint-ring); }
${root} .keiko-debug-current-line { width: 0; height: 0; margin: 4px auto 0; border-style: solid; border-width: 5px 0 5px 8px; border-color: transparent transparent transparent var(--ed-breakpoint-ring); }
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
  style.dataset.keikoDebugDecorationStyle = scope;
  style.textContent = styleText(scope);
  container.dataset.keikoDebugDecorations = scope;
  document.head.append(style);
  return {
    dispose(): void {
      if (container.dataset.keikoDebugDecorations === scope) {
        delete container.dataset.keikoDebugDecorations;
      }
      style.remove();
    },
  };
}
