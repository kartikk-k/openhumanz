/**
 * Imperative Three.js robot-head scene.
 *
 * Mount into a DOM container; call dispose() on unmount. Settings are mutated
 * in place by the React control panel — geometry rebuilds are debounced.
 */
import * as THREE from 'three';

export type RobotMoodId =
  | 'neutral'
  | 'happy'
  | 'angry'
  | 'sad'
  | 'surprised'
  | 'sleepy'
  | 'wink';

export type FaceParams = {
  eyeW: number;
  eyeH: number;
  eyeR: number;
  eyeTilt: number;
  eyeGap: number;
  eyeY: number;
  arcA: number;
  arcSpan: number;
  arcBend: number;
  arcThick: number;
  lidL: number;
  lidR: number;
  browA: number;
  browTilt: number;
  browW: number;
  browH: number;
  browY: number;
  mouthW: number;
  mouthThick: number;
  mouthCurve: number;
  mouthY: number;
  ovalA: number;
  ovalW: number;
  ovalH: number;
};

export type RobotHeadSettings = {
  shellColor: string;
  roughness: number;
  metalness: number;
  headScaleY: number;
  earX: number;
  earY: number;
  earZ: number;
  earRx: number;
  earRy: number;
  earRz: number;
  earBlend: number;
  topX: number;
  topY: number;
  topZ: number;
  topRx: number;
  topRy: number;
  topRz: number;
  topBlend: number;
  bezelWidth: number;
  bezelBlur: number;
  glowSoft: number;
  glowCrisp: number;
  visorRadius: number;
  visorA: number;
  visorB: number;
  hemi: number;
  key: number;
  fill: number;
  rim: number;
  camZ: number;
  camFov: number;
  followX: number;
  followY: number;
  idleYaw: number;
  idlePitch: number;
  idleBob: number;
  motion: boolean;
};

const FACE_BASE: FaceParams = {
  eyeW: 62,
  eyeH: 132,
  eyeR: 31,
  eyeTilt: 0,
  eyeGap: 0.125,
  eyeY: 0.38,
  arcA: 0,
  arcSpan: 130,
  arcBend: 46,
  arcThick: 30,
  lidL: 1,
  lidR: 1,
  browA: 0,
  browTilt: 0,
  browW: 96,
  browH: 22,
  browY: 0.2,
  mouthW: 190,
  mouthThick: 54,
  mouthCurve: 0,
  mouthY: 0.685,
  ovalA: 0,
  ovalW: 104,
  ovalH: 128,
};

const mix = (o: Partial<FaceParams>): FaceParams => ({ ...FACE_BASE, ...o });

export const ROBOT_MOODS: Record<
  RobotMoodId,
  { label: string; p: FaceParams }
> = {
  neutral: { label: 'Neutral', p: mix({}) },
  happy: {
    label: 'Happy',
    p: mix({
      arcA: 1,
      arcBend: 48,
      mouthW: 250,
      mouthThick: 46,
      mouthCurve: 74,
      mouthY: 0.7,
    }),
  },
  angry: {
    label: 'Angry',
    p: mix({
      eyeH: 108,
      eyeTilt: 14,
      browA: 1,
      browTilt: 26,
      browY: 0.205,
      mouthW: 186,
      mouthThick: 44,
      mouthCurve: -46,
      mouthY: 0.72,
    }),
  },
  sad: {
    label: 'Sad',
    p: mix({
      eyeH: 112,
      eyeTilt: -12,
      browA: 1,
      browTilt: -22,
      browY: 0.185,
      mouthW: 158,
      mouthThick: 42,
      mouthCurve: -58,
      mouthY: 0.73,
    }),
  },
  surprised: {
    label: 'Surprised',
    p: mix({
      eyeW: 104,
      eyeH: 116,
      eyeR: 52,
      eyeGap: 0.135,
      eyeY: 0.36,
      browA: 0.55,
      browTilt: -6,
      browY: 0.155,
      ovalA: 1,
      mouthY: 0.71,
    }),
  },
  sleepy: {
    label: 'Sleepy',
    p: mix({
      eyeW: 96,
      eyeH: 26,
      eyeR: 13,
      mouthW: 116,
      mouthThick: 40,
      mouthCurve: 14,
    }),
  },
  wink: {
    label: 'Wink',
    p: mix({
      lidR: 0.09,
      mouthW: 226,
      mouthThick: 46,
      mouthCurve: 66,
      mouthY: 0.7,
    }),
  },
};

