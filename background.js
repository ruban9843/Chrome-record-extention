// background.js — MV3 service worker.
// It only orchestrates: it opens the offscreen document (which owns the MediaStream and
// MediaRecorder, because service workers cannot use getUserMedia/MediaRecorder), forwards
// Pause/Resume/Stop, and reports the result.
//
// ── WHERE FILES GO (the D: drive) ─────────────────────────────────────────────────────────
// Normal path: you pick a folder ONCE on the options page (e.g. D:\Recordings). The extension
// remembers it and writes each recording straight into it, automatically. Change it any time from
// the "Change" link in the popup. (Chrome refuses a bare drive root like D:\, so pick a folder.)
//
// Fallback path (only if no folder is set or its access expired): chrome.downloads, which can
// only save inside Chrome's default download folder. To make that land on D: as well:
//   chrome://settings/downloads → Location → Change… → D:\Recordings, and turn OFF
//   "Ask where to save each file before downloading".
// ──────────────────────────────────────────────────────────────────────────────────────────
const FALLBACK_SUBFOLDER = ''; // optional sub-folder inside Chrome's download folder

// State lives in storage.session because the service worker can be stopped at any time.
async function setState(state, notice = '') {
  await chrome.storage.session.set({ state, notice });
  const text = { recording: 'REC', paused: 'II', saving: '...' }[state] || '';
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color: state === 'paused' ? '#d97706' : '#dc2626' });
}

async function ensureOffscreen() {
  const existing = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (existing.length) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['USER_MEDIA'],
    justification: 'Hold the capture stream and run MediaRecorder while the popup is closed.'
  });
}

async function closeOffscreen() {
  const existing = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (existing.length) await chrome.offscreen.closeDocument();
}

async function toOffscreen(message) {
  const res = await chrome.runtime.sendMessage({ target: 'offscreen', ...message });
  if (!res?.ok) throw new Error(res?.error || 'Recorder did not respond.');
  return res;
}

// Screen/window/tab picker. The "audio" source adds Chrome's "Also share system audio" checkbox.
function pickDesktop() {
  return new Promise((resolve) => {
    chrome.desktopCapture.chooseDesktopMedia(
      ['screen', 'window', 'tab', 'audio'],
      (streamId, options) => resolve({ streamId, canAudio: !!options?.canRequestAudioTrack })
    );
  });
}

async function startRecording({ mode, streamId }) {
  const { state } = await chrome.storage.session.get('state');
  if (state && state !== 'idle') return { ok: false, error: 'A recording is already in progress.' };

  let withAudio = true;
  const notices = [];

  if (mode === 'desktop') {
    const picked = await pickDesktop();
    if (!picked.streamId) return { ok: true, cancelled: true }; // user closed the picker
    streamId = picked.streamId;
    withAudio = picked.canAudio;
    if (!withAudio) {
      notices.push('No audio is being recorded: system audio is only offered when you pick "Entire screen" ' +
                   'and tick "Also share system audio". Stop and start again to fix.');
    }
  }

  await ensureOffscreen();
  try {
    const res = await toOffscreen({ type: 'start', mode, streamId, withAudio });
    if (res.notice) notices.push(res.notice);
  } catch (err) {
    await closeOffscreen();
    throw err;
  }
  await setState('recording', notices.join(' '));
  return { ok: true };
}

// Fallback save through chrome.downloads (blob: URL created in the offscreen document).
async function saveViaDownload({ url, name }) {
  await setState('saving');
  const id = await chrome.downloads.download({
    url,
    filename: FALLBACK_SUBFOLDER ? `${FALLBACK_SUBFOLDER}/${name}` : name,
    saveAs: false,             // no dialog; goes to Chrome's default download folder
    conflictAction: 'uniquify' // never overwrite
  });
  await chrome.storage.session.set({ downloadId: id });
  const [item] = await chrome.downloads.search({ id }); // it may have finished already
  if (item && (item.state === 'complete' || item.state === 'interrupted')) await finalizeDownload(id, item.state);
}

async function finalizeDownload(id, result) {
  const { downloadId } = await chrome.storage.session.get('downloadId');
  if (id !== downloadId) return;
  await chrome.storage.session.remove('downloadId');
  await closeOffscreen(); // also frees the blob URL
  await setState('idle', result === 'complete'
    ? "Saved to Chrome's default download folder."
    : 'Saving failed (download interrupted).');
}

chrome.downloads.onChanged.addListener((delta) => {
  const s = delta.state?.current;
  if (s === 'complete' || s === 'interrupted') finalizeDownload(delta.id, s);
});

async function handle(msg) {
  switch (msg.type) {
    case 'start':
      return startRecording(msg);
    case 'pause':
      await toOffscreen({ type: 'pause' });
      await setState('paused');
      return { ok: true };
    case 'resume':
      await toOffscreen({ type: 'resume' });
      await setState('recording');
      return { ok: true };
    case 'stop':
      await toOffscreen({ type: 'stop' });
      await setState('saving');
      return { ok: true };
    case 'saved': // written straight into the chosen folder
      await closeOffscreen();
      await setState('idle', `Saved: ${msg.folder}\\${msg.name}`);
      return { ok: true };
    case 'save': // no usable folder: save via downloads
      await saveViaDownload(msg);
      return { ok: true };
    case 'recorder-error':
      await closeOffscreen();
      await setState('idle', `Recorder error: ${msg.error}`);
      return { ok: true };
    default:
      return { ok: false, error: `Unknown message: ${msg.type}` };
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.target === 'offscreen') return; // addressed to the offscreen document
  handle(msg).then(sendResponse, (err) => sendResponse({ ok: false, error: err.message || String(err) }));
  return true; // async response
});
