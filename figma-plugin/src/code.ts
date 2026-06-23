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
  'url',
]);

const normalizeName = (str: string): string =>
  str.toLowerCase().replace(/[^a-z]/gi, '');

const fontCache: Record<string, FontName> = {};
let availableFonts: Font[] = [];

async function getMatchingFont(fontStr: string): Promise<FontName> {
  for (const family of fontStr.split(/\s*,\s*/)) {
    const norm = normalizeName(family);
    if (fontCache[norm]) return fontCache[norm];
    for (const available of availableFonts) {
      if (normalizeName(available.fontName.family) === norm) {
        await figma.loadFontAsync(available.fontName);
        fontCache[norm] = available.fontName;
        return available.fontName;
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
    text.fontName = layer.fontFamily
      ? await getMatchingFont(layer.fontFamily)
      : DEFAULT_FONT;
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
  availableFonts = (await figma.listAvailableFontsAsync()).filter(
    (font) => font.fontName.style === 'Regular'
  );
  await figma.loadFontAsync(DEFAULT_FONT);

  const layers = payload.layers ?? [];
  if (layers.length === 0) return 0;

  builtCount = 0;

  // The first layer is the root container. In nested mode it carries the whole
  // tree; in flat mode the remaining top-level layers are its children.
  const root = await buildTree(layers[0], figma.currentPage);
  const container =
    root && canContain(root) ? root : figma.currentPage;
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
