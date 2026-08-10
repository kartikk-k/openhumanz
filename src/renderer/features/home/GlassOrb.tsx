/**
 * GlassOrb — a WebGL glass/glow "voice reactor" blob on a TRANSPARENT canvas.
 *
 * A single balanced, centered organic blob with real glass (refraction, frost,
 * fresnel rim) and a glowing core. It reacts to a `state`:
 *   - "idle"      → slow breathing
 *   - "speaking"  → simulated speech envelope drives size/rim/core
 *   - "thinking"  → steady pulsing glow + gentle rotation
 *
 * The mic is simulated (random speech bursts). To drive from a real mic, feed a
 * 0..1 level into the `speechSim()` return.
 *
 * Press ⌘, (Cmd+Comma) while the orb is on screen to open the live control
 * panel. Tune, then the values persist to localStorage.
 */
import { useEffect, useRef, useState, type MutableRefObject } from 'react';

export type OrbState = 'idle' | 'speaking' | 'thinking' | 'error';

// ── Per-state presets (tuned in the ⌘, panel) ──────────────────────
// Each state has its own full uniform set; the orb smoothly blends between
// them when `state` changes.
export const ORB_PRESETS = {
  idle: {
    uRadius: 0.24,
    uLobes: 1,
    uWobble: 0.015,
    uWobbleSpeed: 2.8,
    uSquish: -0.01,
    uLayers: 3,
    uLayerGap: 0.115,
    uRefract: 0.04,
    uRimWidth: 0.007,
    uRimGlow: 0.8,
    uFrost: 1,
    uFresnel: 4,
    uGlassOp: 1,
    uCoreGlow: 0,
    uCoreSize: 0.2,
    uBloom: 1.85,
    uAmp: 0.34,
    uSpeed: 1.6,
    uShapeMode: 0,
    uSharp: 0.5,
    uLobes2: 0,
    uWobble2: 0,
    uTwist: 0,
    uLayerSpin: 0,
    uSwirl: 0,
    uCaustic: 0,
    cCore: '#bdfeff',
    cMid: '#86e9fd',
    cRim: '#8affd2',
  },
  speaking: {
    uRadius: 0.225,
    uLobes: 0,
    uWobble: 0.08,
    uWobbleSpeed: 2.8,
    uSquish: -0.01,
    uLayers: 3,
    uLayerGap: 0.115,
    uRefract: 0.04,
    uRimWidth: 0.007,
    uRimGlow: 0.8,
    uFrost: 1,
    uFresnel: 4,
    uGlassOp: 1,
    uCoreGlow: 2.1,
    uCoreSize: 0.25,
    uBloom: 1.45,
    uAmp: 0.34,
    uSpeed: 0.75,
    uShapeMode: 0,
    uSharp: 0.5,
    uLobes2: 0,
    uWobble2: 0,
    uTwist: 0,
    uLayerSpin: 0,
    uSwirl: 0,
    uCaustic: 0,
    cCore: '#bdfeff',
    cMid: '#86e9fd',
    cRim: '#8affd2',
  },
  thinking: {
    uRadius: 0.225,
    uLobes: 4,
    uWobble: 0.035,
    uWobbleSpeed: 3,
    uSquish: 0,
    uLayers: 3,
    uLayerGap: 0.115,
    uRefract: 0.04,
    uRimWidth: 0.007,
    uRimGlow: 0.8,
    uFrost: 1,
    uFresnel: 4,
    uGlassOp: 1,
    uCoreGlow: 2.1,
    uCoreSize: 0.25,
    uBloom: 1.2,
    uAmp: 0.34,
    uSpeed: 1.95,
    uShapeMode: 0,
    uSharp: 0.5,
    uLobes2: 0,
    uWobble2: 0,
    uTwist: 0,
    uLayerSpin: 0,
    uSwirl: 0,
    uCaustic: 0,
    cCore: '#bdfeff',
    cMid: '#86e9fd',
    cRim: '#8affd2',
  },
  // Error — red, agitated (fast tremor + throb driven in the frame loop).
  error: {
    uRadius: 0.22,
    uLobes: 0,
    uWobble: 0.14,
    uWobbleSpeed: 4.5,
    uSquish: 0,
    uLayers: 3,
    uLayerGap: 0.1,
    uRefract: 0.05,
    uRimWidth: 0.008,
    uRimGlow: 1.6,
    uFrost: 0.8,
    uFresnel: 4,
    uGlassOp: 1,
    uCoreGlow: 2.2,
    uCoreSize: 0.24,
    uBloom: 1.4,
    uAmp: 0.5,
    uSpeed: 2.6,
    uShapeMode: 0,
    uSharp: 0.5,
    uLobes2: 0,
    uWobble2: 0,
    uTwist: 0,
    uLayerSpin: 0,
    uSwirl: 0.4,
    uCaustic: 0.3,
    cCore: '#ffe0dc',
    cMid: '#ff3b30',
    cRim: '#ff6b5e',
  },
} as const;

