import "@testing-library/jest-dom/vitest";
import { afterEach, expect } from "vitest";
import { cleanup } from "@testing-library/react";
import { toHaveNoViolations } from "jest-axe";

expect.extend(toHaveNoViolations);

afterEach(() => {
  cleanup();
});

// jsdom does not implement HTMLElement.prototype.scrollIntoView — stub it so
// components that call scrollIntoView do not throw.
if (typeof window !== "undefined" && !HTMLElement.prototype.scrollIntoView) {
  HTMLElement.prototype.scrollIntoView = function () {};
}

// Some coverage runners initialise jsdom with an unavailable/incomplete Storage object.
// Keep tests focused on UI behavior by providing the standard localStorage surface.
if (
  typeof window !== "undefined" &&
  (typeof window.localStorage?.getItem !== "function" ||
    typeof window.localStorage?.setItem !== "function" ||
    typeof window.localStorage?.removeItem !== "function" ||
    typeof window.localStorage?.clear !== "function")
) {
  const store = new Map<string, string>();
  class MemoryStorage implements Storage {
    get length() {
      return store.size;
    }

    clear(): void {
      store.clear();
    }

    getItem(key: string): string | null {
      return store.get(key) ?? null;
    }

    key(index: number): string | null {
      return Array.from(store.keys())[index] ?? null;
    }

    removeItem(key: string): void {
      store.delete(key);
    }

    setItem(key: string, value: string): void {
      store.set(key, value);
    }
  }
  const storage = new MemoryStorage();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: storage,
  });
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: storage,
  });
}

// jsdom does not implement window.matchMedia — provide a minimal mock so
// components that call matchMedia during useEffect do not throw.
if (typeof window !== "undefined" && window.matchMedia === undefined) {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string): MediaQueryList => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

// jsdom deliberately omits canvas rendering. Components and axe checks only need a harmless
// 2D-context facade so tests exercise UI behavior without emitting environment noise.
if (typeof window !== "undefined" && typeof HTMLCanvasElement !== "undefined") {
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    value: function getContext(contextId: string) {
      if (contextId !== "2d") {
        return null;
      }
      return {
        canvas: this,
        clearRect: () => {},
        fillRect: () => {},
        getImageData: () => ({ data: new Uint8ClampedArray(0) }),
        putImageData: () => {},
        createImageData: () => [],
        setTransform: () => {},
        drawImage: () => {},
        save: () => {},
        fillText: () => {},
        restore: () => {},
        beginPath: () => {},
        moveTo: () => {},
        lineTo: () => {},
        closePath: () => {},
        stroke: () => {},
        translate: () => {},
        scale: () => {},
        rotate: () => {},
        arc: () => {},
        fill: () => {},
        measureText: () => ({ width: 0 }),
        transform: () => {},
        rect: () => {},
        clip: () => {},
      } as unknown as CanvasRenderingContext2D;
    },
  });
}
