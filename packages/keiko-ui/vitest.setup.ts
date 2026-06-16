import "@testing-library/jest-dom/vitest";
import { afterEach, expect } from "vitest";
import { cleanup } from "@testing-library/react";
import { toHaveNoViolations } from "jest-axe";

expect.extend(toHaveNoViolations);

afterEach(() => {
  cleanup();
});

class MemoryStorage implements Storage {
  #data = new Map<string, string>();

  get length(): number {
    return this.#data.size;
  }

  clear(): void {
    this.#data.clear();
  }

  getItem(key: string): string | null {
    return this.#data.get(String(key)) ?? null;
  }

  key(index: number): string | null {
    return Array.from(this.#data.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.#data.delete(String(key));
  }

  setItem(key: string, value: string): void {
    this.#data.set(String(key), String(value));
  }
}

function installStorageShim(key: "localStorage" | "sessionStorage"): void {
  if (typeof window === "undefined") return;
  const current = window[key];
  if (
    typeof current === "object" &&
    current !== null &&
    typeof current.getItem === "function" &&
    typeof current.setItem === "function" &&
    typeof current.removeItem === "function" &&
    typeof current.clear === "function"
  ) {
    return;
  }
  Object.defineProperty(window, key, {
    configurable: true,
    writable: true,
    value: new MemoryStorage(),
  });
}

installStorageShim("localStorage");
installStorageShim("sessionStorage");

// jsdom does not implement HTMLElement.prototype.scrollIntoView — stub it so
// components that call scrollIntoView do not throw.
if (typeof window !== "undefined" && !HTMLElement.prototype.scrollIntoView) {
  HTMLElement.prototype.scrollIntoView = function () {};
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