// fixed background rotation speed (radians/sec) — never changes with state
const ROTATE_SPEED = -0.12;

export const ORB_DEFAULTS = ORB_PRESETS.idle;

export type Uniforms = typeof ORB_DEFAULTS;

// ── Shapes: alternate silhouettes, independent of the mode (idle/…/error) ──
// Pass `preset="Spiral"` etc. to override the state look with one of these.
export const ORB_GALLERY: Record<string, Uniforms> = {
  // Spiral galaxy — twisted spiral rings + pinwheel layers + core vortex.
  Spiral: {
    uRadius: 0.22,
    uLobes: 5,
    uWobble: 0.06,
    uWobbleSpeed: 1.2,
    uSquish: 0,
    uLayers: 5,
    uLayerGap: 0.06,
    uRefract: 0.03,
    uRimWidth: 0.005,
    uRimGlow: 1.8,
    uFrost: 0.5,
    uFresnel: 3,
    uGlassOp: 0.6,
    uCoreGlow: 1.8,
    uCoreSize: 0.2,
    uBloom: 1.1,
    uAmp: 0.2,
    uSpeed: 1.3,
    uShapeMode: 0,
    uSharp: 0.5,
    uLobes2: 0,
    uWobble2: 0,
    uTwist: 3.5,
    uLayerSpin: 0.5,
    uSwirl: 1.0,
    uCaustic: 0.3,
    cCore: '#fff0f6',
    cMid: '#ff6fae',
    cRim: '#ffc2dd',
  },
  // Molten gem — superellipse squircle, compound harmonic, glassy amber.
  Gem: {
    uRadius: 0.24,
    uLobes: 4,
    uWobble: 0.13,
    uWobbleSpeed: 0.7,
    uSquish: 0,
    uLayers: 3,
    uLayerGap: 0.08,
    uRefract: 0.05,
    uRimWidth: 0.007,
    uRimGlow: 1.6,
    uFrost: 0.5,
    uFresnel: 3.5,
    uGlassOp: 0.7,
    uCoreGlow: 1.6,
    uCoreSize: 0.2,
    uBloom: 1.0,
    uAmp: 0.14,
    uSpeed: 0.9,
    uShapeMode: 2,
    uSharp: 0.6,
    uLobes2: 8,
    uWobble2: 0.015,
    uTwist: 0,
    uLayerSpin: 0,
    uSwirl: 0,
    uCaustic: 0.4,
    cCore: '#fffbe6',
    cMid: '#ffd54a',
    cRim: '#fff0a8',
  },
  // Vortex — extreme twist, deep pinwheel, spiraling ink whirlpool.
  Vortex: {
    uRadius: 0.22,
    uLobes: 3,
    uWobble: 0.04,
    uWobbleSpeed: 1.8,
    uSquish: 0,
    uLayers: 5,
    uLayerGap: 0.05,
    uRefract: 0.04,
    uRimWidth: 0.004,
    uRimGlow: 1.4,
    uFrost: 0.6,
    uFresnel: 3,
    uGlassOp: 0.6,
    uCoreGlow: 1.9,
    uCoreSize: 0.18,
    uBloom: 1.0,
    uAmp: 0.18,
    uSpeed: 1.6,
    uShapeMode: 0,
    uSharp: 0.5,
    uLobes2: 0,
    uWobble2: 0,
    uTwist: 5.5,
    uLayerSpin: 0.7,
    uSwirl: 1.8,
    uCaustic: 0.5,
    cCore: '#e6e9ff',
    cMid: '#6d7bff',
    cRim: '#b3c0ff',
  },
  // Cog — squircle polygon mode, many flat sides, mechanical & crisp.
  Cog: {
    uRadius: 0.24,
    uLobes: 8,
    uWobble: 0.1,
    uWobbleSpeed: 0.5,
    uSquish: 0,
    uLayers: 3,
    uLayerGap: 0.07,
    uRefract: 0.02,
    uRimWidth: 0.006,
    uRimGlow: 1.9,
    uFrost: 0.35,
    uFresnel: 2.6,
    uGlassOp: 0.5,
    uCoreGlow: 1.4,
    uCoreSize: 0.2,
    uBloom: 0.8,
    uAmp: 0.1,
    uSpeed: 0.6,
    uShapeMode: 2,
    uSharp: 0.9,
    uLobes2: 0,
    uWobble2: 0,
    uTwist: 0,
    uLayerSpin: 0.12,
    uSwirl: 0,
    uCaustic: 0.3,
    cCore: '#fff5e8',
    cMid: '#ffab5e',
    cRim: '#ffd9a8',
  },
  // Nebula — huge soft compound cloud, twist + swirl + caustics, cosmic.
  Nebula: {
    uRadius: 0.3,
    uLobes: 7,
    uWobble: 0.05,
    uWobbleSpeed: 1.0,
    uSquish: 0.02,
    uLayers: 5,
    uLayerGap: 0.08,
    uRefract: 0.08,
    uRimWidth: 0.008,
    uRimGlow: 1.0,
    uFrost: 0.95,
    uFresnel: 4,
    uGlassOp: 0.75,
    uCoreGlow: 1.5,
    uCoreSize: 0.26,
    uBloom: 1.8,
    uAmp: 0.24,
    uSpeed: 1.1,
    uShapeMode: 0,
    uSharp: 0.5,
    uLobes2: 13,
    uWobble2: 0.02,
    uTwist: 2.2,
    uLayerSpin: 0.3,
    uSwirl: 0.8,
    uCaustic: 0.6,
    cCore: '#fce9ff',
    cMid: '#a15bff',
    cRim: '#ff9be0',
  },
};

