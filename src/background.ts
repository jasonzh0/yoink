import { DEFAULT_INCLUDE_IMAGES, DEFAULT_USE_FRAMES } from './constants';
import type { StoredState } from './types';

chrome.runtime.onInstalled.addListener(async () => {
  try {
    const result = (await chrome.storage.local.get([
      'useFrames',
      'includeImages',
    ])) as StoredState;

    const updates: StoredState = {};
    if (typeof result.useFrames !== 'boolean') {
      updates.useFrames = DEFAULT_USE_FRAMES;
    }
    if (typeof result.includeImages !== 'boolean') {
      updates.includeImages = DEFAULT_INCLUDE_IMAGES;
    }

    if (Object.keys(updates).length > 0) {
      await chrome.storage.local.set(updates);
    }
  } catch (error) {
    console.error('Yoink: failed to seed defaults', error);
  }
});
