const PAYLOAD_TAG = 'yoink/figma@1';
const DEFAULT_FONT: FontName = { family: 'Roboto', style: 'Regular' };

interface Layer {
  type?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  svg?: string;
  fontFamily?: string;
  fontWeight?: number;
  fontStyle?: string;
  fills?: Array<Record<string, unknown>>;
  children?: Layer[];
  [key: string]: unknown;
}

interface Payload {
  __yoink?: string;
  source?: { url?: string; title?: string };
  layers?: Layer[];
}

const SKIP_KEYS = new Set([
  'width',
  'height',
  'type',
  'ref',
  'children',
  'svg',
  'data',
  'fontFamily',
  'fontWeight',
  'fontStyle',
  'url',
]);

const normalizeName = (str: string): string =>
  str.toLowerCase().replace(/[^a-z]/gi, '');

// Figma encodes weight + slant in a free-text style name ("SemiBold Italic").
// Map those names to an approximate CSS numeric weight so we can score the
// closest available style against the captured one. Order matters: compound
// names ("extra bold", "semi bold") must be tested before bare "bold".
const WEIGHT_NAMES: Array<[RegExp, number]> = [
  [/thin|hairline/, 100],
  [/extra\s*light|ultra\s*light/, 200],
  [/demi\s*light|semi\s*light/, 350],
  [/light/, 300],
  [/medium/, 500],
  [/semi\s*bold|demi\s*bold/, 600],
  [/extra\s*bold|ultra\s*bold/, 800],
  [/black|heavy|fat|poster/, 900],
  [/bold/, 700],
  [/book|roman|normal|regular/, 400],
];

function styleToWeight(style: string): { weight: number; italic: boolean } {
  const s = style.toLowerCase();
  let weight = 400;
  for (const [re, w] of WEIGHT_NAMES) {
    if (re.test(s)) {
      weight = w;
      break;
    }
  }
  return { weight, italic: /italic|oblique/.test(s) };
}

// Pages routinely use proprietary web fonts (GT Super Display, PP Neue
// Montreal, …) that aren't installed in Figma. When none of the named families
// resolve, fall back by the CSS generic keyword so at least the *category* is
// right — a serif headline should land on a serif, not sans-serif Roboto.
// Ordered most- to least-preferred; first one actually installed wins.
const GENERIC_FALLBACKS: Record<string, string[]> = {
  serif: ['Georgia', 'Times New Roman', 'Times', 'Roboto Serif'],
  'sans-serif': ['Inter', 'Roboto', 'Helvetica Neue', 'Arial'],
  monospace: ['Roboto Mono', 'Menlo', 'Courier New'],
};

const fontCache: Record<string, FontName> = {};
let availableFonts: Font[] = [];

const stylesForFamily = (family: string): Font[] => {
  const norm = normalizeName(family);
  return norm
    ? availableFonts.filter((f) => normalizeName(f.fontName.family) === norm)
    : [];
};

/** Of one family's installed styles, pick the closest weight — matching slant
 * first so weight never wins over italic. */
function pickStyle(styles: Font[], weight: number, italic: boolean): FontName {
  let best = styles[0].fontName;
  let bestScore = Infinity;
  for (const f of styles) {
    const parsed = styleToWeight(f.fontName.style);
    const score =
      Math.abs(parsed.weight - weight) + (parsed.italic === italic ? 0 : 1000);
    if (score < bestScore) {
      bestScore = score;
      best = f.fontName;
    }
  }
  return best;
}

/** Resolve a CSS font stack + captured weight/italic to an installed Figma
 * font: first an exact family match, then the CSS generic-family fallback, then
 * DEFAULT_FONT. When the family resolves (system fonts, fonts the user has) the
 * captured weight/slant sticks. */