export const GALLERY_NAMES = Object.keys(ORB_GALLERY);

const VERT = `attribute vec2 aPos; varying vec2 vUv;
void main(){ vUv = aPos*0.5+0.5; gl_Position = vec4(aPos,0.0,1.0); }`;

const FRAG = `precision highp float;
varying vec2 vUv;
uniform vec2  uResolution;
uniform float uPixelSize;   // intended orb box size in device pixels
uniform float uTime;
uniform float uPhase;        // CPU-accumulated animation phase (speed-continuous)
uniform float uWobblePhase;  // CPU-accumulated wobble sweep phase
uniform float uLevel;
uniform float uPulse;
uniform float uRadius, uLobes, uWobble, uWobbleSpeed, uSquish, uLayers, uLayerGap;
uniform float uRefract, uRimWidth, uRimGlow, uFrost, uFresnel, uGlassOp;
uniform float uCoreGlow, uCoreSize, uBloom;
uniform float uAmp, uSpeed;
uniform float uAngle;   // accumulated rotation angle (CPU-driven, state-independent)
// ── extended shape/layer/detail controls ──
uniform float uShapeMode;   // 0 = sine lobes, 1 = star/spike, 2 = superellipse (squircle→square)
uniform float uSharp;       // lobe sharpness (star point-iness / superellipse exponent)
uniform float uLobes2;      // secondary harmonic count (compound organic shapes)
uniform float uWobble2;     // secondary harmonic depth
uniform float uTwist;       // per-radius rotation -> spiral rings
uniform float uLayerSpin;   // extra rotation added per layer (pinwheel)
uniform float uSwirl;       // core vortex strength
uniform float uCaustic;     // ripple/caustic bands inside the glass
uniform vec3 cCore, cMid, cRim;

float hash(vec2 p){ p = fract(p*vec2(123.34,345.45)); p += dot(p,p+34.345); return fract(p.x*p.y); }
float noise(vec2 p){
  vec2 i=floor(p), f=fract(p);
  float a=hash(i), b=hash(i+vec2(1,0)), c=hash(i+vec2(0,1)), d=hash(i+vec2(1,1));
  vec2 u=f*f*(3.0-2.0*f);
  return mix(mix(a,b,u.x),mix(c,d,u.x),u.y);
}
mat2 rot(float a){ float s=sin(a),c=cos(a); return mat2(c,-s,s,c); }

// per-lobe profile: reshape a raw cosine (-1..1) into different silhouettes.
//  mode 0: smooth sine lobes (flowery)
//  mode 1: star / spikes  (sharp points, controlled by uSharp)
//  mode 2: superellipse-ish flat-sided bumps (squircle -> polygon)
float lobeProfile(float c){
  if(uShapeMode < 0.5){
    return c;                                   // smooth sine
  } else if(uShapeMode < 1.5){
    // star: push the crest to a point, flatten the valleys
    float s = 0.5 + 0.5*c;                      // 0..1
    s = pow(s, 1.0 + uSharp*4.0);               // sharpen
    return s*2.0 - 1.0;
  } else {
    // superellipse-style: flatten the sides, keep rounded corners
    float s = abs(c);
    s = pow(s, 1.0 / (1.0 + uSharp*4.0));
    return sign(c)*s;
  }
}

// geometrically-balanced blob: N evenly-spaced IDENTICAL lobes (perfect
// rotational symmetry), plus an optional 2nd harmonic, spiral twist and
// per-layer spin. Sweep phase comes from uWobblePhase (CPU-accumulated) so it
// stays continuous when speed blends. radial field: length - r(angle)
float blobField(vec2 p, float scale, float phase, float layerSpin){
  float len = length(p);
  // spiral twist: rotate the angle proportional to radius -> spinning rings
  float ang = atan(p.y, p.x) + uTwist * len + layerSpin;

  float amp = uWobble * (1.0 + 0.5*uLevel);
  float wob = amp * lobeProfile(cos(uLobes * ang + phase));
  // secondary harmonic layered on top for compound / less-regular shapes
  wob += uWobble2 * cos(uLobes2 * ang - phase*0.7);

  float r = (uRadius*scale) * (1.0 + wob) * (1.0 + 0.12*uLevel);
  return len - r;
}

void main(){
  vec2 uv = vUv;
  // pixel-space coords centered on the canvas, then normalized by the intended
  // orb size (uPixelSize) — NOT the canvas size — so the orb stays a fixed
  // on-screen size even when the canvas is fullscreen. This lets the glow fade
  // out fully inside a big transparent canvas (clean blend, no square edge).
  vec2 px = (uv - 0.5) * uResolution;   // pixels from center, uniform scale on both axes
  vec2 p = px / uPixelSize;             // 1.0 == half the intended orb box

  // uPhase is a CPU-accumulated animation phase (advanced by the current,
  // blended speed each frame) — continuous across state changes so nothing
  // lurches or brakes when speed blends. Use it instead of uTime*uSpeed.
  float t = uPhase;
  float drive = uLevel;
  float breathe = 1.0 + uAmp*(0.05*sin(t*1.1) + 0.10*drive + 0.05*uPulse*sin(t*2.3));
  p /= breathe;
  p.y *= 1.0 + uSquish;              // optional gentle squish, default 0 = round
  // uAngle is accumulated on the CPU at a fixed rate, independent of state, so
  // transitions never speed up / reverse the spin. Just a steady background turn.
  p *= rot(uAngle);

  // transparent background — accumulate color + alpha only where the shape is
  vec3 col = vec3(0.0);
  float alpha = 0.0;
  float cd = length(p);

  // ── concentric glass RING outlines (thin bright rim, near-transparent fill) ──
  // drawn outermost first so inner rings/core layer on top. Each ring is a
  // smooth near-circle with the same symmetric wobble, rotated slightly per
  // layer so they don't perfectly stack (organic, but still balanced).
  int LAYERS = int(uLayers);
  for(int i=4;i>=0;i--){
    if(i >= LAYERS) continue;
    float fi = float(i);
    float scale = 1.0 + fi*uLayerGap/uRadius;   // strictly nested, no overlap
    // wobble phase: continuous CPU-accumulated sweep + a static per-ring offset
    float wobblePhase = uWobblePhase + fi*1.3;
    float layerT = t + fi*1.3;                  // (for interior noise anim)
    // pinwheel: each ring rotated a bit more than the last
    float layerSpin = uLayerSpin * fi;

    // boundary distance from CLEAN coords -> a perfect circle when uWobble==0.
    // refraction only warps the interior texture below, never the outline.
    float d = blobField(p, scale, wobblePhase, layerSpin);

    // refracted coords for the frosted glass interior (does not move the edge)
    vec2 rp = p;
    float nf = noise(p*5.0 + layerT*0.2);
    rp += (nf-0.5) * uRefract * (1.0 + drive);

    // faint frosted interior fill (mostly transparent, like the reference)
    float inside = smoothstep(0.006, -0.006, d);
    float frost = 0.4 + 0.6*noise(rp*8.0 + fi*3.1);
    // caustic bands: concentric light ripples inside the glass
    float caustic = 1.0 + uCaustic * 0.6 * sin(length(rp)*40.0 - t*2.0 + fi*2.0);
    float fillA = inside * uGlassOp * uFrost * (0.15 + 0.15*fi);
    vec3 glassCol = mix(cMid, cCore, 0.5);
    col += glassCol * frost * caustic * fillA;
    alpha = max(alpha, fillA);

    // fresnel inner sheen near the edge
    float fres = pow(1.0 - smoothstep(0.0, uRadius*0.4*scale, abs(d)), uFresnel);
    col += glassCol * fres * inside * 0.12;
    alpha = max(alpha, fres*inside*0.12);

    // the bright rim OUTLINE — this is the defining feature
    float rim = smoothstep(uRimWidth, 0.0, abs(d));
    float rimPulse = 0.7 + 0.6*drive + 0.3*uPulse;
    // outer rings dimmer, inner rings brighter
    float rimFade = mix(0.55, 1.0, 1.0 - fi/max(1.0,float(LAYERS)));
    col += cRim * rim * uRimGlow * rimPulse * rimFade;
    alpha = max(alpha, rim*rimFade);
  }

  // ── glowing core (bright warm center) ─────────────────────────────
  float core = pow(smoothstep(uCoreSize*(1.0+0.4*drive), 0.0, cd), 1.6);
  // swirl: a vortex of light spiraling into the core
  float coreAng = atan(p.y, p.x);
  float swirl = 1.0 + uSwirl * 0.5 * sin(coreAng*3.0 + cd*18.0 - t*3.0);
  float coreDrive = uCoreGlow * (0.7 + 0.9*drive + 0.4*uPulse);
  col += cCore * core * coreDrive * swirl;
  alpha = max(alpha, core*0.9);

  // warm halo blooming out from the core
  float halo = smoothstep(uCoreSize*2.2, 0.0, cd);
  col += cMid * halo * uBloom * (0.4+0.6*drive);
  alpha = max(alpha, halo*0.6*uBloom);

  // soft outer glow, fully transparent at the edge
  float outer = smoothstep(uRadius*1.6, uRadius*0.7, cd);
  col += cMid * outer * 0.10 * (0.5+drive);
  alpha = max(alpha, outer*0.15);

  alpha = clamp(alpha, 0.0, 1.0);
  col = col / (1.0 + col*0.3);
  col = pow(max(col,0.0), vec3(0.95));

  gl_FragColor = vec4(col*alpha, alpha); // premultiplied
}`;

