import { htmlToFigma } from '@builder.io/html-to-figma';
import { resolveOptions } from './constants';
import { parseGradientFill } from './gradients';
import type { GradientPaint } from './gradients';
import { showToast, startPicker } from './picker';
import { PAYLOAD_TAG } from './types';
import type { CaptureOptions, PopupMessage, StoredState } from './types';

interface Layer {
  type?: string;
  name?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  opacity?: number;
  fontSize?: number;
  fontWeight?: number;
  fontStyle?: string;
  characters?: string;
  fills?: Array<{ type?: string }>;
  children?: Layer[];
}

const geoKey = (x: number, y: number, w: number, h: number): string =>
  `${Math.round(x)}:${Math.round(y)}:${Math.round(w)}:${Math.round(h)}`;

// Opacity at or above this is treated as deliberate translucency; anything
// below is assumed to be a mid-scroll reveal animation caught before it
// settled, and is read as fully opaque rather than hiding visible content.
const VISIBLE_FLOOR = 0.05;

interface FontStyle {
  weight: number;
  italic: boolean;
}

interface AuxMaps {
  gradients: Map<string, GradientPaint>;
  zIndex: Map<string, number>;
  opacity: Map<string, number>;
  fontStyles: Map<string, FontStyle>;
}

/** Builder's engine captures only fontFamily + fontSize for text, dropping
 * weight and italic — so bold headings and light captions all rebuild as
 * Regular in Figma. Re-read those per text node, keyed by the SAME geometry
 * Builder assigns each TEXT layer (a Range bounding rect, with its line-height
 * adjustment), so the plugin can pick the right family + style.
 *
 * Mirrors Builder's buildTextNode: range over the text node, adjust the rect up
 * to line-height, drop sub-pixel runs. Keys must match exactly or the merge
 * misses, so keep this in lockstep with the engine's text geometry. */
function buildFontStyles(root: Element, into: Map<string, FontStyle>): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    if (!node.textContent || !node.textContent.trim()) continue;
    const parent = node.parentElement;
    if (!parent) continue;
    const style = getComputedStyle(parent);
    const range = document.createRange();
    range.selectNode(node);
    const rect = range.getBoundingClientRect();
    range.detach();
    let top = rect.top;
    let height = rect.height;
    const lineHeight = parseFloat(style.lineHeight); // px, or NaN for "normal"
    if (!Number.isNaN(lineHeight) && height < lineHeight) {
      top -= (lineHeight - height) / 2;
      height = lineHeight;
    }
    if (height < 1 || rect.width < 1) continue;
    const key = geoKey(rect.left, top, rect.width, height);
    if (into.has(key)) continue;
    const weight = parseInt(style.fontWeight, 10);
    into.set(key, {
      weight: Number.isNaN(weight) ? 400 : weight,
      italic: /italic|oblique/.test(style.fontStyle),
    });
  }
}

/** One DOM pass collecting what Builder's engine drops — CSS gradients, stacking
 * order, element opacity, and font weight/style — keyed by absolute geometry. */
function buildAuxMaps(root: Element): AuxMaps {
  const gradients = new Map<string, GradientPaint>();
  const zIndex = new Map<string, number>();
  const opacity = new Map<string, number>();
  const fontStyles = new Map<string, FontStyle>();
  const elements: Element[] = [root, ...Array.from(root.querySelectorAll('*'))];
  for (const el of elements) {
    if (!(el instanceof HTMLElement)) continue;
    const style = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const key = geoKey(r.left, r.top, r.width, r.height);

    const bg = style.backgroundImage;
    if (bg && bg.indexOf('gradient(') !== -1) {
      const paint = parseGradientFill(bg);
      if (paint && !gradients.has(key)) gradients.set(key, paint);
    }

    // Only reorder by an EXPLICIT z-index. Don't bump positioned-auto elements
    // above static ones: a card's absolute background layer is meant to sit
    // *behind* its content, and DOM order (which Builder preserves) already
    // gets the common "background first, content after" case right.
    const raw = parseInt(style.zIndex, 10);
    if (!Number.isNaN(raw) && raw !== 0 && !zIndex.has(key)) {
      zIndex.set(key, raw);
    }

    // Record deliberate translucency (scrims, faded UI) but ignore near-zero
    // values. Scroll-reveal and scroll-linked-fade elements sit at ~0 opacity
    // until on-screen, and a whole-page capture scrolls past them then reads
    // before they settle — so the page's hero/sections read as 0.0–0.05 mid
    // -flight. Emitting that hides content the user plainly sees, so treat
    // anything below VISIBLE_FLOOR as fully opaque.
    const op = parseFloat(style.opacity);
    if (
      !Number.isNaN(op) &&
      op >= VISIBLE_FLOOR &&
      op < 1 &&
      !opacity.has(key)
    ) {
      opacity.set(key, op);
    }
  }
  buildFontStyles(root, fontStyles);
  return { gradients, zIndex, opacity, fontStyles };
}

