# Yoink

Grab any element — or a whole page — from the browser and rebuild it as **native,
editable Figma layers**. A self-contained replacement for the html.to.design
round-trip: no cloud, no account, clipboard is the only bridge.

Two halves:

- **`/` (Chrome extension)** — point at an element (or grab the page), serialize
  it to a Figma layer tree, copy that JSON to the clipboard.
- **`/figma-plugin` (Figma plugin)** — paste the JSON; it builds the frames,
  rectangles, text (with matched fonts), images (by URL), and inline SVG as real
  Figma nodes.

The DOM → layer-tree conversion is powered by the MIT-licensed
[`@builder.io/html-to-figma`](https://github.com/BuilderIO/figma-html) engine.
Layout is reconstructed with absolute positioning + Figma constraints (the engine
does not emit auto-layout).

## Usage

1. Click the Yoink toolbar icon → **Pick an element** (or **Yoink whole page**).
2. Click the element you want. The capture lands on your clipboard.
3. In Figma, run the **Yoink** plugin → **Paste** (or ⌘/Ctrl+V into the box) →
   **Build in Figma**.

### Options (extension popup)

- **Nest in frames** — rebuild the DOM hierarchy as nested frames (vs. a flat
  layer list).
- **Include images** — bring `<img>` / background images in as image fills.

## Install the Chrome extension

```bash
pnpm install
pnpm build      # typecheck + minified build + dist/build.zip
```

Then `chrome://extensions` → enable Developer mode → **Load unpacked** → select
`build/`.

## Install the Figma plugin

The plugin must be loaded in the **Figma desktop app** (browser Figma can't
dev-load plugins).

```bash
cd figma-plugin
pnpm install
pnpm build      # typecheck + bundle -> figma-plugin/build/
```

In Figma desktop: **menu → Plugins → Development → Import plugin from manifest…**
and pick `figma-plugin/manifest.json` (the root one — it points at `build/`). Run
it any time via **Plugins → Development → Yoink**.

## Develop

```bash
pnpm watch                 # extension: rebuild on change
cd figma-plugin && pnpm watch   # plugin: rebuild on change
```

## Architecture

- `src/contentScript.ts` — runs `htmlToFigma` on the picked element, copies the
  `{ __yoink, source, layers }` payload to the clipboard.
- `src/picker.ts` — on-page element picker overlay + toast.
- `src/popup.ts` / `public/popup.html` — toolbar UI and options.
- `figma-plugin/src/code.ts` — consumes the payload: creates nodes per layer,
  `assign`s matching props, loads/maps fonts, resolves image URLs via
  `figma.createImageAsync`, imports inline SVG via `figma.createNodeFromSvg`.
- `figma-plugin/src/ui.html` — paste-and-build UI.