export const ROBOT_MOOD_ORDER: RobotMoodId[] = [
  'neutral',
  'happy',
  'angry',
  'sad',
  'surprised',
  'sleepy',
  'wink',
];

export function defaultRobotHeadSettings(
  preferMotion = true,
): RobotHeadSettings {
  return {
    shellColor: '#9c9c9c',
    roughness: 0.92,
    metalness: 0,
    headScaleY: 1.0,
    earX: 1.04,
    earY: -0.02,
    earZ: 0.02,
    earRx: 0.09,
    earRy: 0.28,
    earRz: 0.16,
    earBlend: 0.17,
    topX: 0,
    topY: 1.05,
    topZ: 0.03,
    topRx: 0.26,
    topRy: 0.09,
    topRz: 0.2,
    topBlend: 0.15,
    bezelWidth: 39,
    bezelBlur: 80,
    glowSoft: 80,
    glowCrisp: 7,
    visorRadius: 1.059,
    visorA: 0.77,
    visorB: 0.49,
    hemi: 0.55,
    key: 0.95,
    fill: 0.35,
    rim: 0.55,
    camZ: 6.2,
    camFov: 30,
    followX: 0.34,
    followY: 0.22,
    idleYaw: 0.06,
    idlePitch: 0.03,
    idleBob: 0.03,
    motion: preferMotion,
  };
}

export type RobotHeadHandle = {
  settings: RobotHeadSettings;
  setMood: (id: RobotMoodId) => void;
  getMood: () => RobotMoodId;
  scheduleShellRebuild: () => void;
  scheduleVisorRebuild: () => void;
  markFaceDirty: () => void;
  applyMaterial: () => void;
  applyLights: () => void;
  applyCamera: () => void;
  applyHeadScale: () => void;
  setPointer: (x: number, y: number) => void;
  dispose: () => void;
};

const R = 1;
const CW = 1200;
const CH = 900;
const PAD = 46;
const FACE_KEYS = Object.keys(FACE_BASE) as (keyof FaceParams)[];

function smin(a: number, b: number, k: number) {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}

function sdEllipsoid(
  px: number,
  py: number,
  pz: number,
  cx: number,
  cy: number,
  cz: number,
  rx: number,
  ry: number,
  rz: number,
) {
  const x = (px - cx) / rx;
  const y = (py - cy) / ry;
  const z = (pz - cz) / rz;
  const d = Math.sqrt(x * x + y * y + z * z);
  return (d - 1) * Math.min(rx, ry, rz);
}

function roundRect(
  c: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  const radius = Math.max(0, Math.min(r, w / 2, h / 2));
  c.beginPath();
  c.moveTo(x + radius, y);
  c.arcTo(x + w, y, x + w, y + h, radius);
  c.arcTo(x + w, y + h, x, y + h, radius);
  c.arcTo(x, y + h, x, y, radius);
  c.arcTo(x, y, x + w, y, radius);
  c.closePath();
}

