# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

OpenScreen is an Electron + React + TypeScript desktop app for recording the screen and editing the recording into a polished demo video. The core value props (zooms, motion blur, annotations, GIF/MP4 export) all run in the renderer; the Electron main process is mostly window management, OS-level capture permissions, IPC, and disk I/O.

Node version is pinned to `22.22.1` and npm to `10.9.4` (see `engines` in `package.json` and `.nvmrc`).

## Common commands

```bash
npm run dev               # Vite dev server + Electron main process (vite-plugin-electron)
npm run build             # tsc + vite build + electron-builder for current platform
npm run build:win         # Windows build (skips npm rebuild)
npm run build:mac
npm run build:linux       # AppImage + deb + pacman

npm run lint              # Biome check (uses tab indentation, double quotes, lineWidth 100)
npm run lint:fix          # Biome auto-fix
npm run format            # Biome format only
npm run i18n:check        # Verify all locales have the same key structure as en

npm run test              # Vitest unit tests (jsdom)
npm run test:watch
npm run test:browser:install   # One-time: install Chromium for browser tests
npm run test:browser           # Vitest in real Chromium (Playwright provider)
npm run test:e2e               # Playwright e2e suite

# Run a single test
npx vitest run path/to/file.test.ts
npx vitest run -t "test name pattern"
npx vitest --config vitest.browser.config.ts run path/to/file.browser.test.ts
```

CI (`.github/workflows/ci.yml`) runs `lint`, `tsc --noEmit`, both vitest configs, and `vite build`. A husky pre-commit hook runs `biome check` via lint-staged on staged files.

## Test layout

Two vitest configs targeting disjoint file patterns:

- `vitest.config.ts` — jsdom, picks up `src/**/*.test.ts(x)` **except** `*.browser.test.ts`. Use for pure logic, hooks without real browser APIs, i18n key coverage.
- `vitest.browser.config.ts` — real headless Chromium via `@vitest/browser-playwright`, picks up `src/**/*.browser.test.ts(x)`. Use when the code under test needs `VideoDecoder`/`VideoEncoder`/`MediaRecorder`/`OffscreenCanvas`/WebGL/Pixi.js. Software WebGL (`swiftshader`) is enabled so Pixi works without a GPU.

Test fixtures (sample videos) live in `tests/fixtures/` — import them with Vite's `?url` suffix from browser tests. Playwright e2e specs live in `tests/e2e/`.

See `docs/tests/writing-tests.md` for examples and the "which type to use" matrix.

## Architecture

### Process boundary

- **Main process** — `electron/main.ts` orchestrates app lifecycle, tray icon, application menu (i18n-aware), and macOS-specific permission prompts (microphone, screen recording). Owns the recordings directory: `app.getPath("userData")/recordings`.
- **Preload** — `electron/preload.ts` exposes `window.electronAPI` via `contextBridge`. Sandboxed: it cannot import `node:path` or `node:url`, so the asset base URL (for packaged-vs-unpackaged wallpaper resolution) is passed via `webPreferences.additionalArguments` from `electron/windows.ts`.
- **IPC handlers** — `electron/ipc/handlers.ts` is the surface for all renderer→main file I/O, source enumeration, dialogs, and project save/load. Reads are gated by an allowlist (`approvedPaths` + `RECORDINGS_DIR`) — when adding a handler that touches user files, route paths through `isPathAllowed` and add file-picker results via `approveFilePath`.
- **Renderer** — `src/` is a single Vite/React SPA. The window mode is selected by the `?windowType=…` query param in `src/App.tsx` (`hud-overlay`, `source-selector`, `countdown-overlay`, `editor`). Each Electron window navigates to `index.html` with a different query param rather than loading separate HTML files.

### Renderer subsystems

