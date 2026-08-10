"use client";

import { useEffect, useRef } from "react";

const VERT = `attribute vec2 aPos;
varying vec2 vUv;
void main(){
  vUv = aPos * 0.5 + 0.5;
  vUv.y = 1.0 - vUv.y;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const FRAG = `precision highp float;
varying vec2 vUv;
uniform sampler2D uTex;   // load the baked gradient texture into this sampler
uniform vec2  uTexSize;   // grid resolution in texels (set to your texture size)
uniform float uTime;      // seconds
uniform float uFlow;      // 0.35 suggested  (0 = static)
uniform float uSpeed;     // 0.30 suggested
uniform float uScale;     // 2.5 suggested
uniform float uQuality;   // 1.00 suggested  (0 = bilinear, 1 = bicubic + dither)
uniform float uNoise;      // 0.000 suggested  (0 = none, static grain)
uniform float uNoiseScale;  // 1.0 suggested  (grain size in px)
uniform float uAnimMode;    // 0 (0=none,1=organic,2=hwave,3=vwave,4=pulse,5=swirl,6=breathe,7=drift,8=liquid,9=ripple)
uniform float uHueShift;    // 0.00 hue rotation in radians
uniform vec2  uResolution;  // canvas resolution in pixels
uniform float uCropMode;    // 0 = stretch, 1 = crop (cover)

vec4 cubicWeights(float v){
  vec4 n = vec4(1.0, 2.0, 3.0, 4.0) - v;
  vec4 s = n * n * n;
  float x = s.x;
  float y = s.y - 4.0 * s.x;
  float z = s.z - 4.0 * s.y + 6.0 * s.x;
  float w = 6.0 - x - y - z;
  return vec4(x, y, z, w) * (1.0 / 6.0);
}

vec3 textureBicubic(sampler2D tex, vec2 uv, vec2 texSize){
  vec2 invSize = 1.0 / texSize;
  uv = uv * texSize - 0.5;
  vec2 f = fract(uv);
  uv -= f;
  vec4 xw = cubicWeights(f.x);
  vec4 yw = cubicWeights(f.y);
  vec4 c  = uv.xxyy + vec2(-0.5, 1.5).xyxy;
  vec4 s  = vec4(xw.xz + xw.yw, yw.xz + yw.yw);
  vec4 o  = c + vec4(xw.yw, yw.yw) / s;
  o *= invSize.xxyy;
  vec3 s0 = texture2D(tex, o.xz).rgb;
  vec3 s1 = texture2D(tex, o.yz).rgb;
  vec3 s2 = texture2D(tex, o.xw).rgb;
  vec3 s3 = texture2D(tex, o.yw).rgb;
  float sx = s.x / (s.x + s.y);
  float sy = s.z / (s.z + s.w);
  return mix(mix(s3, s2, sx), mix(s1, s0, sx), sy);
}

float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

vec3 hueRotate(vec3 c, float angle){
  float co = cos(angle), si = sin(angle);
  vec3 w = vec3(0.299, 0.587, 0.114);
  vec3 r = vec3(
    co + (1.0 - co) * w.x,
    (1.0 - co) * w.x * w.y - si * w.z,
    (1.0 - co) * w.x * w.z + si * w.y
  );
  vec3 g = vec3(
    (1.0 - co) * w.x * w.y + si * w.z,
    co + (1.0 - co) * w.y,
    (1.0 - co) * w.y * w.z - si * w.x
  );
  vec3 b = vec3(
    (1.0 - co) * w.x * w.z - si * w.y,
    (1.0 - co) * w.y * w.z + si * w.x,
    co + (1.0 - co) * w.z
  );
  return vec3(dot(c, r), dot(c, g), dot(c, b));
}

vec2 coverUV(vec2 uv, vec2 texSize, vec2 resolution){
  float texAspect = texSize.x / texSize.y;
  float screenAspect = resolution.x / resolution.y;
  vec2 s = vec2(1.0);
  if(screenAspect > texAspect){
    s.y = screenAspect / texAspect;
  } else {
    s.x = texAspect / screenAspect;
  }
  return (uv - 0.5) / s + 0.5;
}

// --- Animation modes ---
// Each returns a warped UV. All use uFlow as intensity, uScale as detail.

// 1: Organic flow (original) — multi-octave sinusoidal domain warp
vec2 warpOrganic(vec2 uv, float t){
  vec2 p = uv * uScale;
  vec2 d;
  d.x = sin(p.y + t) + 0.5 * cos(p.x * 1.3 - t * 0.8);
  d.y = cos(p.x + t * 0.9) + 0.5 * sin(p.y * 1.3 + t * 0.7);
  d.x += 0.35 * sin(p.y * 2.1 - t * 1.3);
  d.y += 0.35 * cos(p.x * 2.1 + t * 1.1);
  return uv + d * uFlow * 0.06;
}

