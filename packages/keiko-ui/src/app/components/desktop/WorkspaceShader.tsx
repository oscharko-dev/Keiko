"use client";

import { useEffect, useRef } from "react";
import type { ReactNode } from "react";

const KEIKO_VERT = `
attribute vec2 aPos;
void main(){ gl_Position = vec4(aPos, 0.0, 1.0); }
`;

const KEIKO_FRAG = `
precision highp float;
uniform vec2  uRes;
uniform float uTime;
uniform vec2  uMouse;   // 0..1, y up
uniform float uDark;    // 1 = dark theme, 0 = light
uniform vec2  uRip[4];  // ripple origins (0..1, y up)
uniform float uRipT[4]; // seconds since each ripple fired (large = inactive)

float hash(vec2 p){
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float vnoise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash(i), b = hash(i + vec2(1.,0.));
  float c = hash(i + vec2(0.,1.)), d = hash(i + vec2(1.,1.));
  return mix(mix(a,b,u.x), mix(c,d,u.x), u.y);
}
float fbm(vec2 p){
  float v = 0.0, a = 0.5;
  mat2 m = mat2(1.6, 1.2, -1.2, 1.6);
  for(int i = 0; i < 5; i++){ v += a * vnoise(p); p = m * p; a *= 0.5; }
  return v;
}

void main(){
  vec2 uv = gl_FragCoord.xy / uRes.xy;
  float aspect = uRes.x / uRes.y;
  vec2 p = vec2(uv.x * aspect, uv.y);
  vec2 m = vec2(uMouse.x * aspect, uMouse.y);

  float t = uTime * 0.06;

  // --- click ripples ---------------------------------------------------
  float rip = 0.0;
  for(int i = 0; i < 4; i++){
    float age = uRipT[i];
    if(age < 2.4){
      vec2 rc = vec2(uRip[i].x * aspect, uRip[i].y);
      float d = distance(p, rc);
      float ring = sin(d * 15.0 - age * 9.0);
      float env  = exp(-d * 3.6) * exp(-age * 2.1);
      rip += ring * env;
    }
  }

  // --- liquid domain warp ---------------------------------------------
  vec2 warp = vec2(
    fbm(p * 2.1 + vec2(0.0, t)),
    fbm(p * 2.1 + vec2(t, 4.7))
  );
  // mouse bends the flow toward the cursor
  vec2 toM = m - p;
  float md = exp(-length(toM) * 2.2);
  warp += toM * md * 0.28;
  warp += rip * 0.07;

  float f = fbm(p * 2.4 + warp * 1.7 + vec2(t * 0.6, 0.0));

  // --- chrome banding (sharp metallic streaks) ------------------------
  float bands  = abs(sin((f * 4.0 + warp.x * 2.0) * 3.14159 + t * 1.4));
  float chrome = pow(bands, 2.6);

  // --- palette (brand) -------------------------------------------------
  vec3 baseD  = vec3(0.072, 0.085, 0.079);  // warm near-black ~ --bg
  vec3 metalD = vec3(0.205, 0.230, 0.216);  // chrome mid grey
  vec3 baseL  = vec3(0.930, 0.942, 0.935);  // near-white
  vec3 metalL = vec3(0.795, 0.835, 0.812);  // soft grey
  vec3 green  = vec3(0.306, 0.729, 0.529);  // #4EBA87

  vec3 base  = mix(baseL,  baseD,  uDark);
  vec3 metal = mix(metalL, metalD, uDark);

  vec3 col = mix(base, metal, chrome * 0.85);

  // orca-green sheen on the brightest specular ridges
  float spec = smoothstep(0.80, 1.0, bands);
  col += green * spec * mix(0.085, 0.16, uDark);

  // soft green glow trailing the cursor — fun to fidget with
  col += green * md * 0.085;

  // ripple highlight
  vec3 ripCol = mix(green, vec3(1.0), uDark);
  col += ripCol * max(rip, 0.0) * 0.032;

  // keep it dezent — pull back toward base
  col = mix(base, col, 0.84);

  gl_FragColor = vec4(col, 1.0);
}
`;

