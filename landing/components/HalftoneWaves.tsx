"use client";

import { useEffect, useRef } from "react";

const VERT = "attribute vec2 p; void main() { gl_Position = vec4(p, 0.0, 1.0); }";
// Mancha fluida en movimiento, dibujada con puntos de trama (halftone) crema sobre negro.
const FRAG = `
precision highp float;
uniform vec2 res; uniform float t; uniform float cell;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
}
float fbm(vec2 p) { float v = 0.0, a = 0.5; for (int i = 0; i < 4; i++) { v += a * noise(p); p = p * 2.03 + 11.7; a *= 0.5; } return v; }
void main() {
  vec2 uv = gl_FragCoord.xy / res;
  float asp = res.x / res.y;
  vec2 p = vec2(uv.x * asp, uv.y) * 1.15;
  vec2 q = vec2(fbm(p + vec2(0.0, t * 0.05)), fbm(p + vec2(4.1, 1.7) - t * 0.04));
  vec2 r = vec2(fbm(p + 2.4 * q + vec2(1.7, 9.2) + t * 0.035), fbm(p + 2.4 * q + vec2(8.3, 2.8) - t * 0.03));
  float f = fbm(p + 2.6 * r);
  // la masa clara cruza de abajo-centro hacia arriba-derecha y se deshace en los bordes
  float band = 1.0 - smoothstep(0.0, 0.62, abs((uv.y - 0.5) * 1.5 - (uv.x - 0.55) * 0.55 + (f - 0.5) * 1.15));
  float shape = clamp(band * (0.55 + 0.9 * f), 0.0, 1.0);
  shape = smoothstep(0.08, 0.95, shape);
  // la esquina inferior izquierda queda oscura para que se lea el logotipo
  shape *= mix(0.0, 1.0, smoothstep(0.2, 0.62, uv.x + uv.y * 0.35));
  vec2 g = fract(gl_FragCoord.xy / cell) - 0.5;
  float d = length(g);
  float rad = shape * 0.72;
  float dotv = 1.0 - smoothstep(rad - 0.07, rad + 0.07, d);
  vec3 bg = vec3(0.031, 0.031, 0.027);
  vec3 cream = vec3(0.91, 0.91, 0.88);
  gl_FragColor = vec4(mix(bg, cream, dotv), 1.0);
}`;

/** Olas de puntos (halftone) en movimiento, como el pie de kyloo.com.mx. Se pausa fuera de pantalla. */
export function HalftoneWaves({ className }: { className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const gl = canvas?.getContext("webgl", { antialias: false, alpha: false });
    if (!canvas || !gl) return;
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      return s;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return;
    gl.useProgram(prog);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, "p");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const uRes = gl.getUniformLocation(prog, "res");
    const uT = gl.getUniformLocation(prog, "t");
    const uCell = gl.getUniformLocation(prog, "cell");
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    let scale = 1;
    const resize = () => {
      scale = Math.min(devicePixelRatio || 1, 2);
      canvas.width = Math.max(2, Math.floor(canvas.clientWidth * scale));
      canvas.height = Math.max(2, Math.floor(canvas.clientHeight * scale));
      gl.viewport(0, 0, canvas.width, canvas.height);
    };
    const draw = (ms: number) => {
      gl.uniform2f(uRes, canvas.width, canvas.height);
      gl.uniform1f(uT, ms / 1000 + 30);
      gl.uniform1f(uCell, 8 * scale);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };
    resize();
    const ro = new ResizeObserver(() => {
      resize();
      if (reduce) draw(0);
    });
    ro.observe(canvas);
    let raf = 0;
    const loop = (ms: number) => {
      draw(ms);
      raf = requestAnimationFrame(loop);
    };
    const io = new IntersectionObserver(([e]) => {
      cancelAnimationFrame(raf);
      if (e.isIntersecting) {
        if (reduce) draw(0);
        else raf = requestAnimationFrame(loop);
      }
    });
    io.observe(canvas);
    return () => {
      cancelAnimationFrame(raf);
      io.disconnect();
      ro.disconnect();
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    };
  }, []);

  return <canvas ref={ref} className={className} aria-hidden="true" />;
}
