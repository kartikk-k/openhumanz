import { useEffect, useRef, useState } from 'react';
import {
  createRobotHead,
  ROBOT_MOOD_ORDER,
  ROBOT_MOODS,
  type RobotHeadHandle,
  type RobotHeadSettings,
  type RobotMoodId,
} from './createRobotHead';

type RangeDef = {
  key: keyof RobotHeadSettings;
  label: string;
  min: number;
  max: number;
  step: number;
  onChange: (h: RobotHeadHandle) => void;
};

const RANGE_SECTIONS: { title: string; rows: RangeDef[] }[] = [
  {
    title: 'Shape · ears',
    rows: [
      {
        key: 'earX',
        label: 'Ear X',
        min: 0.7,
        max: 1.2,
        step: 0.01,
        onChange: (h) => h.scheduleShellRebuild(),
      },
      {
        key: 'earY',
        label: 'Ear Y',
        min: -0.3,
        max: 0.3,
        step: 0.01,
        onChange: (h) => h.scheduleShellRebuild(),
      },
      {
        key: 'earZ',
        label: 'Ear Z',
        min: -0.2,
        max: 0.3,
        step: 0.01,
        onChange: (h) => h.scheduleShellRebuild(),
      },
      {
        key: 'earRx',
        label: 'Ear radius X',
        min: 0.05,
        max: 0.4,
        step: 0.005,
        onChange: (h) => h.scheduleShellRebuild(),
      },
      {
        key: 'earRy',
        label: 'Ear radius Y',
        min: 0.05,
        max: 0.5,
        step: 0.005,
        onChange: (h) => h.scheduleShellRebuild(),
      },
      {
        key: 'earRz',
        label: 'Ear radius Z',
        min: 0.05,
        max: 0.4,
        step: 0.005,
        onChange: (h) => h.scheduleShellRebuild(),
      },
      {
        key: 'earBlend',
        label: 'Ear blend',
        min: 0.02,
        max: 0.4,
        step: 0.005,
        onChange: (h) => h.scheduleShellRebuild(),
      },
    ],
  },
  {
    title: 'Shape · crown',
    rows: [
      {
        key: 'topX',
        label: 'Crown X',
        min: -0.3,
        max: 0.3,
        step: 0.01,
        onChange: (h) => h.scheduleShellRebuild(),
      },
      {
        key: 'topY',
        label: 'Crown Y',
        min: 0.7,
        max: 1.2,
        step: 0.01,
        onChange: (h) => h.scheduleShellRebuild(),
      },
      {
        key: 'topZ',
        label: 'Crown Z',
        min: -0.2,
        max: 0.3,
        step: 0.01,
        onChange: (h) => h.scheduleShellRebuild(),
      },
      {
        key: 'topRx',
        label: 'Crown radius X',
        min: 0.05,
        max: 0.5,
        step: 0.005,
        onChange: (h) => h.scheduleShellRebuild(),
      },
      {
        key: 'topRy',
        label: 'Crown radius Y',
        min: 0.05,
        max: 0.4,
        step: 0.005,
        onChange: (h) => h.scheduleShellRebuild(),
      },
      {
        key: 'topRz',
        label: 'Crown radius Z',
        min: 0.05,
        max: 0.4,
        step: 0.005,
        onChange: (h) => h.scheduleShellRebuild(),
      },
      {
        key: 'topBlend',
        label: 'Crown blend',
        min: 0.02,
        max: 0.4,
        step: 0.005,
        onChange: (h) => h.scheduleShellRebuild(),
      },
      {
        key: 'headScaleY',
        label: 'Head squash Y',
        min: 0.85,
        max: 1.1,
        step: 0.005,
        onChange: (h) => h.applyHeadScale(),
      },
    ],
  },
  {
    title: 'Material',
    rows: [
      {
        key: 'roughness',
        label: 'Roughness',
        min: 0,
        max: 1,
        step: 0.01,
        onChange: (h) => h.applyMaterial(),
      },
      {
        key: 'metalness',
        label: 'Metalness',
        min: 0,
        max: 1,
        step: 0.01,
        onChange: (h) => h.applyMaterial(),
      },
    ],
  },
  {
    title: 'Face · glow',
    rows: [
      {
        key: 'bezelWidth',
        label: 'Bezel width',
        min: 10,
        max: 120,
        step: 1,
        onChange: (h) => h.markFaceDirty(),
      },
      {
        key: 'bezelBlur',
        label: 'Bezel blur',
        min: 0,
        max: 80,
        step: 1,
        onChange: (h) => h.markFaceDirty(),
      },
      {
        key: 'glowSoft',
        label: 'Feature glow soft',
        min: 0,
        max: 80,
        step: 1,
        onChange: (h) => h.markFaceDirty(),
      },
      {
        key: 'glowCrisp',
        label: 'Feature glow crisp',
        min: 0,
        max: 40,
        step: 1,
        onChange: (h) => h.markFaceDirty(),
      },
    ],
  },
  {
    title: 'Visor mesh',
    rows: [
      {
        key: 'visorRadius',
        label: 'Visor radius',
        min: 1.0,
        max: 1.08,
        step: 0.001,
        onChange: (h) => h.scheduleVisorRebuild(),
      },
      {
        key: 'visorA',
        label: 'Visor width',
        min: 0.4,
        max: 0.9,
        step: 0.005,
        onChange: (h) => h.scheduleVisorRebuild(),
      },
      {
        key: 'visorB',
        label: 'Visor height',
        min: 0.3,
        max: 0.7,
        step: 0.005,
        onChange: (h) => h.scheduleVisorRebuild(),
      },
    ],
  },
  {
    title: 'Lights',
    rows: [
      {
        key: 'hemi',
        label: 'Hemisphere',
        min: 0,
        max: 2,
        step: 0.01,
        onChange: (h) => h.applyLights(),
      },
      {
        key: 'key',
        label: 'Key',
        min: 0,
        max: 2,
        step: 0.01,
        onChange: (h) => h.applyLights(),
      },
      {
        key: 'fill',
        label: 'Fill',
        min: 0,
        max: 2,
        step: 0.01,
        onChange: (h) => h.applyLights(),
      },
      {
        key: 'rim',
        label: 'Rim',
        min: 0,
        max: 2,
        step: 0.01,
        onChange: (h) => h.applyLights(),
      },
    ],
  },
  {
    title: 'Camera · motion',
    rows: [
      {
        key: 'camZ',
        label: 'Camera Z',
        min: 3,
        max: 12,
        step: 0.1,
        onChange: (h) => h.applyCamera(),
      },
      {
        key: 'camFov',
        label: 'Camera FOV',
        min: 18,
        max: 60,
        step: 1,
        onChange: (h) => h.applyCamera(),
      },
      {
        key: 'followX',
        label: 'Follow X',
        min: 0,
        max: 0.8,
        step: 0.01,
        onChange: () => {},
      },
      {
        key: 'followY',
        label: 'Follow Y',
        min: 0,
        max: 0.6,
        step: 0.01,
        onChange: () => {},
      },
      {
        key: 'idleYaw',
        label: 'Idle yaw',
        min: 0,
        max: 0.2,
        step: 0.005,
        onChange: () => {},
      },
      {
        key: 'idlePitch',
        label: 'Idle pitch',
        min: 0,
        max: 0.15,
        step: 0.005,
        onChange: () => {},
      },
      {
        key: 'idleBob',
        label: 'Idle bob',
        min: 0,
        max: 0.1,
        step: 0.005,
        onChange: () => {},
      },
    ],
  },
];

