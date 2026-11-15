// offscreen.js — owns the MediaStream and MediaRecorder (needs a DOM, so it can't live in the
// service worker, and must outlive the popup, which closes whenever it loses focus).
//
// Saving: chunks are written straight into the folder chosen on the options page (File System
// Access API), so long recordings don't pile up in RAM. If no folder is usable the recording is
// kept in memory and handed to chrome.downloads instead (Chrome's default download folder).

// ── Size/quality tuning — all the "small file" knobs are here ────────────────────────────────
const MAX_WIDTH = 1920;          // capture is capped at 1080p (never upscaled)
const MAX_HEIGHT = 1080;
const FRAME_RATE = 15;           // 15 fps is plenty for screen content; 30 roughly doubles size
const VIDEO_BPS = 1_200_000;     // ~1.2 Mbps VP9 ≈ 540 MB/hour. 800_000 for mostly static
                                 // slides/text, 2_500_000 for lots of motion.
const AUDIO_BPS = 48_000;        // Opus 48 kbps ≈ 21 MB/hour
// VP9 is ~30-40% smaller than VP8 at the same quality but uses more CPU. If your PC struggles,
// drop FRAME_RATE or put the H.264 entry first ('video/webm;codecs=h264,opus' — often
// hardware-accelerated, but ~30% bigger files).
const MIME_CANDIDATES = [
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm'
];
// ─────────────────────────────────────────────────────────────────────────────────────────────

let recorder = null, stream = null, audioCtx = null;
let sink = null;            // { kind: 'folder', dir, writable, name } | { kind: 'memory', parts: [] }
let header = null;          // result of patchWebmHeader() for the first chunk, or null
let firstChunk = true;
let queue = Promise.resolve(); // serialises chunk writes
let baseName = '';
let activeMs = 0, runStart = 0; // recorded length, excluding paused time

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.target !== 'offscreen') return;
  run(msg).then(
    (extra) => sendResponse({ ok: true, ...extra }),
    (err) => sendResponse({ ok: false, error: err.message || String(err) })
  );
  return true;
});

async function run(msg) {
  switch (msg.type) {
    case 'start':  return start(msg);
    case 'pause':  need().pause();  activeMs += performance.now() - runStart; return;
    case 'resume': need().resume(); runStart = performance.now(); return;
    case 'stop':   return stop();
  }
}

function need() {
  if (!recorder) throw new Error('Not recording.');
  return recorder;
}

const p2 = (n) => String(n).padStart(2, '0');
function newBaseName() {
  const d = new Date();
  return `recording_${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}` +
         `_${p2(d.getHours())}-${p2(d.getMinutes())}-${p2(d.getSeconds())}`;
}

async function exists(dir, name) {
  try { await dir.getFileHandle(name); return true; }
  catch (e) { if (e.name === 'NotFoundError') return false; throw e; }
}

// recording_2026-11-15_14-30-05.webm, or "... (1).webm", "... (2).webm" if that exists. Never overwrites.
async function uniqueName(dir, base) {
  let name = `${base}.webm`;
  for (let n = 1; await exists(dir, name); n++) name = `${base} (${n}).webm`;
  return name;
}

// Returns { sink, notice }. Falls back to memory + download when the folder isn't usable.
async function openSink() {
  try {
    const dir = await getSaveDir();
    if (!dir) throw new Error('No save folder chosen.');
    if ((await dir.queryPermission({ mode: 'readwrite' })) !== 'granted') throw new Error('Folder access expired.');
    const name = await uniqueName(dir, baseName);
    const writable = await (await dir.getFileHandle(name, { create: true })).createWritable();
    return { sink: { kind: 'folder', dir, writable, name } };
  } catch (err) {
    return {
      sink: { kind: 'memory', parts: [] },
      notice: `${err.message} This recording will be saved to Chrome's default download folder instead.`
    };
  }
}