/** Inject gradient fills into layers whose absolute geometry matches the map.
 * Layer coords are parent-relative (nested) or absolute (flat); accumulate. */
function applyGradients(
  layers: Layer[],
  map: Map<string, GradientPaint>
): void {
  if (map.size === 0) return;
  const walk = (layer: Layer, offsetX: number, offsetY: number): void => {
    const absX = offsetX + (layer.x ?? 0);
    const absY = offsetY + (layer.y ?? 0);
    if (layer.type === 'FRAME' || layer.type === 'RECTANGLE') {
      const paint = map.get(
        geoKey(absX, absY, layer.width ?? 0, layer.height ?? 0)
      );
      if (paint) {
        layer.fills = [...(layer.fills ?? []), paint as { type?: string }];
      }
    }
    if (layer.children) {
      for (const child of layer.children) walk(child, absX, absY);
    }
  };
  for (const layer of layers) walk(layer, 0, 0);
}

/** Builder's engine never sets element opacity, so semi-transparent elements
 * (scrims, faded UI) render fully opaque. Merge captured opacity back in. */
function applyOpacity(layers: Layer[], map: Map<string, number>): void {
  if (map.size === 0) return;
  const walk = (layer: Layer, offsetX: number, offsetY: number): void => {
    const absX = offsetX + (layer.x ?? 0);
    const absY = offsetY + (layer.y ?? 0);
    const op = map.get(geoKey(absX, absY, layer.width ?? 0, layer.height ?? 0));
    if (op !== undefined) layer.opacity = op;
    if (layer.children) {
      for (const child of layer.children) walk(child, absX, absY);
    }
  };
  for (const layer of layers) walk(layer, 0, 0);
}

/** Merge captured font weight/italic back onto TEXT layers by absolute geometry
 * (same keying as applyOpacity). The plugin maps these to a Figma font style. */
function applyFontStyles(layers: Layer[], map: Map<string, FontStyle>): void {
  if (map.size === 0) return;
  const walk = (layer: Layer, offsetX: number, offsetY: number): void => {
    const absX = offsetX + (layer.x ?? 0);
    const absY = offsetY + (layer.y ?? 0);
    if (layer.type === 'TEXT') {
      const info = map.get(
        geoKey(absX, absY, layer.width ?? 0, layer.height ?? 0)
      );
      if (info) {
        layer.fontWeight = info.weight;
        if (info.italic) layer.fontStyle = 'italic';
      }
    }
    if (layer.children) {
      for (const child of layer.children) walk(child, absX, absY);
    }
  };
  for (const layer of layers) walk(layer, 0, 0);
}

/** Figma paints children in array order; Builder emits DOM order and ignores
 * z-index, so lower content ends up covering higher. Reorder siblings by
 * effective stacking (stable: equal z keeps DOM order). */
function reorderByZIndex(layers: Layer[], zMap: Map<string, number>): void {
  if (zMap.size === 0) return;
  const sorted = (children: Layer[], offX: number, offY: number): Layer[] => {
    const z = (c: Layer): number =>
      zMap.get(
        geoKey(
          offX + (c.x ?? 0),
          offY + (c.y ?? 0),
          c.width ?? 0,
          c.height ?? 0
        )
      ) ?? 0;
    return children
      .map((c, i) => ({ c, i, z: z(c) }))
      .sort((a, b) => a.z - b.z || a.i - b.i)
      .map((o) => o.c);
  };
  const walk = (layer: Layer, offX: number, offY: number): void => {
    const absX = offX + (layer.x ?? 0);
    const absY = offY + (layer.y ?? 0);
    if (layer.children && layer.children.length > 1) {
      layer.children = sorted(layer.children, absX, absY);
    }
    if (layer.children) for (const c of layer.children) walk(c, absX, absY);
  };
  for (const layer of layers) walk(layer, 0, 0);

  // Flat mode keeps siblings in the top-level array (the root stays first).
  if (layers.length > 2) {
    const [root, ...rest] = layers;
    const ordered = sorted(rest, 0, 0);
    layers.length = 0;
    layers.push(root, ...ordered);
  }
}

