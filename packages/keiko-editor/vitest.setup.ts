import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

afterEach(() => {
  cleanup();
});

function noop(): void {
  // Intentionally empty: a stub for jsdom-missing DOM APIs the editor chrome may call.
}

// jsdom does not implement HTMLElement.prototype.scrollIntoView — stub it so components that call
// scrollIntoView do not throw. The DOM lib types it as always present, so reach it via a loosely
// typed view to install the stub only when the runtime is genuinely missing it.
interface ScrollIntoViewProto {
  scrollIntoView?: (...args: unknown[]) => void;
}
const elementProto = HTMLElement.prototype as unknown as ScrollIntoViewProto;
if (typeof elementProto.scrollIntoView !== "function") {
  elementProto.scrollIntoView = noop;
}

// jsdom does not implement window.matchMedia — provide a minimal mock so components that read
// prefers-contrast / prefers-color-scheme during effects do not throw.
interface MatchMediaWindow {
  matchMedia?: (query: string) => MediaQueryList;
}
const matchMediaWindow = window as unknown as MatchMediaWindow;
if (typeof matchMediaWindow.matchMedia !== "function") {
  const fakeMatchMedia = (query: string): MediaQueryList => {
    const list = {
      matches: false,
      media: query,
      onchange: null,
      addListener: noop,
      removeListener: noop,
      addEventListener: noop,
      removeEventListener: noop,
      dispatchEvent: (): boolean => false,
    };
    return list;
  };
  matchMediaWindow.matchMedia = fakeMatchMedia;
}

// jsdom deliberately omits canvas rendering. Monaco-adjacent React tests only need a harmless
// 2D-context facade so they exercise editor behavior without noisy environment warnings.
Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
  configurable: true,
  value(this: HTMLCanvasElement, contextId: string) {
    if (contextId !== "2d") {
      return null;
    }
    return {
      canvas: this,
      clearRect: noop,
      fillRect: noop,
      getImageData: () => ({ data: new Uint8ClampedArray(0) }),
      putImageData: noop,
      createImageData: () => [],
      setTransform: noop,
      drawImage: noop,
      save: noop,
      fillText: noop,
      restore: noop,
      beginPath: noop,
      moveTo: noop,
      lineTo: noop,
      closePath: noop,
      stroke: noop,
      translate: noop,
      scale: noop,
      rotate: noop,
      arc: noop,
      fill: noop,
      measureText: () => ({ width: 0 }),
      transform: noop,
      rect: noop,
      clip: noop,
    } as unknown as CanvasRenderingContext2D;
  },
});