function fmt(v: number, step: number) {
  if (step >= 1) return String(Math.round(v));
  const places = Math.max(0, Math.round(-Math.log10(step)));
  return Number(v).toFixed(places);
}

type Props = {
  className?: string;
  /** Show mood pills under the canvas. Default true. */
  showMoods?: boolean;
};

/**
 * Interactive 3D robot head (Three.js). ⌘. / Ctrl+. toggles the settings panel.
 */
export function RobotHead({ className, showMoods = true }: Props) {
  const stageRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<RobotHeadHandle | null>(null);
  const [mood, setMood] = useState<RobotMoodId>('neutral');
  const [panelOpen, setPanelOpen] = useState(false);
  const [settings, setSettings] = useState<RobotHeadSettings | null>(null);

  useEffect(() => {
    const el = stageRef.current;
    if (!el) return undefined;

    const handle = createRobotHead(el);
    handleRef.current = handle;
    setSettings({ ...handle.settings });

    const onKey = (e: KeyboardEvent) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(
        (e.target as HTMLElement | null)?.tagName || '',
      );
      if ((e.metaKey || e.ctrlKey) && e.key === '.') {
        e.preventDefault();
        setPanelOpen((v) => !v);
        return;
      }
      if (typing) return;
      const n = parseInt(e.key, 10);
      if (n >= 1 && n <= ROBOT_MOOD_ORDER.length) {
        const id = ROBOT_MOOD_ORDER[n - 1];
        handle.setMood(id);
        setMood(id);
      }
    };

    window.addEventListener('keydown', onKey);

    const onPointerMove = (e: PointerEvent) => {
      handle.setPointer(
        (e.clientX / window.innerWidth) * 2 - 1,
        (e.clientY / window.innerHeight) * 2 - 1,
      );
    };
    window.addEventListener('pointermove', onPointerMove);

    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointermove', onPointerMove);
      handle.dispose();
      handleRef.current = null;
    };
  }, []);

  const patchSetting = <K extends keyof RobotHeadSettings>(
    key: K,
    value: RobotHeadSettings[K],
    apply: (h: RobotHeadHandle) => void,
  ) => {
    const handle = handleRef.current;
    if (!handle) return;
    handle.settings[key] = value;
    apply(handle);
    setSettings({ ...handle.settings });
  };

  const pickMood = (id: RobotMoodId) => {
    handleRef.current?.setMood(id);
    setMood(id);
  };

  return (
    <div className={className}>
      <div
        ref={stageRef}
        className="relative aspect-square w-full max-w-[280px] overflow-hidden"
      />

      {showMoods && (
        <div
          className="mt-3 hidden flex max-w-[min(100vw-2rem,420px)] gap-1.5 overflow-x-auto rounded-full border border-zinc-200/80 bg-white/70 p-1.5 backdrop-blur dark:border-zinc-700/60 dark:bg-zinc-900/70"
          role="group"
          aria-label="Expression"
        >
          {ROBOT_MOOD_ORDER.map((id) => (
            <button
              key={id}
              type="button"
              aria-pressed={mood === id}
              onClick={() => pickMood(id)}
              className={
                mood === id
                  ? 'shrink-0 rounded-full bg-zinc-900 px-3 py-1.5 text-[10px] font-medium uppercase tracking-[0.09em] text-white dark:bg-zinc-100 dark:text-zinc-900'
                  : 'shrink-0 rounded-full px-3 py-1.5 text-[10px] font-medium uppercase tracking-[0.09em] text-zinc-500 transition hover:bg-zinc-100 hover:text-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100'
              }
            >
              {ROBOT_MOODS[id].label}
            </button>
          ))}
        </div>
      )}

      {panelOpen && settings && (
        <aside
          className="fixed right-4 top-4 z-30 max-h-[calc(100vh-2rem)] w-[300px] overflow-auto rounded-2xl border border-zinc-200/80 bg-white/90 p-3.5 shadow-xl backdrop-blur-md dark:border-zinc-700/60 dark:bg-zinc-950/90"
          aria-label="Settings"
        >
          <h2 className="mb-2.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-zinc-900 dark:text-zinc-100">
            Controls
          </h2>

          <label
            htmlFor="robot-shell-color"
            className="mb-2 flex items-center justify-between gap-2 text-[12px] text-zinc-600 dark:text-zinc-400"
          >
            <span>Shell color</span>
            <input
              id="robot-shell-color"
              type="color"
              value={settings.shellColor}
              onChange={(e) =>
                patchSetting('shellColor', e.target.value, (h) =>
                  h.applyMaterial(),
                )
              }
              className="h-7 w-24 cursor-pointer rounded border border-zinc-200 bg-white p-0.5 dark:border-zinc-700"
            />
          </label>

          {RANGE_SECTIONS.map((section) => (
            <div key={section.title}>
              <div className="mb-2 mt-3.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-zinc-400">
                {section.title}
              </div>
              {section.rows.map((row) => {
                const value = settings[row.key] as number;
                return (
                  <div key={row.key} className="mb-2">
                    <div className="mb-0.5 flex items-center justify-between gap-2 text-[12px]">
                      <span className="text-zinc-600 dark:text-zinc-400">
                        {row.label}
                      </span>
                      <span className="min-w-[42px] text-right font-mono text-[11px] tabular-nums text-zinc-400">
                        {fmt(value, row.step)}
                      </span>
                    </div>
                    <input
                      type="range"
                      min={row.min}
                      max={row.max}
                      step={row.step}
                      value={value}
                      onChange={(e) =>
                        patchSetting(
                          row.key,
                          Number(
                            e.target.value,
                          ) as RobotHeadSettings[typeof row.key],
                          row.onChange,
                        )
                      }
                      className="w-full accent-zinc-900 dark:accent-zinc-100"
                    />
                  </div>
                );
              })}
            </div>
          ))}

          <label
            htmlFor="robot-idle-motion"
            className="mt-2 flex items-center gap-2 text-[12px] text-zinc-600 dark:text-zinc-400"
          >
            <input
              id="robot-idle-motion"
              type="checkbox"
              checked={settings.motion}
              onChange={(e) =>
                patchSetting('motion', e.target.checked, () => {})
              }
              className="accent-zinc-900 dark:accent-zinc-100"
            />
            Idle motion
          </label>

          <p className="mt-3 border-t border-zinc-200 pt-2.5 text-[10px] uppercase tracking-[0.06em] text-zinc-400 dark:border-zinc-800">
            Toggle with ⌘.
          </p>
        </aside>
      )}
    </div>
  );
}

export default RobotHead;