function hexToRgb(h: string): [number, number, number] {
  const n = parseInt(h.slice(1), 16);
  // bitwise is the natural way to unpack a packed hex color
  /* eslint-disable no-bitwise */
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  /* eslint-enable no-bitwise */
}

const FLOAT_KEYS = [
  'uRadius',
  'uLobes',
  'uWobble',
  'uWobbleSpeed',
  'uSquish',
  'uLayers',
  'uLayerGap',
  'uRefract',
  'uRimWidth',
  'uRimGlow',
  'uFrost',
  'uFresnel',
  'uGlassOp',
  'uCoreGlow',
  'uCoreSize',
  'uBloom',
  'uAmp',
  'uSpeed',
  'uSharp',
  'uLobes2',
  'uWobble2',
  'uTwist',
  'uLayerSpin',
  'uSwirl',
  'uCaustic',
] as const;
// uShapeMode is discrete — snapped, not blended (see frame loop)
const SNAP_KEYS = ['uShapeMode'] as const;
const COLOR_KEYS = ['cCore', 'cMid', 'cRim'] as const;

const STORE_KEY = 'glassorb.presets';

type PresetMap = Record<OrbState, Uniforms>;

const STATE_NAMES = ['idle', 'speaking', 'thinking', 'error'] as const;

function loadPresets(): PresetMap {
  const base: PresetMap = {
    idle: { ...ORB_PRESETS.idle },
    speaking: { ...ORB_PRESETS.speaking },
    thinking: { ...ORB_PRESETS.thinking },
    error: { ...ORB_PRESETS.error },
  };
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const saved = JSON.parse(raw) as Partial<PresetMap>;
      STATE_NAMES.forEach((s) => {
        if (saved[s]) base[s] = { ...base[s], ...saved[s] };
      });
    }
  } catch {
    /* ignore */
  }
  return base;
}