function compileShader(gl: WebGLRenderingContext, type: number, src: string): WebGLShader | null {
  const s = gl.createShader(type);
  if (s === null) return null;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!(gl.getShaderParameter(s, gl.COMPILE_STATUS) as boolean)) {
    // Allowed per spec: graceful fallback when compile fails. Canvas stays transparent.
    // eslint-disable-next-line no-console
    console.warn("[keiko-shader]", gl.getShaderInfoLog(s));
    gl.deleteShader(s);
    return null;
  }
  return s;
}

function readOpacity(): number {
  if (typeof window === "undefined") return 1;
  const raw = window.localStorage.getItem("keiko.wallpaper.opacity");
  if (raw === null) return 1;
  const v = Number.parseInt(raw, 10);
  return Number.isFinite(v) ? Math.max(0, Math.min(100, v)) / 100 : 1;
}

function setupShader(host: HTMLElement, canvas: HTMLCanvasElement): (() => void) | undefined {
  canvas.style.opacity = String(readOpacity());

  const onOpacity = (e: Event): void => {
    const detail = (e as CustomEvent<number>).detail;
    const value = typeof detail === "number" ? detail : readOpacity() * 100;
    canvas.style.opacity = String(Math.max(0, Math.min(100, value)) / 100);
  };
  window.addEventListener("keiko:wallpaper-opacity", onOpacity);

  let gl: WebGLRenderingContext | null = null;
  try {
    gl = canvas.getContext("webgl", {
      antialias: false,
      alpha: false,
      premultipliedAlpha: false,
      depth: false,
    });
  } catch {
    gl = null;
  }
  if (gl === null) {
    // No WebGL — solid --bg shows through the transparent canvas.
    return () => {
      window.removeEventListener("keiko:wallpaper-opacity", onOpacity);
    };
  }

  const vs = compileShader(gl, gl.VERTEX_SHADER, KEIKO_VERT);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, KEIKO_FRAG);
  if (vs === null || fs === null) {
    return () => {
      window.removeEventListener("keiko:wallpaper-opacity", onOpacity);
    };
  }

  const prog = gl.createProgram();
  if (prog === null) {
    return () => {
      window.removeEventListener("keiko:wallpaper-opacity", onOpacity);
    };
  }
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!(gl.getProgramParameter(prog, gl.LINK_STATUS) as boolean)) {
    // eslint-disable-next-line no-console
    console.warn("[keiko-shader]", gl.getProgramInfoLog(prog));
    return () => {
      window.removeEventListener("keiko:wallpaper-opacity", onOpacity);
    };
  }
  gl.useProgram(prog);

  const buf: WebGLBuffer | null = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const aPos = gl.getAttribLocation(prog, "aPos");
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

  const uRes: WebGLUniformLocation | null = gl.getUniformLocation(prog, "uRes");
  const uTime: WebGLUniformLocation | null = gl.getUniformLocation(prog, "uTime");
  const uMouse: WebGLUniformLocation | null = gl.getUniformLocation(prog, "uMouse");
  const uDark: WebGLUniformLocation | null = gl.getUniformLocation(prog, "uDark");
  const uRip: WebGLUniformLocation | null = gl.getUniformLocation(prog, "uRip");
  const uRipT: WebGLUniformLocation | null = gl.getUniformLocation(prog, "uRipT");

  const RN = 4;
  let W = 1;
  let H = 1;
  const dpr = Math.min(window.devicePixelRatio ?? 1, 1.5);
  const mouse = { tx: 0.5, ty: 0.5, x: 0.5, y: 0.5 };
  const ripPos = new Float32Array(RN * 2);
  const ripStart: number[] = new Array(RN).fill(Number.NEGATIVE_INFINITY);
  let ripHead = 0;

  function resize(): void {
    const r = host.getBoundingClientRect();
    W = Math.max(1, Math.round(r.width));
    H = Math.max(1, Math.round(r.height));
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    canvas.style.width = `${String(W)}px`;
    canvas.style.height = `${String(H)}px`;
    if (gl !== null) gl.viewport(0, 0, canvas.width, canvas.height);
  }
  resize();

  const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(resize) : null;
  if (ro !== null) ro.observe(host);
  else window.addEventListener("resize", resize);

  const onMove = (e: PointerEvent): void => {
    const r = host.getBoundingClientRect();
    mouse.tx = (e.clientX - r.left) / Math.max(1, r.width);
    // y-axis is flipped: WebGL UV y=0 is bottom, pointer y=0 is top
    mouse.ty = 1 - (e.clientY - r.top) / Math.max(1, r.height);
  };

  const onDown = (e: PointerEvent): void => {
    const r = host.getBoundingClientRect();
    const nx = (e.clientX - r.left) / Math.max(1, r.width);
    const ny = 1 - (e.clientY - r.top) / Math.max(1, r.height);
    if (nx < 0 || nx > 1 || ny < 0 || ny > 1) return;
    ripPos[ripHead * 2] = nx;
    ripPos[ripHead * 2 + 1] = ny;
    ripStart[ripHead] = performance.now();
    ripHead = (ripHead + 1) % RN;
  };

  host.addEventListener("pointermove", onMove);
  host.addEventListener("pointerdown", onDown);

  const t0 = performance.now();
  let raf = 0;
  let running = true;
  const ripT = new Float32Array(RN);

  function frame(): void {
    if (!running) return;
    const now = performance.now();
    const time = (now - t0) / 1000;

    mouse.x += (mouse.tx - mouse.x) * 0.06;
    mouse.y += (mouse.ty - mouse.y) * 0.06;

    for (let i = 0; i < RN; i++) {
      ripT[i] = (now - (ripStart[i] ?? Number.NEGATIVE_INFINITY)) / 1000;
    }

    const dark = document.documentElement.dataset.theme === "light" ? 0 : 1;

    if (gl !== null) {
      gl.uniform2f(uRes, canvas.width, canvas.height);
      gl.uniform1f(uTime, time);
      gl.uniform2f(uMouse, mouse.x, mouse.y);
      gl.uniform1f(uDark, dark);
      gl.uniform2fv(uRip, ripPos);
      gl.uniform1fv(uRipT, ripT);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    raf = requestAnimationFrame(frame);
  }
  raf = requestAnimationFrame(frame);

  const onVis = (): void => {
    if (document.hidden) {
      running = false;
      cancelAnimationFrame(raf);
    } else if (!running) {
      running = true;
      raf = requestAnimationFrame(frame);
    }
  };
  document.addEventListener("visibilitychange", onVis);

  return () => {
    running = false;
    cancelAnimationFrame(raf);
    document.removeEventListener("visibilitychange", onVis);
    window.removeEventListener("keiko:wallpaper-opacity", onOpacity);
    host.removeEventListener("pointermove", onMove);
    host.removeEventListener("pointerdown", onDown);
    if (ro !== null) ro.disconnect();
    else window.removeEventListener("resize", resize);
    if (gl !== null) {
      const ext = gl.getExtension("WEBGL_lose_context");
      if (ext !== null) ext.loseContext();
    }
  };
}

export function WorkspaceShader(): ReactNode {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const host = canvas.parentElement;
    if (host === null) return;
    // WCAG 2.3.3 — skip continuous animation for users who prefer reduced motion.
    // The canvas remains transparent; the solid --bg colour shows through (same
    // graceful fallback as the no-WebGL path documented in setupShader).
    // The preference is tracked reactively (audit C406): flipping the OS setting
    // while the app runs tears the rAF loop down / brings it back without a
    // reload — same pattern as usePrefersReducedMotion in ConnectionsLayer.
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    let dispose: (() => void) | undefined;
    const apply = (): void => {
      if (mq.matches) {
        dispose?.();
        dispose = undefined;
      } else if (dispose === undefined) {
        dispose = setupShader(host, canvas);
      }
    };
    apply();
    mq.addEventListener("change", apply);
    return () => {
      mq.removeEventListener("change", apply);
      dispose?.();
    };
  }, []);

  return <canvas ref={canvasRef} className="ws-shader" aria-hidden="true" />;
}