/** Builder splits styled text into separate runs and trims their whitespace, so
 * adjacent runs on a line collide ("Grow"+"your money"). Nudge a run right by
 * roughly one space when it butts against the previous run on the same line. */
function addRunSpacing(layers: Layer[]): void {
  const fixLine = (children: Layer[]): void => {
    const texts = children
      .filter((c) => c.type === 'TEXT' && typeof c.characters === 'string')
      .slice()
      .sort((a, b) => (a.y ?? 0) - (b.y ?? 0) || (a.x ?? 0) - (b.x ?? 0));

    let shift = 0;
    for (let i = 1; i < texts.length; i += 1) {
      const prev = texts[i - 1];
      const cur = texts[i];
      const ph = prev.height ?? 0;
      const ch = cur.height ?? 0;
      const sameLine =
        Math.abs((prev.y ?? 0) - (cur.y ?? 0)) < Math.min(ph, ch) * 0.6;
      if (!sameLine) {
        shift = 0;
        continue;
      }
      cur.x = (cur.x ?? 0) + shift;
      const gap = (cur.x ?? 0) - ((prev.x ?? 0) + (prev.width ?? 0));
      if (gap > -6 && gap < 2) {
        const space = (cur.fontSize ?? prev.fontSize ?? 16) * 0.3;
        cur.x = (cur.x ?? 0) + space;
        shift += space;
      }
    }
  };
  const walk = (layer: Layer): void => {
    if (layer.children && layer.children.length > 1) fixLine(layer.children);
    if (layer.children) layer.children.forEach(walk);
  };
  layers.forEach(walk);
  if (layers.length > 1) fixLine(layers);
}

let options: CaptureOptions = resolveOptions({});

async function loadOptions(): Promise<void> {
  try {
    const state = (await chrome.storage.local.get([
      'useFrames',
      'includeImages',
    ])) as StoredState;
    options = resolveOptions(state);
  } catch {
    /* storage unavailable — keep defaults */
  }
}

function walk(layers: Layer[], visit: (layer: Layer) => void): void {
  for (const layer of layers) {
    visit(layer);
    if (layer.children) walk(layer.children, visit);
  }
}

function countLayers(layers: Layer[]): number {
  let count = 0;
  walk(layers, () => {
    count += 1;
  });
  return count;
}

function stripImages(layers: Layer[]): void {
  walk(layers, (layer) => {
    if (Array.isArray(layer.fills)) {
      layer.fills = layer.fills.filter((fill) => fill?.type !== 'IMAGE');
    }
    if (layer.name === 'IMAGE') delete layer.name;
  });
}

async function copyText(text: string): Promise<boolean> {
  try {
    window.focus();
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return copyViaTextarea(text);
  }
}

function copyViaTextarea(text: string): boolean {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.cssText =
    'position:fixed;top:0;left:0;opacity:0;pointer-events:none;';
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  textarea.remove();
  return ok;
}

// Above this many elements, the frame-nesting pass (one forced reflow per node)
// is too slow, so we flatten. Above the hard ceiling we refuse outright.
const FLATTEN_ABOVE = 1500;
const REFUSE_ABOVE = 20000;

/** Resolve after the browser has painted, so a progress toast shows before the
 * synchronous capture blocks the main thread. */
const nextPaint = (): Promise<void> =>
  new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  );

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => window.setTimeout(resolve, ms));

const eagerLoadImages = (scope: ParentNode): void => {
  for (const img of Array.from(scope.querySelectorAll('img'))) {
    if (img.loading === 'lazy') img.loading = 'eager';
    const dataSrc = img.getAttribute('data-src');
    if (dataSrc && !img.currentSrc) img.src = dataSrc;
    const dataSrcset = img.getAttribute('data-srcset');
    if (dataSrcset && !img.srcset) img.srcset = dataSrcset;
  }
};