// smoothly step a numeric value toward a target (frame-rate independent-ish)
function approach(cur: number, target: number, rate: number): number {
  return cur + (target - cur) * rate;
}
// blend two hex colors
function mixHex(a: string, b: string, t: number): string {
  const pa = hexToRgb(a);
  const pb = hexToRgb(b);
  const c = pa.map((v, i) => Math.round((v + (pb[i] - v) * t) * 255));
  return `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

export interface GlassOrbProps {
  state?: OrbState;
  className?: string;
  /** intended on-screen diameter of the orb in CSS pixels (default 320) */
  size?: number;
  /** enable the ⌘, control panel (default true) */
  controls?: boolean;
  /** override with a named look from ORB_GALLERY (ignores `state` when set) */
  preset?: string;
  /**
   * Live drive level 0..1 read every frame. Pass a ref (e.g. from
   * useMicLevel) to drive the `speaking` animation from real mic volume
   * instead of the built-in simulator. When its `.current` is null (or no ref
   * is given), the simulator is used.
   */
  levelRef?: MutableRefObject<number | null>;
}

export function GlassOrb({
  state = 'idle',
  className,
  size = 320,
  controls = true,
  preset,
  levelRef: externalLevelRef,
}: GlassOrbProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stateRef = useRef<OrbState>(state);
  const presetRef = useRef<string | undefined>(preset);
  const sizeRef = useRef<number>(size);
  const levelRef = useRef<MutableRefObject<number | null> | undefined>(
    externalLevelRef,
  );
  const [presets, setPresets] = useState<PresetMap>(loadPresets);
  const [panelOpen, setPanelOpen] = useState(false);
  // live-blended uniforms actually sent to the shader
  const presetsRef = useRef<PresetMap>(presets);
  const activeRef = useRef<Uniforms>({ ...presets[state] });

  stateRef.current = state;
  presetRef.current = preset;
  sizeRef.current = size;
  levelRef.current = externalLevelRef;
  presetsRef.current = presets;

  // ⌘, / Ctrl+, toggles the panel
  useEffect(() => {
    if (!controls) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === ',') {
        e.preventDefault();
        setPanelOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [controls]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const gl = canvas.getContext('webgl', {
      antialias: true,
      premultipliedAlpha: true,
      alpha: true,
    });
    if (!gl) return undefined;

    const compile = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
        console.error(gl.getShaderInfoLog(s));
      return s;
    };

    const prog = gl.createProgram()!;
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    gl.useProgram(prog);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); // premultiplied alpha

    const bufv = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, bufv);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 3, -1, -1, 3]),
      gl.STATIC_DRAW,
    );
    const aPos = gl.getAttribLocation(prog, 'aPos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    const locs = new Map<string, WebGLUniformLocation | null>();
    const loc = (n: string) => {
      if (!locs.has(n)) locs.set(n, gl.getUniformLocation(prog, n));
      return locs.get(n)!;
    };

    let dpr = Math.min(window.devicePixelRatio || 1, 2);
    const resize = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = canvas.clientWidth || 300;
      const h = canvas.clientHeight || 300;
      canvas.width = Math.max(1, Math.floor(w * dpr));
      canvas.height = Math.max(1, Math.floor(h * dpr));
      gl.viewport(0, 0, canvas.width, canvas.height);
    };
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    resize();

    let T = 0;
    let simLevel = 0;
    let simTarget = 0;
    let nextChange = 0;
    const speechSim = () => {
      if (T > nextChange) {
        simTarget = Math.random() > 0.3 ? 0.45 + Math.random() * 0.55 : 0.03;
        nextChange = T + 0.1 + Math.random() * 0.28;
      }
      const jitter =
        simTarget > 0.1 ? (Math.random() - 0.5) * 0.35 * simTarget : 0;
      simLevel += (simTarget + jitter - simLevel) * 0.22;
      return simLevel;
    };

    const start = performance.now();
    let prev = start;
    let angle = 0; // accumulated rotation, state-independent & continuous
    let phase = 0; // accumulated animation phase (advanced by blended speed)
    let wobblePhase = 0; // accumulated wobble sweep phase
    let raf = 0;
    const frame = (now: number) => {
      T = (now - start) / 1000;
      const dt = Math.min(0.05, (now - prev) / 1000); // clamp to avoid jumps after tab-away
      prev = now;

      const s = stateRef.current;
      const gallery = presetRef.current;
      // a gallery preset (if set & valid) overrides the per-state preset
      const target = (gallery && ORB_GALLERY[gallery]) || presetsRef.current[s];
      const active = activeRef.current;

      // smoothly blend the active uniforms toward the current state's preset,
      // so switching state morphs the orb instead of snapping.
      const rate = 0.06;
      for (const k of FLOAT_KEYS) {
        active[k] = approach(
          active[k] as number,
          target[k] as number,
          rate,
        ) as never;
      }
      for (const k of COLOR_KEYS) {
        active[k] = mixHex(
          active[k] as string,
          target[k] as string,
          rate,
        ) as never;
      }
      // discrete params snap instantly (blending a mode index is meaningless)
      for (const k of SNAP_KEYS) {
        active[k] = target[k] as never;
      }

      // advance continuous phases by the CURRENT (blended) rates × dt. Because
      // these are accumulated, a change in speed only changes the RATE going
      // forward — the phase value itself never jumps, so no lurch/brake.
      angle += ROTATE_SPEED * dt;
      phase += (active.uSpeed as number) * dt;
      wobblePhase +=
        (active.uWobbleSpeed as number) *
        (active.uSpeed as number) *
        0.15 *
        dt *
        ((active.uLobes as number) > 0.5 ? (active.uLobes as number) : 1);

      let level = 0;
      let pulse = 0;
      const extLevel = levelRef.current?.current;
      if (s === 'idle') {
        level = 0.05 + 0.03 * Math.sin(T * 0.8);
      } else if (s === 'speaking') {
        // real mic level if a ref supplies one, else the built-in simulator
        level =
          typeof extLevel === 'number'
            ? Math.max(0, extLevel)
            : Math.max(0, speechSim());
      } else if (s === 'error') {
        // agitated: fast tremor + sharp pulsing throb
        level = 0.35 + 0.25 * Math.sin(T * 9) + 0.15 * Math.sin(T * 23);
        pulse = 0.6 + 0.4 * Math.sin(T * 5);
      } else {
        // thinking
        level = 0.14 + 0.05 * Math.sin(T * 3);
        pulse = 0.5 + 0.5 * Math.sin(T * 1.4);
      }

      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);

      gl.uniform2f(loc('uResolution'), canvas.width, canvas.height);
      // orb box in device pixels — fixed on-screen size, independent of canvas
      gl.uniform1f(loc('uPixelSize'), sizeRef.current * dpr);
      gl.uniform1f(loc('uTime'), T);
      gl.uniform1f(loc('uAngle'), angle);
      gl.uniform1f(loc('uPhase'), phase);
      gl.uniform1f(loc('uWobblePhase'), wobblePhase);
      gl.uniform1f(loc('uLevel'), level);
      gl.uniform1f(loc('uPulse'), pulse);
      for (const k of FLOAT_KEYS) gl.uniform1f(loc(k), active[k] as number);
      for (const k of SNAP_KEYS) gl.uniform1f(loc(k), active[k] as number);
      for (const k of COLOR_KEYS)
        gl.uniform3fv(loc(k), hexToRgb(active[k] as string));

      gl.drawArrays(gl.TRIANGLES, 0, 3);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      gl.deleteProgram(prog);
      gl.deleteBuffer(bufv);
    };
  }, []);

  const persist = (next: PresetMap) => {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(next));
    } catch {
      /* ignore */
    }
  };

  // edits apply to the CURRENT state's preset
  const set = (k: keyof Uniforms, v: number | string) => {
    setPresets((prev) => {
      const next = { ...prev, [state]: { ...prev[state], [k]: v } };
      persist(next);
      return next;
    });
  };

  return (
    <>
      {/* Fullscreen transparent canvas: the orb is drawn centered at a fixed
          pixel `size`, but the canvas spans the whole area so the soft glow /
          shadow fades to nothing with no hard square edge. pointer-events off
          so it never blocks UI underneath. */}
      <canvas
        ref={canvasRef}
        className={className}
        style={{
          position: 'fixed',
          inset: 0,
          width: '100%',
          height: '100%',
          background: 'transparent',
          pointerEvents: 'none',
        }}
      />
      {controls && panelOpen && (
        <ControlPanel
          state={state}
          tuned={presets[state]}
          onSet={set}
          onReset={() => {
            setPresets((prev) => {
              const next = { ...prev, [state]: { ...ORB_PRESETS[state] } };
              persist(next);
              return next;
            });
          }}
          onClose={() => setPanelOpen(false)}
        />
      )}
    </>
  );
}

const SLIDERS: Array<{
  k: keyof Uniforms;
  label: string;
  min: number;
  max: number;
  step: number;
}> = [
  { k: 'uRadius', label: 'Radius', min: 0.1, max: 0.45, step: 0.005 },
  { k: 'uLobes', label: 'Lobes', min: 0, max: 16, step: 1 },
  { k: 'uWobble', label: 'Wobble', min: 0, max: 0.2, step: 0.005 },
  { k: 'uWobbleSpeed', label: 'Wobble speed', min: 0, max: 3, step: 0.05 },
  { k: 'uSharp', label: 'Sharpness', min: 0, max: 1, step: 0.02 },
  { k: 'uLobes2', label: 'Lobes 2', min: 0, max: 16, step: 1 },
  { k: 'uWobble2', label: 'Wobble 2', min: 0, max: 0.1, step: 0.002 },
  { k: 'uTwist', label: 'Twist', min: -6, max: 6, step: 0.1 },
  { k: 'uLayerSpin', label: 'Layer spin', min: -1, max: 1, step: 0.02 },
  { k: 'uSquish', label: 'Squish', min: -0.3, max: 0.3, step: 0.01 },
  { k: 'uLayers', label: 'Layers', min: 1, max: 5, step: 1 },
  { k: 'uLayerGap', label: 'Layer gap', min: 0.01, max: 0.15, step: 0.005 },
  { k: 'uSwirl', label: 'Core swirl', min: 0, max: 2, step: 0.05 },
  { k: 'uCaustic', label: 'Caustics', min: 0, max: 1, step: 0.02 },
  { k: 'uRefract', label: 'Refraction', min: 0, max: 0.15, step: 0.002 },
  { k: 'uRimWidth', label: 'Rim width', min: 0.004, max: 0.06, step: 0.001 },
  { k: 'uRimGlow', label: 'Rim glow', min: 0, max: 3, step: 0.05 },
  { k: 'uFrost', label: 'Frost', min: 0, max: 1, step: 0.02 },
  { k: 'uFresnel', label: 'Fresnel', min: 0, max: 4, step: 0.05 },
  { k: 'uGlassOp', label: 'Glass opacity', min: 0, max: 1, step: 0.02 },
  { k: 'uCoreGlow', label: 'Core glow', min: 0, max: 3, step: 0.05 },
  { k: 'uCoreSize', label: 'Core size', min: 0.05, max: 0.5, step: 0.01 },
  { k: 'uBloom', label: 'Bloom', min: 0, max: 2, step: 0.05 },
  { k: 'uAmp', label: 'Breathe amp', min: 0, max: 1, step: 0.02 },
  { k: 'uSpeed', label: 'Speed', min: 0, max: 3, step: 0.05 },
];

const btnStyle: React.CSSProperties = {
  padding: '5px 10px',
  borderRadius: 8,
  border: '1px solid rgba(255,255,255,0.12)',
  background: 'rgba(255,255,255,0.06)',
  color: '#e8e8ec',
  cursor: 'pointer',
  fontSize: 11,
};

function ControlPanel({
  state,
  tuned,
  onSet,
  onReset,
  onClose,
}: {
  state: OrbState;
  tuned: Uniforms;
  onSet: (k: keyof Uniforms, v: number | string) => void;
  onReset: () => void;
  onClose: () => void;
}) {
  return (
    <div
      style={{
        position: 'fixed',
        top: 16,
        right: 16,
        width: 280,
        maxHeight: 'calc(100vh - 32px)',
        overflowY: 'auto',
        padding: 16,
        borderRadius: 16,
        background: 'rgba(20,20,26,0.85)',
        backdropFilter: 'blur(24px)',
        border: '1px solid rgba(255,255,255,0.08)',
        boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
        color: '#e8e8ec',
        fontSize: 12,
        zIndex: 50,
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 10,
        }}
      >
        <strong style={{ fontSize: 13 }}>
          Glass Orb ·{' '}
          <span style={{ color: '#86e9fd', textTransform: 'capitalize' }}>
            {state}
          </span>
        </strong>
        <button onClick={onClose} style={btnStyle}>
          ✕
        </button>
      </div>
      <p style={{ fontSize: 10, opacity: 0.4, marginBottom: 10 }}>
        Editing the “{state}” preset. Switch state to tune others.
      </p>

      {/* discrete shape-mode picker */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
        {(['Sine', 'Star', 'Squircle'] as const).map((label, i) => (
          <button
            key={label}
            onClick={() => onSet('uShapeMode', i)}
            style={{
              ...btnStyle,
              flex: 1,
              background:
                Math.round(tuned.uShapeMode as number) === i
                  ? '#86e9fd'
                  : 'rgba(255,255,255,0.06)',
              color:
                Math.round(tuned.uShapeMode as number) === i
                  ? '#062028'
                  : '#e8e8ec',
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {SLIDERS.map(({ k, label, min, max, step }) => (
        <div
          key={k}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            marginBottom: 8,
          }}
        >
          <span style={{ flex: '0 0 92px', opacity: 0.8, fontSize: 11 }}>
            {label}
          </span>
          <input
            type="range"
            aria-label={label}
            min={min}
            max={max}
            step={step}
            value={tuned[k] as number}
            onChange={(e) => onSet(k, parseFloat(e.target.value))}
            style={{ flex: 1, accentColor: '#ffb26b' }}
          />
          <span
            style={{
              flex: '0 0 38px',
              textAlign: 'right',
              opacity: 0.6,
              fontSize: 10,
            }}
          >
            {(tuned[k] as number).toFixed(step < 0.01 ? 3 : 2)}
          </span>
        </div>
      ))}
      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
        {COLOR_KEYS.map((k) => (
          <div
            key={k}
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 4,
            }}
          >
            <input
              type="color"
              value={tuned[k] as string}
              onChange={(e) => onSet(k, e.target.value)}
              style={{
                width: 40,
                height: 24,
                border: 'none',
                background: 'none',
                cursor: 'pointer',
              }}
            />
            <span style={{ fontSize: 9, opacity: 0.5 }}>{k.slice(1)}</span>
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <CopyButton tuned={tuned} />
        <button onClick={onReset} style={{ ...btnStyle, flex: 1 }}>
          Reset
        </button>
      </div>
      <p style={{ fontSize: 10, opacity: 0.4, marginTop: 8 }}>
        ⌘, to toggle · saved automatically
      </p>
    </div>
  );
}

function CopyButton({ tuned }: { tuned: Uniforms }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    const json = JSON.stringify(tuned, null, 2);
    const done = () => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard
        .writeText(json)
        .then(done)
        .catch(() => {
          console.log(json);
          done();
        });
    } else {
      console.log(json);
      done();
    }
  };
  return (
    <button
      onClick={copy}
      style={{
        ...btnStyle,
        flex: 1,
        background: copied ? '#8fe0c0' : 'rgba(255,255,255,0.06)',
        color: copied ? '#0a2018' : '#e8e8ec',
      }}
    >
      {copied ? 'Copied ✓' : 'Copy settings'}
    </button>
  );
}

export default GlassOrb;
