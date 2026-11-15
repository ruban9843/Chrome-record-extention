# Tab & System Audio Recorder (Manifest V3) — v1.1

## 1. Load it
1. Unzip the folder somewhere permanent (Chrome reads it from there).
2. Open `chrome://extensions`, switch on **Developer mode** (top right).
3. **Load unpacked** → select the `tab-recorder` folder. Pin the extension (puzzle-piece menu).
   (Needs Chrome 116 or newer. After updating the files, click the reload icon on the extension.)

## 2. Choose the save folder (one time)
1. Create a folder on D:, e.g. `D:\Recordings` (Chrome won't let you pick a bare drive root like `D:\`).
2. Click the extension → **Choose** (next to "Save to") → **Choose / change folder…** → pick it.
3. Chrome asks to allow editing files: allow it, and if offered choose **"Allow on every visit"**.

From then on every recording is saved there automatically as
`recording_2026-11-15_14-30-05.webm` (a name clash becomes `... (1).webm`; nothing is overwritten).
To change the folder later: popup → **Change**, pick a new one.
If Chrome ever asks for access again after a restart, it is requested when you press Start.

## 3. Record with system sound (Windows)
1. Click the extension → leave **Screen + system audio** selected → **Start recording**.
2. In Chrome's picker choose the **Entire Screen** tab, select your screen, and tick
   **Also share system audio** (bottom-left of the dialog), then Share.
   - "Window" and "Chrome Tab" sources do NOT carry system audio on Windows.
   - If you forget the checkbox, the popup warns you that no audio is being recorded.
3. **Pause / Resume** keep one file. **Stop & save** finishes it. Clicking Chrome's own
   "Stop sharing" bar also saves.
4. **Current tab** mode records only that tab's video and audio (still audible to you).

## 4. Seeking (forward/backward)
Chrome's MediaRecorder writes WebM without a length, which breaks the seek bar. v1.1 inserts the
real duration into the file header when you stop, so the seek bar works in Chrome, VLC, etc.
Windows' built-in Movies & TV / Media Player handle WebM poorly; use VLC or Chrome to play them.
For a fully indexed file (best for editors), remux without re-encoding:
`ffmpeg -i recording.webm -c copy recording_indexed.webm`

## 5. Size tuning
Edit the constants at the top of `offscreen.js` (frame rate, video bitrate, audio bitrate, codec),
then reload the extension.

## Fallback
If no folder is chosen/usable, the recording is kept in memory and saved through Chrome's downloads
into its default folder (set it to D: under `chrome://settings/downloads`, and turn off
"Ask where to save each file").
