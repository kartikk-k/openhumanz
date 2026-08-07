# Electron React Template

A desktop app template built on [Electron React Boilerplate](https://github.com/electron-react-boilerplate/electron-react-boilerplate), preconfigured with:

- **Electron** (main + preload + renderer processes)
- **React 19** with React Router (`MemoryRouter`) and Fast Refresh
- **TypeScript 5**
- **Tailwind CSS v3** via PostCSS
- **webpack 5** for dev server and production bundles
- **electron-builder** for packaging and publishing
- **Jest** + Testing Library, **ESLint** + Prettier
- **Zustand** for state, `clsx` / `tailwind-merge` / `class-variance-authority` for styling helpers

Package manager: **bun**.

---

## Requirements

- **Node.js** 20+ (CI uses 22) — Electron, webpack and the build scripts run on Node
- **bun** — used for installing dependencies and running scripts

---

## Getting started

```bash
bun install          # installs deps; postinstall installs release/app deps and builds the renderer DLL
bun run start        # dev mode: webpack dev server + Electron with hot reload
```

Other scripts:

```bash
bun run package      # build production bundles and create distributables in release/build
bun run build        # production main + renderer bundles only (no installer)
bun run lint         # ESLint over .js/.jsx/.ts/.tsx
bun run lint:fix     # ESLint with --fix
bun run test         # Jest
bun run rebuild      # rebuild native deps against the Electron ABI
```

> Use `bun run test`, not `bun test` — the latter invokes bun's own test runner instead of Jest.
> Jest's setup step (`.erb/scripts/check-build-exists.ts`) requires a prior `bun run build`, and Jest
> needs Node on `PATH` (Bun's own runtime cannot execute it). A smoke test lives in `src/__tests__/`.

---

## Project structure

```
.
├── src
│   ├── main                 # Electron main process
│   │   ├── main.ts          # app lifecycle, BrowserWindow, IPC handlers
│   │   ├── preload.ts       # context bridge -> window.electron
│   │   └── util.ts
│   └── renderer             # React app
│       ├── index.tsx        # React entry point
│       ├── index.ejs        # HTML template (app <title> lives here)
│       ├── App.tsx          # router + routes
│       ├── App.css          # Tailwind directives + global styles
│       ├── components/      # UI components (components/shared for reusables)
│       ├── hooks/           # custom React hooks
│       ├── store/           # Zustand stores
│       ├── lib/             # utilities (e.g. cn())
│       └── constants/       # shared constants
├── .erb
│   ├── configs/             # webpack configs (base, main, preload, renderer dev/prod, dll)
│   ├── scripts/             # build helpers (clean, notarize, electron-rebuild, ...)
│   └── mocks/               # Jest file mocks
├── assets                   # app icons, entitlements.mac.plist, assets.d.ts
├── release
│   ├── app/package.json     # the packaged app's own manifest (native deps go here)
│   └── build/               # electron-builder output
├── tailwind.config.js
├── postcss.config.js
└── package.json
```

Dependencies used by the **renderer** go in the root `package.json`; **native** modules that must ship with the packaged app go in `release/app/package.json`.

---

## Tailwind CSS

Tailwind is wired through PostCSS, not a separate build step:

1. `tailwind.config.js` scans `./src/**/*.{js,jsx,ts,tsx}` and `./src/renderer/index.ejs`, with `darkMode: 'media'` (switch to `'class'` if you add a manual theme toggle).
2. `postcss.config.js` registers the `tailwindcss` and `autoprefixer` plugins.
3. `src/renderer/App.css` contains the `@tailwind base/components/utilities` directives and is imported by `App.tsx`.
4. `postcss-loader` runs in the CSS/SCSS rules of `.erb/configs/webpack.config.renderer.dev.ts` and `webpack.config.renderer.prod.ts`.

Add custom theme values under `theme.extend` in `tailwind.config.js`.

---

## IPC

`src/main/preload.ts` uses `contextBridge` to expose `window.electron`:

- `window.electron.ipcRenderer.sendMessage / on / once / invoke`
- `window.electron.platform`, `window.electron.homeDir`

Types live in `src/renderer/preload.d.ts`. The `ipc-example` channel is a round-trip demo: `src/main/main.ts` registers `ipcMain.on('ipc-example', ...)` and replies with `pong`, so from the renderer:

```ts
window.electron.ipcRenderer.once('ipc-example', (arg) => console.log(arg));
window.electron.ipcRenderer.sendMessage('ipc-example', 'ping');
```

Add new channel names to the `Channels` union in `preload.ts`.

---

## Renaming for your project

Change these, then delete `release/build` and reinstall:

| Where | Field |
| --- | --- |
| `package.json` | `name`, `description`, `homepage`, `repository`, `author` |
| `package.json` → `build` | `productName`, `appId` |
| `package.json` → `build.publish` | `owner`, `repo` |
| `package.json` → `build.mac` | `identity`, `notarize.teamId` |
| `release/app/package.json` | `name`, `description`, `author` |
| `src/renderer/index.ejs` | `<title>` |
| `assets/` | `icon.svg`, `icon.png`, `icon.ico`, `icon.icns` |

---

## macOS signing and notarization

- Signing identity and team ID come from `build.mac.identity` and `build.mac.notarize.teamId` in `package.json`.
- `build.afterSign` runs `.erb/scripts/notarize.js`, which calls `notarytool` with the keychain profile **`notarization-profile`**. Create it once locally:

```bash
xcrun notarytool store-credentials notarization-profile \
  --apple-id "you@example.com" \
  --team-id "YOURTEAMID" \
  --password "app-specific-password"
```

- Notarization is skipped automatically on non-darwin platforms and when `build.mac.notarize` is absent.

---

## CI

- `.github/workflows/test.yml` — on push/PR: install with bun on macOS/Windows/Linux, then `package`, `lint`, `tsc --noEmit`, `test`.
- `.github/workflows/publish.yml` — on `v*` tags or manual dispatch: build and publish installers to a GitHub release via electron-builder.
- `.github/workflows/codeql-analysis.yml` — CodeQL scan of JS/TS on push, PR and a weekly schedule.

---

## Credits

Based on [Electron React Boilerplate](https://github.com/electron-react-boilerplate/electron-react-boilerplate).

Licensed under the [MIT License](https://opensource.org/licenses/MIT).
