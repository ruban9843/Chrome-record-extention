const $ = (id) => document.getElementById(id);
const LABELS = { idle: 'Ready', recording: '● Recording', paused: '❚❚ Paused', saving: 'Saving…' };

function render({ state = 'idle', notice = '' }) {
  $('status').textContent = LABELS[state];
  $('notice').textContent = notice;
  $('start').hidden = state !== 'idle';
  $('pause').hidden = state !== 'recording';
  $('resume').hidden = state !== 'paused';
  $('stop').hidden = !(state === 'recording' || state === 'paused');
  $('change').hidden = state !== 'idle';
  document.querySelectorAll('input[name=mode]').forEach((r) => (r.disabled = state !== 'idle'));
}

const refresh = () => chrome.storage.session.get(['state', 'notice']).then(render);
refresh();
chrome.storage.onChanged.addListener((_c, area) => { if (area === 'session') refresh(); });

getSaveDir().then((dir) => {
  $('folderName').textContent = dir ? dir.name : 'not chosen yet';
  $('change').textContent = dir ? 'Change' : 'Choose';
});

// The folder picker can't run inside a popup (it closes when focus moves), so it lives on the options page.
$('change').onclick = (e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); };

async function send(message) {
  const res = await chrome.runtime.sendMessage(message);
  if (res && res.ok === false) $('notice').textContent = res.error;
  return res;
}

// Make sure a folder is chosen and writable. Runs on the Start click, which counts as the user
// gesture Chrome requires to re-ask for folder access after a browser restart.
async function folderReady() {
  const dir = await getSaveDir();
  if (!dir) {
    $('notice').textContent = 'Choose a save folder first (opening settings…).';
    chrome.runtime.openOptionsPage();
    return false;
  }
  if ((await dir.queryPermission({ mode: 'readwrite' })) !== 'granted') {
    const answer = await dir.requestPermission({ mode: 'readwrite' });
    if (answer !== 'granted') {
      $('notice').textContent = 'Folder access is needed. Click "Re-allow access" in settings.';
      chrome.runtime.openOptionsPage();
      return false;
    }
  }
  return true;
}

$('start').onclick = async () => {
  const mode = document.querySelector('input[name=mode]:checked').value;
  $('start').disabled = true;
  try {
    if (!(await folderReady())) return;
    let streamId;
    if (mode === 'tab') {
      // Must be requested here, while the popup counts as the user's invocation (activeTab).
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
    }
    // In 'desktop' mode the service worker opens Chrome's picker (the popup may close; that's fine).
    await send({ type: 'start', mode, streamId });
  } catch (err) {
    $('notice').textContent = err.message;
  } finally {
    $('start').disabled = false;
  }
};
$('pause').onclick = () => send({ type: 'pause' });
$('resume').onclick = () => send({ type: 'resume' });
$('stop').onclick = () => send({ type: 'stop' });