async function getMatchingFont(
  fontStr: string,
  weight: number,
  italic: boolean
): Promise<FontName> {
  const cacheKey = `${fontStr}|${weight}|${italic ? 'i' : 'n'}`;
  if (fontCache[cacheKey]) return fontCache[cacheKey];

  const families = fontStr.split(/\s*,\s*/);

  // 1) A named family is installed.
  for (const family of families) {
    const styles = stylesForFamily(family);
    if (styles.length > 0) {
      const name = pickStyle(styles, weight, italic);
      await figma.loadFontAsync(name);
      fontCache[cacheKey] = name;
      return name;
    }
  }

  // 2) Nothing named is installed — honor the generic keyword (serif/sans/mono).
  for (const family of families) {
    const generic = family.toLowerCase().replace(/['"]/g, '').trim();
    const candidates = GENERIC_FALLBACKS[generic];
    if (!candidates) continue;
    for (const candidate of candidates) {
      const styles = stylesForFamily(candidate);
      if (styles.length > 0) {
        const name = pickStyle(styles, weight, italic);
        await figma.loadFontAsync(name);
        fontCache[cacheKey] = name;
        return name;
      }
    }
  }

  return DEFAULT_FONT;
}

function assign(node: SceneNode, layer: Layer): void {
  for (const key in layer) {
    if (SKIP_KEYS.has(key)) continue;
    const value = layer[key];
    if (value === undefined) continue;
    try {
      (node as unknown as Record<string, unknown>)[key] = value;
    } catch (error) {
      console.warn(`Yoink: could not set "${key}"`, error);
    }
  }
}

async function loadImage(url: string): Promise<Image | null> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await figma.createImageAsync(url);
    } catch (error) {
      if (attempt === 1) console.warn('Yoink: image failed →', url, error);
    }
  }
  return null;
}

/** Resolve IMAGE fills (which carry a `url`) into Figma image hashes. On
 * failure, leave a visible labeled placeholder rather than a silent blank. */
async function resolveImageFills(layer: Layer): Promise<void> {
  if (!Array.isArray(layer.fills)) return;
  const resolved: Array<Record<string, unknown>> = [];
  for (const fill of layer.fills) {
    if (fill && fill.type === 'IMAGE') {
      const url = typeof fill.url === 'string' ? fill.url : '';
      if (!url) continue;
      const image = await loadImage(url);
      if (image) {
        resolved.push({
          type: 'IMAGE',
          scaleMode: fill.scaleMode || 'FILL',
          imageHash: image.hash,
        });
      } else {
        resolved.push({ type: 'SOLID', color: { r: 0.8, g: 0.8, b: 0.82 } });
        const prev = typeof layer.name === 'string' ? layer.name : '';
        layer.name = `${prev} ⚠ image-failed`.trim();
      }
    } else if (fill) {
      resolved.push(fill);
    }
  }
  layer.fills = resolved;
}

const size = (value: number | undefined): number => Math.max(1, value || 1);

async function createNode(layer: Layer): Promise<SceneNode | null> {
  if (layer.type === 'FRAME' || layer.type === 'GROUP') {
    const frame = figma.createFrame();
    await resolveImageFills(layer);
    assign(frame, layer);
    frame.resize(size(layer.width), size(layer.height));
    return frame;
  }

  if (layer.type === 'SVG' && layer.svg) {
    try {
      const node = figma.createNodeFromSvg(layer.svg);
      assign(node, layer);
      node.resize(size(layer.width), size(layer.height));
      return node;
    } catch (error) {
      console.warn('Yoink: SVG failed', error);
      return null;
    }
  }

  if (layer.type === 'RECTANGLE') {
    const rect = figma.createRectangle();
    await resolveImageFills(layer);
    assign(rect, layer);
    rect.resize(size(layer.width), size(layer.height));
    return rect;
  }

  if (layer.type === 'TEXT') {
    const text = figma.createText();
    text.fontName = await getMatchingFont(
      layer.fontFamily || 'Roboto',
      layer.fontWeight ?? 400,
      layer.fontStyle === 'italic'
    );
    assign(text, layer);
    text.resize(size(layer.width), size(layer.height));
    text.textAutoResize = 'HEIGHT';
    fitText(text, layer);
    return text;
  }

  return null;
}

