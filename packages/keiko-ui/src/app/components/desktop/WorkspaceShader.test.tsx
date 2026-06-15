import { fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceShader } from "./WorkspaceShader";

interface MatchMediaHarness {
  query: string;
  matches: boolean;
  readonly addEventListener: ReturnType<typeof vi.fn>;
  readonly removeEventListener: ReturnType<typeof vi.fn>;
  listener?: () => void;
}

interface FakeGl {
  readonly VERTEX_SHADER: number;
  readonly FRAGMENT_SHADER: number;
  readonly COMPILE_STATUS: number;
  readonly LINK_STATUS: number;
  readonly ARRAY_BUFFER: number;
  readonly STATIC_DRAW: number;
  readonly FLOAT: number;
  readonly TRIANGLES: number;
  readonly createShader: ReturnType<typeof vi.fn>;
  readonly shaderSource: ReturnType<typeof vi.fn>;
  readonly compileShader: ReturnType<typeof vi.fn>;
  readonly getShaderParameter: ReturnType<typeof vi.fn>;
  readonly deleteShader: ReturnType<typeof vi.fn>;
  readonly createProgram: ReturnType<typeof vi.fn>;
  readonly attachShader: ReturnType<typeof vi.fn>;
  readonly linkProgram: ReturnType<typeof vi.fn>;
  readonly getProgramParameter: ReturnType<typeof vi.fn>;
  readonly useProgram: ReturnType<typeof vi.fn>;
  readonly createBuffer: ReturnType<typeof vi.fn>;
  readonly bindBuffer: ReturnType<typeof vi.fn>;
  readonly bufferData: ReturnType<typeof vi.fn>;
  readonly getAttribLocation: ReturnType<typeof vi.fn>;
  readonly enableVertexAttribArray: ReturnType<typeof vi.fn>;
  readonly vertexAttribPointer: ReturnType<typeof vi.fn>;
  readonly getUniformLocation: ReturnType<typeof vi.fn>;
  readonly viewport: ReturnType<typeof vi.fn>;
  readonly uniform2f: ReturnType<typeof vi.fn>;
  readonly uniform1f: ReturnType<typeof vi.fn>;
  readonly uniform2fv: ReturnType<typeof vi.fn>;
  readonly uniform1fv: ReturnType<typeof vi.fn>;
  readonly drawArrays: ReturnType<typeof vi.fn>;
  readonly deleteBuffer: ReturnType<typeof vi.fn>;
  readonly deleteProgram: ReturnType<typeof vi.fn>;
}

class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];

  readonly observe = vi.fn();
  readonly unobserve = vi.fn();
  readonly disconnect = vi.fn();

  constructor(readonly callback: ResizeObserverCallback) {
    FakeResizeObserver.instances.push(this);
  }
}

function installMatchMedia(initialMatches = false): MatchMediaHarness {
  const harness: MatchMediaHarness = {
    query: "",
    matches: initialMatches,
    addEventListener: vi.fn((event: string, listener: () => void) => {
      if (event === "change") harness.listener = listener;
    }),
    removeEventListener: vi.fn(),
  };
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: vi.fn((query: string) => {
      harness.query = query;
      return harness as unknown as MediaQueryList;
    }),
  });
  return harness;
}

function createGl(): FakeGl {
  return {
    VERTEX_SHADER: 0x8b31,
    FRAGMENT_SHADER: 0x8b30,
    COMPILE_STATUS: 0x8b81,
    LINK_STATUS: 0x8b82,
    ARRAY_BUFFER: 0x8892,
    STATIC_DRAW: 0x88e4,
    FLOAT: 0x1406,
    TRIANGLES: 0x0004,
    createShader: vi.fn((type: number) => ({ type })),
    shaderSource: vi.fn(),
    compileShader: vi.fn(),
    getShaderParameter: vi.fn(() => true),
    deleteShader: vi.fn(),
    createProgram: vi.fn(() => ({ program: true })),
    attachShader: vi.fn(),
    linkProgram: vi.fn(),
    getProgramParameter: vi.fn(() => true),
    useProgram: vi.fn(),
    createBuffer: vi.fn(() => ({ buffer: true })),
    bindBuffer: vi.fn(),
    bufferData: vi.fn(),
    getAttribLocation: vi.fn(() => 0),
    enableVertexAttribArray: vi.fn(),
    vertexAttribPointer: vi.fn(),
    getUniformLocation: vi.fn((_program: unknown, name: string) => name),
    viewport: vi.fn(),
    uniform2f: vi.fn(),
    uniform1f: vi.fn(),
    uniform2fv: vi.fn(),
    uniform1fv: vi.fn(),
    drawArrays: vi.fn(),
    deleteBuffer: vi.fn(),
    deleteProgram: vi.fn(),
  };
}

function stubAnimationFrame(): {
  readonly requestAnimationFrame: ReturnType<typeof vi.fn>;
  readonly cancelAnimationFrame: ReturnType<typeof vi.fn>;
  callback: FrameRequestCallback | null;
} {
  const state = {
    requestAnimationFrame: vi.fn((callback: FrameRequestCallback) => {
      state.callback = callback;
      return 123;
    }),
    cancelAnimationFrame: vi.fn(),
    callback: null as FrameRequestCallback | null,
  };
  vi.stubGlobal("requestAnimationFrame", state.requestAnimationFrame);
  vi.stubGlobal("cancelAnimationFrame", state.cancelAnimationFrame);
  return state;
}