/** Wait for the images in `scope` to finish (bounded), so none is captured empty. */
const waitForImages = (scope: ParentNode, timeout: number): Promise<unknown> =>
  Promise.all(
    Array.from(scope.querySelectorAll('img'))
      .filter((img) => !img.complete)
      .map((img) =>
        Promise.race([
          new Promise<void>((resolve) => {
            img.addEventListener('load', () => resolve(), { once: true });
            img.addEventListener('error', () => resolve(), { once: true });
          }),
          delay(timeout),
        ])
      )
  );

/**
 * Get assets loaded before reading the DOM.
 *
 * Whole-page captures must trip lazy loaders and IntersectionObserver section
 * reveals, so we load fonts and scroll the page in small steps (twice) before
 * settling. A picked element is already on screen, so we skip the page scroll
 * entirely (it's pointless and jarring) and just ensure its own images load.
 */
async function prepareLazyContent(
  root: Element,
  fullPage: boolean
): Promise<void> {
  if (!fullPage) {
    eagerLoadImages(root);
    await waitForImages(root, 2500);
    return;
  }

  eagerLoadImages(document);
  try {
    await Promise.race([document.fonts.ready, delay(2500)]);
  } catch {
    /* fonts API unavailable — continue */
  }

  const startX = window.scrollX;
  const startY = window.scrollY;

  for (let pass = 0; pass < 2; pass += 1) {
    const docHeight = document.documentElement.scrollHeight;
    const step = Math.max(200, Math.round(window.innerHeight * 0.6));
    for (let y = 0; y <= docHeight; y += step) {
      window.scrollTo(0, y);
      await delay(130);
    }
    eagerLoadImages(document);
    await waitForImages(document, 3500);
  }

  // Back to the top and let reveal animations settle before we read the DOM.
  window.scrollTo(startX, startY);
  await delay(600);
  await waitForImages(document, 2000);
}

async function capture(source: Element, fullPage: boolean): Promise<void> {
  const total = source.querySelectorAll('*').length;
  if (total > REFUSE_ABOVE) {
    showToast('That selection is too large — pick a smaller element', 'error');
    return;
  }

  if (fullPage) {
    showToast('Loading page…', 'success');
    await nextPaint();
  }
  await prepareLazyContent(source, fullPage);
  showToast('Yoinking…', 'success');
  await nextPaint();

  let useFrames = options.useFrames;
  const flattened = useFrames && total > FLATTEN_ABOVE;
  if (flattened) useFrames = false;

  let payload: string;
  let count: number;
  try {
    const aux = buildAuxMaps(source);
    const layers = htmlToFigma(source as HTMLElement, useFrames) as Layer[];
    if (!layers || layers.length === 0) {
      showToast('Nothing to yoink there', 'error');
      return;
    }
    applyGradients(layers, aux.gradients);
    applyOpacity(layers, aux.opacity);
    applyFontStyles(layers, aux.fontStyles);
    reorderByZIndex(layers, aux.zIndex);
    addRunSpacing(layers);
    if (!options.includeImages) stripImages(layers);
    count = countLayers(layers);
    payload = JSON.stringify({
      __yoink: PAYLOAD_TAG,
      source: { url: window.location.href, title: document.title },
      useFrames,
      layers,
    });
  } catch (error) {
    console.error('Yoink: capture failed', error);
    showToast('Could not read that element', 'error');
    return;
  }

  const copied = await copyText(payload);
  if (copied) {
    const label = count === 1 ? '1 layer' : `${count} layers`;
    const note = flattened ? ' (flattened for speed)' : '';
    showToast(
      `Yoinked ${label}${note} — paste into the Figma plugin`,
      'success'
    );
  } else {
    showToast('Clipboard blocked by this page', 'error');
  }
}

// Guard against double-registration: the manifest injects this on page load,
// and the popup may also inject it on demand into a pre-existing tab.
const flag = '__yoinkContentLoaded';
if (!(window as unknown as Record<string, boolean>)[flag]) {
  (window as unknown as Record<string, boolean>)[flag] = true;

  chrome.runtime.onMessage.addListener((message: PopupMessage) => {
    if (message.type === 'YOINK_START_PICK') {
      startPicker((el) => void capture(el, false));
    } else if (message.type === 'YOINK_CAPTURE_PAGE') {
      const body = document.body;
      if (body) void capture(body, true);
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.useFrames || changes.includeImages) {
      void loadOptions();
    }
  });

  void loadOptions();
}