// 2: Horizontal wave — wave sweeps left to right with vertical delay
vec2 warpHWave(vec2 uv, float t){
  float phase = uv.x * uScale * 2.0 + t;
  float wave = sin(phase) * 0.5 + sin(phase * 0.6 + 1.3) * 0.3;
  return uv + vec2(0.0, wave * uFlow * 0.08);
}

// 3: Vertical wave — wave sweeps top to bottom
vec2 warpVWave(vec2 uv, float t){
  float phase = uv.y * uScale * 2.0 + t;
  float wave = sin(phase) * 0.5 + sin(phase * 0.7 + 2.0) * 0.3;
  return uv + vec2(wave * uFlow * 0.08, 0.0);
}

// 4: Circular pulse — radial waves from center
vec2 warpPulse(vec2 uv, float t){
  vec2 c = uv - 0.5;
  float r = length(c);
  float wave = sin(r * uScale * 8.0 - t * 2.0) * uFlow * 0.05;
  return uv + normalize(c + 0.001) * wave;
}

// 5: Swirl — rotation that varies with distance from center
vec2 warpSwirl(vec2 uv, float t){
  vec2 c = uv - 0.5;
  float r = length(c);
  float angle = r * uScale * 3.0 * uFlow * sin(t * 0.5);
  float cs = cos(angle), sn = sin(angle);
  return vec2(c.x * cs - c.y * sn, c.x * sn + c.y * cs) + 0.5;
}

// 6: Breathing — gentle uniform scale oscillation from center
vec2 warpBreathe(vec2 uv, float t){
  vec2 c = uv - 0.5;
  float s = 1.0 + sin(t) * uFlow * 0.1;
  return c * s + 0.5;
}

// 7: Drift — slow diagonal drift with gentle wobble
vec2 warpDrift(vec2 uv, float t){
  vec2 d;
  d.x = sin(t * 0.3) * 0.7 + cos(t * 0.17) * 0.3;
  d.y = cos(t * 0.23) * 0.6 + sin(t * 0.31) * 0.4;
  return uv + d * uFlow * 0.04;
}

// 8: Liquid — turbulent multi-frequency noise-like warp
vec2 warpLiquid(vec2 uv, float t){
  vec2 p = uv * uScale;
  vec2 d;
  d.x = sin(p.y * 1.7 + t) + sin(p.x * 2.3 - t * 1.4) * 0.5
      + sin(p.y * 3.1 + t * 0.7) * 0.25;
  d.y = cos(p.x * 1.9 + t * 1.1) + cos(p.y * 2.7 - t * 0.9) * 0.5
      + cos(p.x * 3.3 + t * 1.3) * 0.25;
  return uv + d * uFlow * 0.04;
}

// 9: Ripple — concentric rings that expand outward
vec2 warpRipple(vec2 uv, float t){
  vec2 c = uv - 0.5;
  float r = length(c);
  float wave = sin(r * uScale * 12.0 - t * 3.0) * exp(-r * 2.0);
  return uv + c * wave * uFlow * 0.15;
}

vec2 warp(vec2 uv, float t){
  // animMode 0 = no animation (identity)
  if(uAnimMode < 0.5) return uv;
  if(uAnimMode < 1.5) return warpOrganic(uv, t);
  if(uAnimMode < 2.5) return warpHWave(uv, t);
  if(uAnimMode < 3.5) return warpVWave(uv, t);
  if(uAnimMode < 4.5) return warpPulse(uv, t);
  if(uAnimMode < 5.5) return warpSwirl(uv, t);
  if(uAnimMode < 6.5) return warpBreathe(uv, t);
  if(uAnimMode < 7.5) return warpDrift(uv, t);
  if(uAnimMode < 8.5) return warpLiquid(uv, t);
  return warpRipple(uv, t);
}

