import { htmlToFigma } from '@builder.io/html-to-figma';
import { resolveOptions } from './constants';
import { showToast, startPicker } from './picker';
import { PAYLOAD_TAG } from './types';
import type { CaptureOptions, PopupMessage, StoredState } from './types';

interface Layer {
  type?: string;
  name?: string;
  fills?: Array<{ type?: string }>;
  children?: Layer[];
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

async function capture(source: Element): Promise<void> {
  const total = source.querySelectorAll('*').length;
  if (total > REFUSE_ABOVE) {
    showToast('That selection is too large — pick a smaller element', 'error');
    return;
  }

  showToast('Yoinking…', 'success');
  await nextPaint();

  let useFrames = options.useFrames;
  const flattened = useFrames && total > FLATTEN_ABOVE;
  if (flattened) useFrames = false;

  let payload: string;
  let count: number;
  try {
    const layers = htmlToFigma(source as HTMLElement, useFrames) as Layer[];
    if (!layers || layers.length === 0) {
      showToast('Nothing to yoink there', 'error');
      return;
    }
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
    showToast(`Yoinked ${label}${note} — paste into the Figma plugin`, 'success');
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
      startPicker((el) => void capture(el));
    } else if (message.type === 'YOINK_CAPTURE_PAGE') {
      const body = document.body;
      if (body) void capture(body);
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