async function start({ mode, streamId, withAudio }) {
  if (recorder) throw new Error('Already recording.');

  const source = mode === 'tab' ? 'tab' : 'desktop';
  stream = await navigator.mediaDevices.getUserMedia({
    audio: withAudio
      ? { mandatory: { chromeMediaSource: source, chromeMediaSourceId: streamId } }
      : false,
    video: {
      mandatory: {
        chromeMediaSource: source,
        chromeMediaSourceId: streamId,
        maxWidth: MAX_WIDTH,
        maxHeight: MAX_HEIGHT,
        maxFrameRate: FRAME_RATE
      }
    }
  });

  // Capturing a tab mutes it for the user; route the audio back to the speakers.
  if (mode === 'tab' && stream.getAudioTracks().length) {
    audioCtx = new AudioContext();
    audioCtx.createMediaStreamSource(stream).connect(audioCtx.destination);
  }

  baseName = newBaseName();
  const opened = await openSink();
  sink = opened.sink;
  header = null; firstChunk = true; queue = Promise.resolve();

  const mimeType = MIME_CANDIDATES.find((t) => MediaRecorder.isTypeSupported(t));
  recorder = new MediaRecorder(stream, {
    mimeType,
    videoBitsPerSecond: VIDEO_BPS,
    audioBitsPerSecond: AUDIO_BPS
  });
  recorder.ondataavailable = (e) => {
    if (!e.data.size) return;
    queue = queue.then(() => handleChunk(e.data)).catch(fail);
  };
  recorder.onstop = finish;
  recorder.onerror = (e) => fail(e.error || new Error('MediaRecorder error'));

  // If the user clicks Chrome's own "Stop sharing" bar, save what we have.
  stream.getVideoTracks()[0].addEventListener('ended', () => stop());

  activeMs = 0; runStart = performance.now();
  recorder.start(1000); // 1 s slices
  return { notice: opened.notice };
}

async function handleChunk(blob) {
  let parts = [blob];
  if (firstChunk) {
    firstChunk = false;
    // The first chunk holds the WebM header. Add a Duration placeholder so players can seek.
    const HEAD = 65536;
    const head = new Uint8Array(await blob.slice(0, HEAD).arrayBuffer());
    header = patchWebmHeader(head);
    if (header) parts = [header.bytes, blob.slice(head.length)];
  }
  for (const part of parts) {
    if (sink.kind === 'folder') await sink.writable.write(part);
    else sink.parts.push(part);
  }
}

function stop() {
  if (recorder && recorder.state !== 'inactive') {
    if (recorder.state === 'recording') activeMs += performance.now() - runStart;
    recorder.stop(); // -> onstop -> finish()
  }
}

async function finish() {
  const type = recorder?.mimeType || 'video/webm';
  stream?.getTracks().forEach((t) => t.stop());
  audioCtx?.close();
  recorder = null; stream = null; audioCtx = null;

  try {
    await queue; // let the last chunk finish writing
    const s = sink; sink = null;
    const durBytes = header ? durationBytes(header, activeMs) : null;

    if (s.kind === 'folder') {
      // Overwrite the 8-byte placeholder with the real length, then close = commit the file.
      if (durBytes) await s.writable.write({ type: 'write', position: header.durOffset, data: durBytes });
      await s.writable.close();
      chrome.runtime.sendMessage({ type: 'saved', name: s.name, folder: s.dir.name });
    } else {
      if (durBytes) header.bytes.set(durBytes, header.durOffset); // header.bytes is parts[0]
      const blob = new Blob(s.parts, { type });
      if (!blob.size) throw new Error('Nothing was recorded.');
      chrome.runtime.sendMessage({ type: 'save', url: URL.createObjectURL(blob), name: `${baseName}.webm` });
    }
  } catch (err) {
    fail(err);
  }
}

function fail(err) {
  chrome.runtime.sendMessage({ type: 'recorder-error', error: err.message || String(err) });
  if (recorder && recorder.state !== 'inactive') { recorder.onstop = null; recorder.stop(); }
  stream?.getTracks().forEach((t) => t.stop());
}
