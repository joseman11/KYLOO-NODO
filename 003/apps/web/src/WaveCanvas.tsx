import { useEffect, useRef } from "react";

const VERT = "attribute vec2 p; void main() { gl_Position = vec4(p, 0.0, 1.0); }";
// Pliegues de tela en escala de grises: ruido fractal deformado por sí mismo, trama de puntos y grano de película
const FRAG = `
precision highp float;
uniform vec2 res; uniform float t;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
}
float fbm(vec2 p) { float v = 0.0, a = 0.5; for (int i = 0; i < 4; i++) { v += a * noise(p); p = p * 1.9 + 7.3; a *= 0.45; } return v; }
void main() {
  vec2 uv = gl_FragCoord.xy / res;
  vec2 p = vec2(uv.x * res.x / res.y * 0.4, uv.y * 2.0);
  vec2 q = vec2(fbm(p + vec2(0.0, t * 0.03)), fbm(p + vec2(5.2, 1.3) - t * 0.025));
  vec2 r = vec2(fbm(p + 2.2 * q + vec2(1.7, 9.2) + t * 0.02), fbm(p + 2.2 * q + vec2(8.3, 2.8) - t * 0.018));
  float f = fbm(p + 2.0 * r);
  float fold = 0.5 + 0.5 * sin(f * 8.0 + p.y * 2.0 + t * 0.1);
  float lum = 0.04 + 0.5 * pow(fold, 2.2) * (0.5 + 1.1 * f);
  lum += (1.0 - uv.y) * 0.0 + uv.y * 0.12;
  lum *= 0.55 + 0.6 * smoothstep(1.05, 0.15, length((uv - vec2(0.5, 0.55)) * vec2(0.9, 1.1)) );
  // trama de puntos (halftone) sobre las zonas claras
  vec2 g = fract(gl_FragCoord.xy / 4.0) - 0.5;
  float dots = smoothstep(0.5, 0.18, length(g) / (0.35 + lum * 1.2));
  lum *= mix(1.0, dots, 0.28);
  float grain = hash(gl_FragCoord.xy + floor(t * 24.0)) - 0.5;
  // Matices: pizarra fría arriba, taupe/beige cálido al centro, con un toque rojizo y oliva en los pliegues
  float warm = clamp(smoothstep(0.85, 0.2, uv.y) * 0.9 + (f - 0.5) * 1.4, 0.0, 1.0);
  vec3 cool = vec3(0.80, 0.93, 1.00);
  vec3 hot = vec3(1.00, 0.86, 0.70);
  vec3 tint = mix(vec3(0.86, 0.94, 0.99), vec3(1.0, 0.9, 0.78), warm);
  tint = mix(tint, vec3(1.00, 0.78, 0.76), smoothstep(0.55, 0.9, r.x) * 0.35); // rojizo
  tint = mix(tint, vec3(0.96, 0.98, 0.74), smoothstep(0.55, 0.9, r.y) * 0.3);  // oliva
  vec3 col = vec3(lum) * tint * 0.92 + grain * 0.045;
  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}`;

/** Fondo animado: olas/pliegues en blanco y negro con desenfoque, grano y trama. */
export function WaveCanvas() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    const gl = canvas?.getContext("webgl", { antialias: false, alpha: false });
    if (!canvas || !gl) return; // sin WebGL queda el fondo oscuro de CSS
    const compile = (type: number, src: string) => { const s = gl.createShader(type)!; gl.shaderSource(s, src); gl.compileShader(s); return s; };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return;
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, "p");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const uRes = gl.getUniformLocation(prog, "res");
    const uT = gl.getUniformLocation(prog, "t");

    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const resize = () => {
      const scale = Math.min(window.devicePixelRatio || 1, 1.5) * 0.75; // menos píxeles: más fluido en tablets
      canvas.width = Math.max(2, Math.floor(canvas.clientWidth * scale));
      canvas.height = Math.max(2, Math.floor(canvas.clientHeight * scale));
      gl.viewport(0, 0, canvas.width, canvas.height);
    };
    const draw = (ms: number) => {
      gl.uniform2f(uRes, canvas.width, canvas.height);
      gl.uniform1f(uT, ms / 1000 + 20);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };
    resize();
    const ro = new ResizeObserver(() => { resize(); if (reduce) draw(0); });
    ro.observe(canvas);
    let raf = 0;
    const loop = (ms: number) => { draw(ms); raf = requestAnimationFrame(loop); };
    if (reduce) draw(0); else raf = requestAnimationFrame(loop);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); gl.getExtension("WEBGL_lose_context")?.loseContext(); };
  }, []);
  return <canvas ref={ref} className="wave-canvas" />;
}