void main(){
  float t = uTime * uSpeed;
  vec2 baseUV = vUv;
  if(uCropMode > 0.5) baseUV = coverUV(baseUV, uTexSize, uResolution);
  vec2 uv = warp(baseUV, t);
  vec3 bilinear = texture2D(uTex, uv).rgb;
  vec3 bicubic  = textureBicubic(uTex, uv, uTexSize);
  vec3 col = mix(bilinear, bicubic, uQuality);
  vec2 dp = gl_FragCoord.xy + t * 60.0;
  float d = hash(dp) + hash(dp + 7.31) - 1.0;
  col += d * (uQuality / 255.0);
  if(uNoise > 0.0){
    vec2 np = floor(gl_FragCoord.xy / uNoiseScale);
    float n = hash(np) * 2.0 - 1.0;
    col += n * uNoise;
  }
  if(uHueShift != 0.0) col = hueRotate(col, uHueShift);
  gl_FragColor = vec4(col, 1.0);
}`;

function compileShader(gl: WebGLRenderingContext, type: number, src: string) {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
    console.error(gl.getShaderInfoLog(s));
  return s;
}

export default function GradientShader({
  className,
  style,
  mode = "crop",
}: {
  className?: string;
  style?: React.CSSProperties;
  mode?: "crop" | "stretch";
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const gl = canvas.getContext("webgl", { antialias: true })!;
    const prog = gl.createProgram()!;
    gl.attachShader(prog, compileShader(gl, gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compileShader(gl, gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    gl.useProgram(prog);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
      gl.STATIC_DRAW
    );
    const aPos = gl.getAttribLocation(prog, "aPos");
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(
      gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
      new Uint8Array([0, 0, 0, 255])
    );

    const img = new Image();
    img.onload = () => {
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
      draw();
    };
    img.src = "data:image/png;base64,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";

    const U = {
      tex: gl.getUniformLocation(prog, "uTex"),
      texSize: gl.getUniformLocation(prog, "uTexSize"),
      time: gl.getUniformLocation(prog, "uTime"),
      flow: gl.getUniformLocation(prog, "uFlow"),
      speed: gl.getUniformLocation(prog, "uSpeed"),
      scale: gl.getUniformLocation(prog, "uScale"),
      quality: gl.getUniformLocation(prog, "uQuality"),
      noise: gl.getUniformLocation(prog, "uNoise"),
      noiseScale: gl.getUniformLocation(prog, "uNoiseScale"),
      animMode: gl.getUniformLocation(prog, "uAnimMode"),
      hueShift: gl.getUniformLocation(prog, "uHueShift"),
      cropMode: gl.getUniformLocation(prog, "uCropMode"),
      resolution: gl.getUniformLocation(prog, "uResolution"),
    };

    // animMode 0 is a static gradient — render once instead of running a
    // permanent requestAnimationFrame loop that re-renders an identical frame.
    const animated = false;
    const t0 = performance.now();
    let animId = 0;
    let running = false;
    let disposed = false;

    function draw() {
      if (disposed) return;
      const t = animated ? (performance.now() - t0) / 1000 : 0;
      gl.uniform1i(U.tex, 0);
      gl.uniform2f(U.texSize, 256, 166);
      gl.uniform1f(U.time, t);
      gl.uniform1f(U.flow, 0.35);
      gl.uniform1f(U.speed, 0.3);
      gl.uniform1f(U.scale, 2.5);
      gl.uniform1f(U.quality, 1);
      gl.uniform1f(U.noise, 0);
      gl.uniform1f(U.noiseScale, 1);
      gl.uniform1f(U.animMode, 0);
      gl.uniform1f(U.hueShift, 0);
      gl.uniform1f(U.cropMode, mode === "stretch" ? 0 : 1);
      gl.uniform2f(U.resolution, gl.drawingBufferWidth, gl.drawingBufferHeight);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    function loop() {
      if (disposed || !running) return;
      draw();
      animId = requestAnimationFrame(loop);
    }

    function start() {
      if (!animated || running || disposed) return;
      running = true;
      animId = requestAnimationFrame(loop);
    }

    function stop() {
      running = false;
      cancelAnimationFrame(animId);
    }

    function resize() {
      const dpr = Math.min(devicePixelRatio || 1, 2);
      canvas!.width = Math.round(canvas!.clientWidth * dpr);
      canvas!.height = Math.round(canvas!.clientHeight * dpr);
      gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
      draw();
    }

    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(canvas);
    resize();

    // Only animate while the canvas is actually on screen.
    const visObserver = new IntersectionObserver(
      ([entry]) => (entry.isIntersecting ? start() : stop()),
      { threshold: 0 }
    );
    visObserver.observe(canvas);

    if (animated) start();
    else draw();

    return () => {
      disposed = true;
      stop();
      resizeObserver.disconnect();
      visObserver.disconnect();
      gl.deleteTexture(tex);
      gl.deleteBuffer(buf);
      gl.deleteProgram(prog);
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    };
  }, [mode]);

  return (
    <canvas
      ref={canvasRef}
      className={className}
      style={{ display: "block", width: "100%", height: "100%", ...style }}
    />
  );
}
