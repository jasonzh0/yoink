export interface GradientStop {
  position: number;
  color: { r: number; g: number; b: number; a: number };
}

export interface GradientPaint {
  type: 'GRADIENT_LINEAR' | 'GRADIENT_RADIAL';
  gradientTransform: number[][];
  gradientStops: GradientStop[];
}

const DIRECTIONS: Record<string, number> = {
  'to top': 0,
  'to bottom': 180,
  'to left': 270,
  'to right': 90,
  'to top right': 45,
  'to right top': 45,
  'to bottom right': 135,
  'to right bottom': 135,
  'to bottom left': 225,
  'to left bottom': 225,
  'to top left': 315,
  'to left top': 315,
};

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

function parseColor(input: string): GradientStop['color'] | null {
  const s = input.trim();
  if (s === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };

  const rgb = s.match(/rgba?\(([^)]+)\)/i);
  if (rgb) {
    const parts = rgb[1].split(',').map((p) => parseFloat(p.trim()));
    const [r, g, b] = parts;
    const a = parts.length >= 4 ? parts[3] : 1;
    if ([r, g, b].some((n) => Number.isNaN(n))) return null;
    return { r: r / 255, g: g / 255, b: b / 255, a: Number.isNaN(a) ? 1 : a };
  }

  const hex = s.match(/^#([0-9a-f]{3,8})$/i);
  if (hex) {
    let h = hex[1];
    if (h.length === 3 || h.length === 4) {
      h = h
        .split('')
        .map((c) => c + c)
        .join('');
    }
    const r = parseInt(h.slice(0, 2), 16) / 255;
    const g = parseInt(h.slice(2, 4), 16) / 255;
    const b = parseInt(h.slice(4, 6), 16) / 255;
    const a = h.length >= 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
    return { r, g, b, a };
  }
  return null;
}

/** Split on top-level commas (commas inside parentheses stay put). */
function splitTopLevel(value: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of value) {
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) {
      out.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) out.push(current);
  return out;
}

function extractGradient(
  backgroundImage: string
): { kind: 'linear' | 'radial'; inner: string } | null {
  const match = backgroundImage.match(
    /(?:-webkit-)?(?:repeating-)?(linear|radial)-gradient\s*\(/i
  );
  if (!match || match.index === undefined) return null;

  const start = match.index + match[0].length;
  let depth = 1;
  let i = start;
  for (; i < backgroundImage.length && depth > 0; i += 1) {
    if (backgroundImage[i] === '(') depth += 1;
    else if (backgroundImage[i] === ')') depth -= 1;
  }
  return {
    kind: match[1].toLowerCase() as 'linear' | 'radial',
    inner: backgroundImage.slice(start, i - 1),
  };
}

function buildStops(parts: string[]): GradientStop[] {
  const stops: GradientStop[] = [];
  parts.forEach((part, index) => {
    const positionToken = part.trim().match(/(-?[\d.]+)%\s*$/);
    const colorStr = part.replace(/\s+-?[\d.]+%\s*$/, '').trim();
    const color = parseColor(colorStr);
    if (!color) return;
    const position = positionToken
      ? parseFloat(positionToken[1]) / 100
      : parts.length > 1
      ? index / (parts.length - 1)
      : 0;
    stops.push({ position: clamp01(position), color });
  });
  return stops;
}

function linearTransform(angleDeg: number): number[][] {
  // Figma's identity linear gradient runs left->right (CSS 90deg); rotate from there.
  const a = ((angleDeg - 90) * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  return [
    [cos, sin, (1 - cos - sin) / 2],
    [-sin, cos, (1 + sin - cos) / 2],
  ];
}

const isColorStart = (s: string): boolean =>
  /^(rgba?\(|#|transparent\b|hsla?\()/i.test(s.trim());

/** Parse the first gradient in a CSS `background-image` into a Figma paint. */
export function parseGradientFill(backgroundImage: string): GradientPaint | null {
  const gradient = extractGradient(backgroundImage);
  if (!gradient) return null;

  const parts = splitTopLevel(gradient.inner);
  if (parts.length === 0) return null;

  let angle = 180;
  let stopParts = parts;
  const first = parts[0].trim();

  if (gradient.kind === 'linear') {
    if (/deg\s*$/.test(first)) {
      angle = parseFloat(first);
      stopParts = parts.slice(1);
    } else if (/^to\s/i.test(first)) {
      angle = DIRECTIONS[first.toLowerCase().replace(/\s+/g, ' ')] ?? 180;
      stopParts = parts.slice(1);
    }
  } else if (!isColorStart(first)) {
    // radial: drop a leading shape/size/position descriptor (e.g. "circle at center")
    stopParts = parts.slice(1);
  }

  const stops = buildStops(stopParts);
  if (stops.length === 0) return null;
  if (stops.length === 1) {
    stops.push({ position: 1, color: stops[0].color });
  }

  return {
    type: gradient.kind === 'linear' ? 'GRADIENT_LINEAR' : 'GRADIENT_RADIAL',
    gradientTransform:
      gradient.kind === 'linear'
        ? linearTransform(angle)
        : [
            [1, 0, 0],
            [0, 1, 0],
          ],
    gradientStops: stops,
  };
}
