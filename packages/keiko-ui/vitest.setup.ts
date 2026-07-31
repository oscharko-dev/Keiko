import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, expect } from "vitest";
import { cleanup } from "@testing-library/react";
import { toHaveNoViolations } from "jest-axe";
import { setClientDiagnosticWriter } from "./src/lib/client-diagnostics";
import { writeToBrowserConsole } from "./src/lib/install-client-diagnostics";

expect.extend(toHaveNoViolations);

// Give every test the transport the application installs, rather than the sink's pre-transport
// buffering default. Tests that assert a diagnostic reached the console are then exercising the
// real delivery path end to end instead of a stand-in, and a suite that swaps the writer for its
// own spy cannot leave the next one buffering into the void.
beforeEach(() => {
  setClientDiagnosticWriter(writeToBrowserConsole);
});

// The persisted UI locale is process-global state, so one test choosing a language decided what the
// NEXT test rendered. `I18nProvider` seeds itself from `localStorage["keiko.locale"]` and writes the
// active locale back on mount, and `cleanup()` unmounts React trees without touching either that key
// or the document locale attributes — so a suite asserting English copy passed or failed on whatever
// a neighbouring test happened to leave behind. Resetting it here makes the precondition the same
// for every test instead of a property of execution order (AGENTS.md §9: no shared mutable global
// state). Ordered after `cleanup()` so an unmounting provider cannot write the key back afterwards.
afterEach(() => {
  cleanup();
  // A precondition check, not a swallowed failure: a suite may run without a window or replace
  // storage wholesale, and there is nothing to reset in that case. If storage IS present and the
  // removal throws, the teardown fails loudly — a broken Storage is a real defect and hiding it
  // behind an empty catch is what turns one bad suite into an unexplained cascade elsewhere.
  if (typeof window !== "undefined" && typeof window.localStorage?.removeItem === "function") {
    window.localStorage.removeItem("keiko.locale");
  }
  if (typeof document !== "undefined") {
    document.documentElement.removeAttribute("lang");
    delete document.documentElement.dataset.locale;
  }
});

// jsdom does not implement HTMLElement.prototype.scrollIntoView — stub it so
// components that call scrollIntoView do not throw.
if (typeof window !== "undefined" && !HTMLElement.prototype.scrollIntoView) {
  HTMLElement.prototype.scrollIntoView = function () {};
}

// Monaco probes the legacy clipboard command API during module initialization. jsdom deliberately
// omits that API, so expose the browser's conservative "unsupported" answer for component tests.
if (typeof document !== "undefined" && !("queryCommandSupported" in document)) {
  Object.defineProperty(document, "queryCommandSupported", {
    configurable: true,
    value: (): boolean => false,
  });
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
