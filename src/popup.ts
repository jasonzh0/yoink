import { OPTION_KEYS, resolveOptions } from './constants';
import type { CaptureOptions, PopupMessage, StoredState } from './types';

type StatusKind = 'success' | 'error';

async function getActiveTabId(): Promise<number | null> {
  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    return tab?.id ?? null;
  } catch {
    return null;
  }
}

async function sendToPage(message: PopupMessage): Promise<boolean> {
  const tabId = await getActiveTabId();
  if (tabId == null) return false;
  try {
    await chrome.tabs.sendMessage(tabId, message);
    return true;
  } catch {
    // The content script isn't there yet (tab predates the extension load).
    // Inject it on demand via activeTab, then retry once.
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['contentScript.js'],
      });
      await chrome.tabs.sendMessage(tabId, message);
      return true;
    } catch {
      return false;
    }
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const pickBtn = document.getElementById('pickBtn');
  const pageBtn = document.getElementById('pageBtn');
  const status = document.getElementById('status');
  const versionNumber = document.getElementById('versionNumber');
  const toggles = OPTION_KEYS.map((key) =>
    document.getElementById(`${key}Toggle`)
  );

  if (!pickBtn || !pageBtn) return;

  const manifest = chrome.runtime.getManifest();
  if (versionNumber) versionNumber.textContent = manifest.version;

  let statusTimer: number | undefined;
  const setStatus = (message: string, kind?: StatusKind): void => {
    if (!status) return;
    status.textContent = message;
    status.className = 'status';
    if (kind) status.classList.add(kind);
    if (statusTimer) window.clearTimeout(statusTimer);
    if (message) {
      statusTimer = window.setTimeout(() => {
        status.textContent = '';
        status.className = 'status';
      }, 3200);
    }
  };

  const reflect = (options: CaptureOptions): void => {
    OPTION_KEYS.forEach((key, i) => {
      toggles[i]?.setAttribute('aria-checked', String(options[key]));
    });
  };

  const loadOptions = async (): Promise<void> => {
    try {
      const state = (await chrome.storage.local.get([
        ...OPTION_KEYS,
      ])) as StoredState;
      reflect(resolveOptions(state));
    } catch {
      reflect(resolveOptions({}));
    }
  };

  void loadOptions();

  OPTION_KEYS.forEach((key, i) => {
    const toggle = toggles[i];
    if (!toggle) return;
    toggle.addEventListener('click', async () => {
      const next = toggle.getAttribute('aria-checked') !== 'true';
      toggle.setAttribute('aria-checked', String(next));
      try {
        await chrome.storage.local.set({ [key]: next });
      } catch (error) {
        console.error('Yoink: failed to save option', error);
        toggle.setAttribute('aria-checked', String(!next));
      }
    });
  });

  const fail = (): void =>
    setStatus("Can't reach this page — try a normal site", 'error');

  pickBtn.addEventListener('click', async () => {
    const ok = await sendToPage({ type: 'YOINK_START_PICK' });
    if (ok) window.close();
    else fail();
  });

  pageBtn.addEventListener('click', async () => {
    const ok = await sendToPage({ type: 'YOINK_CAPTURE_PAGE' });
    if (ok) window.close();
    else fail();
  });
});