/**
 * The page's web font usually isn't available in Figma, so text is rebuilt in a
 * fallback whose metrics differ — overflowing its box and wrapping/clipping.
 * Shrink the font size until the text fits (capped at ~30% so we never mangle).
 */
function fitText(text: TextNode, layer: Layer): void {
  const targetW = typeof layer.width === 'number' ? layer.width : text.width;
  const targetH = typeof layer.height === 'number' ? layer.height : text.height;
  const lineHeight = layer.lineHeight;
  const lh =
    lineHeight && typeof lineHeight === 'object' && 'value' in lineHeight
      ? Number((lineHeight as { value: number }).value)
      : targetH;
  const baseSize = typeof layer.fontSize === 'number' ? layer.fontSize : 16;

  let adjustments = 0;
  while (
    typeof text.fontSize === 'number' &&
    (text.height > Math.max(targetH, lh) * 1.2 || text.width > targetW * 1.2)
  ) {
    if (adjustments++ > baseSize * 0.3) break;
    try {
      text.fontSize = (text.fontSize as number) - 1;
    } catch {
      break;
    }
  }
}

let builtCount = 0;

async function buildTree(
  layer: Layer,
  parent: BaseNode & ChildrenMixin
): Promise<SceneNode | null> {
  const node = await createNode(layer);
  if (!node) return null;
  builtCount += 1;

  parent.appendChild(node);
  node.x = layer.x || 0;
  node.y = layer.y || 0;

  if (layer.children) {
    for (const child of layer.children) {
      await buildTree(child, node as BaseNode & ChildrenMixin);
    }
  }
  return node;
}

const canContain = (node: SceneNode): node is SceneNode & ChildrenMixin =>
  'appendChild' in node;

async function importPayload(payload: Payload): Promise<number> {
  // Keep every style (not just Regular) so weight/italic matching has options.
  availableFonts = await figma.listAvailableFontsAsync();
  await figma.loadFontAsync(DEFAULT_FONT);

  const layers = payload.layers ?? [];
  if (layers.length === 0) return 0;

  builtCount = 0;

  // The first layer is the root container. In nested mode it carries the whole
  // tree; in flat mode the remaining top-level layers are its children.
  const root = await buildTree(layers[0], figma.currentPage);
  const container = root && canContain(root) ? root : figma.currentPage;
  for (let i = 1; i < layers.length; i += 1) {
    await buildTree(layers[i], container);
  }

  if (root) {
    const center = figma.viewport.center;
    root.x = Math.round(center.x);
    root.y = Math.round(center.y);
    figma.currentPage.selection = [root];
    figma.viewport.scrollAndZoomIntoView([root]);
  }
  return builtCount;
}

figma.showUI(__html__, { width: 340, height: 440, themeColors: true });

figma.ui.onmessage = async (message: { type: string; payload?: Payload }) => {
  if (message.type === 'import' && message.payload) {
    if (message.payload.__yoink !== PAYLOAD_TAG) {
      figma.notify("That doesn't look like a Yoink capture", { error: true });
      figma.ui.postMessage({ type: 'error', message: 'Invalid payload' });
      return;
    }
    try {
      const count = await importPayload(message.payload);
      const title = message.payload.source?.title;
      figma.notify(
        `Yoinked ${count} layer${count === 1 ? '' : 's'}${
          title ? ` from “${title}”` : ''
        }`
      );
      figma.ui.postMessage({ type: 'done', count });
    } catch (error) {
      console.error(error);
      figma.notify(`Yoink failed: ${String(error)}`, { error: true });
      figma.ui.postMessage({ type: 'error', message: String(error) });
    }
  } else if (message.type === 'cancel') {
    figma.closePlugin();
  }
};