function sphericalPatch(
  radius: number,
  aMax: number,
  bMax: number,
  segX: number,
  segY: number,
) {
  const pos: number[] = [];
  const nor: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  for (let j = 0; j <= segY; j++) {
    const v = j / segY;
    const ay = -bMax + 2 * bMax * v;
    for (let i = 0; i <= segX; i++) {
      const u = i / segX;
      const ax = -aMax + 2 * aMax * u;
      const nx = Math.sin(ax) * Math.cos(ay);
      const ny = Math.sin(ay);
      const nz = Math.cos(ax) * Math.cos(ay);
      pos.push(nx * radius, ny * radius, nz * radius);
      nor.push(nx, ny, nz);
      uv.push(u, v);
    }
  }
  for (let j = 0; j < segY; j++) {
    for (let i = 0; i < segX; i++) {
      const a = j * (segX + 1) + i;
      const b = a + 1;
      const c = a + segX + 1;
      const d = c + 1;
      idx.push(a, b, c, b, d, c);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  return geo;
}

export function createRobotHead(
  container: HTMLElement,
  initial?: Partial<RobotHeadSettings>,
): RobotHeadHandle {
  const reduceMotion = window.matchMedia(
    '(prefers-reduced-motion: reduce)',
  ).matches;
  const settings = {
    ...defaultRobotHeadSettings(!reduceMotion),
    ...initial,
  };

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(settings.camFov, 1, 0.5, 40);
  camera.position.set(0, 0, settings.camZ);

  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: true,
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setClearColor(0x000000, 0);
  container.appendChild(renderer.domElement);
  Object.assign(renderer.domElement.style, {
    display: 'block',
    width: '100%',
    height: '100%',
  });

  const robot = new THREE.Group();
  scene.add(robot);

  const hemi = new THREE.HemisphereLight(0xffffff, 0x6f6f6f, settings.hemi);
  scene.add(hemi);
  const keyLight = new THREE.DirectionalLight(0xffffff, settings.key);
  keyLight.position.set(-3.2, 3.4, 4.0);
  scene.add(keyLight);
  const fillLight = new THREE.DirectionalLight(0xffffff, settings.fill);
  fillLight.position.set(-2.6, -2.8, 2.0);
  scene.add(fillLight);
  const rimLight = new THREE.DirectionalLight(0xffffff, settings.rim);
  rimLight.position.set(3.4, 0.6, -2.4);
  scene.add(rimLight);

  const shellMat = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(settings.shellColor),
    roughness: settings.roughness,
    metalness: settings.metalness,
    clearcoat: 0,
    clearcoatRoughness: 1,
  });

  function shellSDF(x: number, y: number, z: number) {
    let d = Math.sqrt(x * x + y * y + z * z) - R;
    const s = settings;
    d = smin(
      d,
      sdEllipsoid(
        x,
        y,
        z,
        -s.earX,
        s.earY,
        s.earZ,
        s.earRx,
        s.earRy,
        s.earRz,
      ),
      s.earBlend,
    );
    d = smin(
      d,
      sdEllipsoid(x, y, z, s.earX, s.earY, s.earZ, s.earRx, s.earRy, s.earRz),
      s.earBlend,
    );
    d = smin(
      d,
      sdEllipsoid(x, y, z, s.topX, s.topY, s.topZ, s.topRx, s.topRy, s.topRz),
      s.topBlend,
    );
    return d;
  }

  function buildShellGeometry() {
    const geo = new THREE.SphereGeometry(R, 128, 128);
    const pos = geo.attributes.position;
    const dir = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      dir.fromBufferAttribute(pos, i).normalize();
      let lo = 0.65;
      let hi = 1.5;
      for (let s = 0; s < 22; s++) {
        const mid = (lo + hi) * 0.5;
        if (shellSDF(dir.x * mid, dir.y * mid, dir.z * mid) > 0) hi = mid;
        else lo = mid;
      }
      pos.setXYZ(i, dir.x * lo, dir.y * lo, dir.z * lo);
    }
    pos.needsUpdate = true;
    geo.computeVertexNormals();
    return geo;
  }

  let head = new THREE.Mesh(buildShellGeometry(), shellMat);
  head.scale.set(1, settings.headScaleY, 1);
  robot.add(head);

  let shellRebuildTimer = 0;
  function scheduleShellRebuild() {
    window.clearTimeout(shellRebuildTimer);
    shellRebuildTimer = window.setTimeout(() => {
      const next = new THREE.Mesh(buildShellGeometry(), shellMat);
      next.scale.set(1, settings.headScaleY, 1);
      robot.remove(head);
      head.geometry.dispose();
      head = next;
      robot.add(head);
    }, 120);
  }

  let current: RobotMoodId = 'neutral';
  let target = { ...ROBOT_MOODS.neutral.p };
  let cur = { ...ROBOT_MOODS.neutral.p };
  let faceDirty = true;

  const faceCanvas = document.createElement('canvas');
  faceCanvas.width = CW;
  faceCanvas.height = CH;
  const ctx = faceCanvas.getContext('2d')!;

  function glow(paint: () => void, alpha: number) {
    if (alpha <= 0.01) return;
    ctx.save();
    ctx.globalAlpha = alpha * 0.55;
    ctx.shadowColor = 'rgba(255,255,255,0.95)';
    ctx.shadowBlur = settings.glowSoft;
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#ffffff';
    paint();
    ctx.globalAlpha = alpha;
    ctx.shadowBlur = settings.glowCrisp;
    paint();
    ctx.restore();
  }

  function drawFace(p: FaceParams, openness: number) {
    ctx.clearRect(0, 0, CW, CH);
    const vx = PAD;
    const vy = PAD;
    const vw = CW - PAD * 2;
    const vh = CH - PAD * 2;

    const g = ctx.createLinearGradient(
      vx + vw * 0.85,
      vy + vh,
      vx + vw * 0.25,
      vy,
    );
    g.addColorStop(0.0, '#5a5a5a');
    g.addColorStop(0.35, '#3a3a3a');
    g.addColorStop(0.75, '#1d1d1d');
    g.addColorStop(1.0, '#141414');
    ctx.fillStyle = g;
    roundRect(ctx, vx, vy, vw, vh, 250);
    ctx.fill();

    ctx.save();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = settings.bezelWidth;
    ctx.shadowColor = 'rgba(255,255,255,0.55)';
    ctx.shadowBlur = settings.bezelBlur;
    roundRect(ctx, vx, vy, vw, vh, 250);
    ctx.stroke();
    ctx.restore();

    const cx = vx + vw * 0.5;
    const eyes = [
      { x: cx - vw * p.eyeGap, sign: 1, lid: p.lidL },
      { x: cx + vw * p.eyeGap, sign: -1, lid: p.lidR },
    ];

    eyes.forEach((e) => {
      const squash = Math.max(0.05, openness * e.lid);
      const ey = vy + vh * p.eyeY;

      if (p.browA > 0.01) {
        ctx.save();
        ctx.translate(e.x, vy + vh * p.browY);
        ctx.rotate((e.sign * p.browTilt * Math.PI) / 180);
        glow(() => {
          roundRect(
            ctx,
            -p.browW / 2,
            -p.browH / 2,
            p.browW,
            p.browH,
            p.browH / 2,
          );
          ctx.fill();
        }, p.browA);
        ctx.restore();
      }

      if (p.arcA < 0.99) {
        ctx.save();
        ctx.translate(e.x, ey);
        ctx.rotate((e.sign * p.eyeTilt * Math.PI) / 180);
        ctx.scale(1, squash);
        glow(() => {
          roundRect(
            ctx,
            -p.eyeW / 2,
            -p.eyeH / 2,
            p.eyeW,
            p.eyeH,
            p.eyeR,
          );
          ctx.fill();
        }, 1 - p.arcA);
        ctx.restore();
      }

      if (p.arcA > 0.01) {
        ctx.save();
        ctx.translate(e.x, ey + p.arcBend * 0.35);
        ctx.scale(1, squash);
        ctx.lineCap = 'round';
        ctx.lineWidth = p.arcThick;
        glow(() => {
          ctx.beginPath();
          ctx.moveTo(-p.arcSpan / 2, 0);
          ctx.quadraticCurveTo(0, -p.arcBend * 2.2, p.arcSpan / 2, 0);
          ctx.stroke();
        }, p.arcA);
        ctx.restore();
      }
    });

    const my = vy + vh * p.mouthY;
    if (p.ovalA < 0.99) {
      ctx.save();
      ctx.lineCap = 'round';
      ctx.lineWidth = p.mouthThick;
      glow(() => {
        ctx.beginPath();
        ctx.moveTo(cx - p.mouthW / 2, my);
        ctx.quadraticCurveTo(cx, my + p.mouthCurve * 2, cx + p.mouthW / 2, my);
        ctx.stroke();
      }, 1 - p.ovalA);
      ctx.restore();
    }
    if (p.ovalA > 0.01) {
      glow(() => {
        ctx.beginPath();
        ctx.ellipse(cx, my, p.ovalW / 2, p.ovalH / 2, 0, 0, Math.PI * 2);
        ctx.fill();
      }, p.ovalA);
    }
  }

  const faceTex = new THREE.CanvasTexture(faceCanvas);
  faceTex.colorSpace = THREE.SRGBColorSpace;
  faceTex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  drawFace(cur, 1);

  const visorMat = new THREE.MeshBasicMaterial({
    map: faceTex,
    transparent: true,
    depthWrite: false,
  });
  let visor = new THREE.Mesh(
    sphericalPatch(
      R * settings.visorRadius,
      settings.visorA,
      settings.visorB,
      80,
      60,
    ),
    visorMat,
  );
  visor.scale.set(1, settings.headScaleY, 1);
  visor.position.y = 0.012;
  robot.add(visor);

  let visorRebuildTimer = 0;
  function scheduleVisorRebuild() {
    window.clearTimeout(visorRebuildTimer);
    visorRebuildTimer = window.setTimeout(() => {
      const next = new THREE.Mesh(
        sphericalPatch(
          R * settings.visorRadius,
          settings.visorA,
          settings.visorB,
          80,
          60,
        ),
        visorMat,
      );
      next.scale.set(1, settings.headScaleY, 1);
      next.position.y = 0.012;
      robot.remove(visor);
      visor.geometry.dispose();
      visor = next;
      robot.add(visor);
    }, 120);
  }

  let blinkStart = -1;
  let queued = 0;
  let nextBlink = performance.now() + 1400;

  function blinkGap() {
    if (current === 'sleepy') return 900 + Math.random() * 1200;
    if (current === 'surprised') return 4000 + Math.random() * 4000;
    return 2200 + Math.random() * 3600;
  }

  function scheduleBlink(now: number) {
    nextBlink = now + blinkGap();
    queued = Math.random() < 0.25 ? 1 : 0;
  }

  function blinkAmount(now: number) {
    if (blinkStart < 0 && now >= nextBlink) blinkStart = now;
    if (blinkStart < 0) return 1;
    const dur = current === 'sleepy' ? 220 : 130;
    const t = (now - blinkStart) / dur;
    if (t >= 1) {
      blinkStart = -1;
      if (queued > 0) {
        queued -= 1;
        nextBlink = now + 170;
      } else scheduleBlink(now);
      return 1;
    }
    return 1 - Math.sin(t * Math.PI);
  }

  function setMood(id: RobotMoodId) {
    if (!ROBOT_MOODS[id]) return;
    current = id;
    target = { ...ROBOT_MOODS[id].p };
    nextBlink = performance.now() + 900;
    blinkStart = -1;
  }

  const pointer = { x: 0, y: 0 };
  const start = performance.now();
  let lastOpen = 1;
  let raf = 0;
  let disposed = false;

  function resize() {
    const w = container.clientWidth || 1;
    const h = container.clientHeight || 1;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  const ro = new ResizeObserver(resize);
  ro.observe(container);
  resize();

  function frame(now: number) {
    if (disposed) return;
    raf = requestAnimationFrame(frame);

    let moving = false;
    for (let i = 0; i < FACE_KEYS.length; i++) {
      const k = FACE_KEYS[i];
      const d = target[k] - cur[k];
      if (Math.abs(d) > 0.0005) {
        cur[k] += d * 0.14;
        moving = true;
      } else cur[k] = target[k];
    }

    const open = blinkAmount(now);
    if (faceDirty || moving || Math.abs(open - lastOpen) > 0.002) {
      drawFace(cur, open);
      faceTex.needsUpdate = true;
      lastOpen = open;
      faceDirty = false;
    }

    const t = (now - start) / 1000;
    const motion = settings.motion;
    const ry =
      pointer.x * settings.followX +
      (motion ? Math.sin(t * 0.5) * settings.idleYaw : 0);
    const rx =
      pointer.y * settings.followY +
      (motion ? Math.sin(t * 0.7 + 1) * settings.idlePitch : 0);
    robot.rotation.y += (ry - robot.rotation.y) * 0.06;
    robot.rotation.x += (rx - robot.rotation.x) * 0.06;
    robot.position.y = motion ? Math.sin(t * 0.9) * settings.idleBob : 0;

    renderer.render(scene, camera);
  }
  raf = requestAnimationFrame(frame);

  return {
    settings,
    setMood,
    getMood: () => current,
    scheduleShellRebuild,
    scheduleVisorRebuild,
    markFaceDirty: () => {
      faceDirty = true;
    },
    applyMaterial: () => {
      shellMat.color.set(settings.shellColor);
      shellMat.roughness = settings.roughness;
      shellMat.metalness = settings.metalness;
    },
    applyLights: () => {
      hemi.intensity = settings.hemi;
      keyLight.intensity = settings.key;
      fillLight.intensity = settings.fill;
      rimLight.intensity = settings.rim;
    },
    applyCamera: () => {
      camera.position.z = settings.camZ;
      camera.fov = settings.camFov;
      camera.updateProjectionMatrix();
    },
    applyHeadScale: () => {
      head.scale.set(1, settings.headScaleY, 1);
      visor.scale.set(1, settings.headScaleY, 1);
    },
    setPointer: (x, y) => {
      pointer.x = x;
      pointer.y = y;
    },
    dispose: () => {
      disposed = true;
      cancelAnimationFrame(raf);
      window.clearTimeout(shellRebuildTimer);
      window.clearTimeout(visorRebuildTimer);
      ro.disconnect();
      head.geometry.dispose();
      visor.geometry.dispose();
      shellMat.dispose();
      visorMat.dispose();
      faceTex.dispose();
      renderer.dispose();
      if (renderer.domElement.parentNode === container) {
        container.removeChild(renderer.domElement);
      }
    },
  };
}
