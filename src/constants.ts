import type { CaptureOptions, StoredState } from './types';

export const DEFAULT_USE_FRAMES = true;
export const DEFAULT_INCLUDE_IMAGES = true;

export const OPTION_KEYS = ['useFrames', 'includeImages'] as const;

const asBool = (value: unknown, fallback: boolean): boolean =>
  typeof value === 'boolean' ? value : fallback;

export const resolveOptions = (state: StoredState): CaptureOptions => ({
  useFrames: asBool(state.useFrames, DEFAULT_USE_FRAMES),
  includeImages: asBool(state.includeImages, DEFAULT_INCLUDE_IMAGES),
});