function stubHostRect(canvas: HTMLCanvasElement): HTMLElement {
  const host = canvas.parentElement;
  expect(host).not.toBeNull();
  vi.spyOn(host as HTMLElement, "getBoundingClientRect").mockReturnValue({
    x: 10,
    y: 20,
    left: 10,
    top: 20,
    right: 210,
    bottom: 120,
    width: 200,
    height: 100,
    toJSON: () => ({}),
  } as DOMRect);
  return host as HTMLElement;
}

describe("WorkspaceShader", () => {
  beforeEach(() => {
    window.localStorage.clear();
    installMatchMedia(false);
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    FakeResizeObserver.instances = [];
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete document.documentElement.dataset.theme;
  });

  it("does not initialize WebGL while reduced motion is enabled and reacts when it changes", () => {
    const media = installMatchMedia(true);
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, "getContext");

    render(<WorkspaceShader />);

    expect(media.query).toBe("(prefers-reduced-motion: reduce)");
    expect(getContext).not.toHaveBeenCalled();

    media.matches = false;
    media.listener?.();

    expect(getContext).toHaveBeenCalledWith("webgl", expect.any(Object));
  });

  it("uses transparent fallback when WebGL is unavailable and keeps opacity reactive", () => {
    window.localStorage.setItem("keiko.wallpaper.opacity", "35");
    const removeEventListener = vi.spyOn(window, "removeEventListener");
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);

    const { container, unmount } = render(<WorkspaceShader />);
    const canvas = container.querySelector("canvas");
    expect(canvas).not.toBeNull();

    expect(canvas).toHaveStyle({ opacity: "0.35" });

    window.dispatchEvent(new CustomEvent("keiko:wallpaper-opacity", { detail: 150 }));
    expect(canvas).toHaveStyle({ opacity: "1" });

    window.dispatchEvent(new CustomEvent("keiko:wallpaper-opacity", { detail: -20 }));
    expect(canvas).toHaveStyle({ opacity: "0" });

    window.localStorage.setItem("keiko.wallpaper.opacity", "75");
    window.dispatchEvent(new Event("keiko:wallpaper-opacity"));
    expect(canvas).toHaveStyle({ opacity: "0.75" });

    unmount();
    expect(removeEventListener).toHaveBeenCalledWith(
      "keiko:wallpaper-opacity",
      expect.any(Function),
    );
  });

  it("renders one WebGL frame from pointer, ripple and theme state, then cleans up resources", () => {
    document.documentElement.dataset.theme = "light";
    const gl = createGl();
    const animation = stubAnimationFrame();
    vi.spyOn(performance, "now").mockReturnValue(1_000);
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
      gl as unknown as RenderingContext,
    );

    const { container, unmount } = render(<WorkspaceShader />);
    const canvas = container.querySelector("canvas") as HTMLCanvasElement;
    const host = stubHostRect(canvas);
    FakeResizeObserver.instances[0]?.callback([], FakeResizeObserver.instances[0]);

    fireEvent.pointerMove(host, { clientX: 70, clientY: 100 });
    fireEvent.pointerDown(host, { clientX: 110, clientY: 45 });
    fireEvent.pointerDown(host, { clientX: -20, clientY: 45 });

    vi.mocked(performance.now).mockReturnValue(1_250);
    animation.callback?.(1_250);

    expect(gl.viewport).toHaveBeenCalledWith(0, 0, 200, 100);
    expect(gl.uniform2f).toHaveBeenCalledWith("uRes", 200, 100);
    expect(gl.uniform1f).toHaveBeenCalledWith("uLight", 1);
    expect(gl.uniform2fv).toHaveBeenCalledWith(
      "uRip",
      expect.objectContaining({ 0: 0.5, 1: 0.75 }),
    );
    expect(gl.uniform1fv).toHaveBeenCalledWith("uRipT", expect.objectContaining({ 0: 0.25 }));
    expect(gl.drawArrays).toHaveBeenCalledWith(gl.TRIANGLES, 0, 3);

    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(animation.cancelAnimationFrame).toHaveBeenCalledWith(123);

    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(animation.requestAnimationFrame).toHaveBeenCalledTimes(3);

    unmount();

    expect(FakeResizeObserver.instances[0]?.disconnect).toHaveBeenCalled();
    expect(gl.deleteBuffer).toHaveBeenCalled();
    expect(gl.deleteProgram).toHaveBeenCalled();
    expect(gl.deleteShader).toHaveBeenCalledTimes(2);
  });

  it("tears down opacity listeners when shader compilation fails", () => {
    const gl = createGl();
    gl.getShaderParameter.mockReturnValue(false);
    const removeEventListener = vi.spyOn(window, "removeEventListener");
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
      gl as unknown as RenderingContext,
    );

    const { unmount } = render(<WorkspaceShader />);

    expect(gl.deleteShader).toHaveBeenCalled();

    unmount();
    expect(removeEventListener).toHaveBeenCalledWith(
      "keiko:wallpaper-opacity",
      expect.any(Function),
    );
  });
});