- **Recording (`src/hooks/useScreenRecorder.ts`)** — wraps `MediaRecorder` over a desktopCapturer stream. Emits WebM via the `chromeMediaSource: "desktop"` constraint, then patches duration with `@fix-webm-duration/fix`. Bitrate/resolution targets are tiered (4K → QHD → 1080p) based on the source's native size.
- **Editor state (`src/hooks/useEditorHistory.ts`)** — undoable editor state (zooms, trims, speeds, annotations, crop, wallpaper, blur, etc.) lives in a single `EditorState` object behind an undo/redo history hook. Selection IDs are intentionally **not** undoable. `INITIAL_EDITOR_STATE` is the source of truth for defaults.
- **Video editor shell (`src/components/video-editor/VideoEditor.tsx`)** — the master component. Composes timeline, playback canvas, settings panel, and export dialog. Loads/saves `.openscreen` project JSON via `projectPersistence.ts` and IPC.
- **Playback / Pixi rendering (`src/components/video-editor/videoPlayback/`)** — re-exported through `videoPlayback/index.ts`. Splits per concern: `zoomTransform`, `zoomRegionUtils`, `cursorFollowUtils`, `cursorHighlight`, `focusUtils`, `layoutUtils`, `mathUtils`, `overlayUtils`, `videoEventHandlers`. The same math is used at preview time and at export time so the visual matches.
- **Timeline (`src/components/video-editor/timeline/`)** — built on `dnd-timeline`. Rows/Subrows hold zoom/trim/speed/annotation/blur regions.
- **Exporter (`src/lib/exporter/`)** — the heavy pipeline. `videoExporter.ts` (MP4) and `gifExporter.ts` (GIF) are the entry points; underneath: `streamingDecoder` (WebCodecs `VideoDecoder` over mp4box/web-demuxer), `frameRenderer` (Pixi composition matching preview), `annotationRenderer`, `audioEncoder`, `muxer` (mediabunny), `threeDPass`, `gradientParser`. Browser tests live alongside (`*.browser.test.ts`) because the full pipeline needs WebCodecs.
- **Project persistence** — `src/components/video-editor/projectPersistence.ts` handles `.openscreen` JSON: validation, normalization (clamping invalid values), media path resolution via `file://` URLs. `src/lib/recordingSession.ts` is the canonical media descriptor (screen + optional webcam + cursor telemetry) shared between main and renderer.
- **Cursor telemetry** — `uiohook-napi` (macOS-only at runtime; rebuild is gated in `scripts/rebuild-native.mjs`) feeds raw mouse events into `src/lib/cursorTelemetryBuffer.ts` via IPC. Used for cursor-follow zoom and click-driven zoom suggestions.
- **i18n** — `src/i18n/` and `src/contexts/I18nContext.tsx`. Locales live in `src/i18n/locales/<locale>/<namespace>.json`. The English files are the schema baseline — `npm run i18n:check` enforces that every other locale has identical key structure. The Electron menu has its own translation function (`mainT` in `electron/i18n.ts`) because it's built in the main process before the renderer mounts.
- **Wallpapers** — bundled in `public/wallpapers/`. `electron-builder.json5` copies them to `resources/wallpapers/` in the packaged app. The renderer resolves them through `assetBaseUrl` exposed by preload — never hardcode `/wallpapers/...` URLs.

### Conventions

- **Path alias**: `@/` maps to `src/` (configured in `vite.config.ts`, `vitest.config.ts`, `vitest.browser.config.ts`, `tsconfig.json`).
- **UI**: shadcn/ui (style: `new-york`, base color: `stone`) under `src/components/ui/`. Icons from `lucide-react`. See `components.json` for aliases.
- **Formatting**: Biome enforces tabs, double quotes, lineWidth 100, LF endings. Don't fight it — let `npm run lint:fix` reformat.
- **Native modules**: `uiohook-napi` and any other `.node` files must stay in `asarUnpack` (already configured in `electron-builder.json5`); they cannot be `dlopen`'d from inside an asar.
- **Window types**: when adding a new window mode, branch in `src/App.tsx` on `windowType`, add a creator in `electron/windows.ts`, and consider transparent-background handling in App's `useEffect` (currently special-cases `hud-overlay`, `source-selector`, `countdown-overlay`).
