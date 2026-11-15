// webm.js — makes MediaRecorder WebM files seekable.
//
// Why seeking was broken: MediaRecorder writes a "live" WebM with NO Duration in its header, so
// players show an unknown length and disable (or glitch) the seek bar.
// Fix: while the first chunk is still in memory we insert a Duration element (value 0) into the
// Info block. When recording ends we overwrite those 8 bytes with the real duration. Nothing else
// in the file moves, so the file is never rewritten or re-encoded.

const EBML_HEADER = 0x1A45DFA3, SEGMENT = 0x18538067, SEEKHEAD = 0x114D9B74,
      INFO = 0x1549A966, CLUSTER = 0x1F43B675, TIMECODE_SCALE = 0x2AD7B1, DURATION = 0x4489;

function readId(b, p) {
  if (p >= b.length || b[p] === 0) return null;
  const len = Math.clz32(b[p]) - 23;
  if (len > 4 || p + len > b.length) return null;
  let v = 0;
  for (let i = 0; i < len; i++) v = v * 256 + b[p + i];
  return { len, value: v };
}

function readSize(b, p) {
  if (p >= b.length || b[p] === 0) return null;
  const len = Math.clz32(b[p]) - 23;
  if (len > 8 || p + len > b.length) return null;
  const mask = 0xFF >> len;
  let v = b[p] & mask, ones = v === mask;
  for (let i = 1; i < len; i++) { v = v * 256 + b[p + i]; if (b[p + i] !== 0xFF) ones = false; }
  return { len, value: v, unknown: ones };
}

function writeSize(arr, pos, len, value) {
  for (let i = len - 1; i >= 0; i--) { arr[pos + i] = value % 256; value = Math.floor(value / 256); }
  arr[pos] |= 1 << (8 - len);
}

// bytes = the start of the first MediaRecorder chunk. Returns
// { bytes, durOffset, durLen, scale } or null if the layout isn't one we can safely patch
// (then the file is simply saved unpatched).
function patchWebmHeader(bytes) {
  let p = 0;
  let id = readId(bytes, p), sz = id && readSize(bytes, p + id.len);
  if (!id || !sz || id.value !== EBML_HEADER || sz.unknown) return null;
  p += id.len + sz.len + sz.value;

  id = readId(bytes, p); sz = id && readSize(bytes, p + id.len);
  if (!id || !sz || id.value !== SEGMENT) return null;
  const seg = { sizePos: p + id.len, sizeLen: sz.len, size: sz.value, unknown: sz.unknown };

  const segStart = p + id.len + sz.len;
  let seekHead = null;
  let q = segStart;
  while (q < bytes.length) {
    id = readId(bytes, q); sz = id && readSize(bytes, q + id.len);
    if (!id || !sz) return null;
    if (id.value === CLUSTER) return null; // reached media without finding Info
    if (sz.unknown) return null;
    const dataStart = q + id.len + sz.len;
    if (id.value === SEEKHEAD) seekHead = { dataStart, size: sz.value };
    if (id.value === INFO) return patchInfo(bytes, q, id, sz, dataStart, seg, seekHead, segStart);
    q = dataStart + sz.value;
  }
  return null;
}

function patchInfo(bytes, infoPos, id, sz, dataStart, seg, seekHead, segStart) {
  const infoEnd = dataStart + sz.value;
  if (infoEnd > bytes.length) return null;

  let scale = 1000000, dur = null;
  for (let r = dataStart; r < infoEnd;) {
    const cid = readId(bytes, r), csz = cid && readSize(bytes, r + cid.len);
    if (!cid || !csz || csz.unknown) return null;
    const cd = r + cid.len + csz.len;
    if (cid.value === TIMECODE_SCALE) { let v = 0; for (let i = 0; i < csz.value; i++) v = v * 256 + bytes[cd + i]; scale = v; }
    if (cid.value === DURATION && (csz.value === 4 || csz.value === 8)) dur = { offset: cd, len: csz.value };
    r = cd + csz.value;
  }
  if (dur) return { bytes, durOffset: dur.offset, durLen: dur.len, scale }; // already has one

  const ADD = 11; // ID (2) + size (1) + float64 (8)
  const newInfoSize = sz.value + ADD;
  if (newInfoSize >= Math.pow(2, 7 * sz.len) - 1) return null;
  const out = new Uint8Array(bytes.length + ADD);
  out.set(bytes.subarray(0, infoEnd), 0);
  out.set([0x44, 0x89, 0x88, 0, 0, 0, 0, 0, 0, 0, 0], infoEnd);
  out.set(bytes.subarray(infoEnd), infoEnd + ADD);
  writeSize(out, infoPos + id.len, sz.len, newInfoSize);
  if (!seg.unknown) writeSize(out, seg.sizePos, seg.sizeLen, seg.size + ADD);
  // Chrome's live output has no SeekHead; if one exists, everything after Info moved by ADD bytes.
  if (seekHead && !shiftSeekHead(out, seekHead, infoPos - segStart, ADD)) return null;
  return { bytes: out, durOffset: infoEnd + 3, durLen: 8, scale };
}

// Adds `add` to every SeekHead position that points past Info (positions are relative to the
// start of the Segment's data).
function shiftSeekHead(out, sh, infoRel, add) {
  for (let r = sh.dataStart; r < sh.dataStart + sh.size;) {
    const e = readId(out, r), es = e && readSize(out, r + e.len);
    if (!e || !es || es.unknown) return false;
    const ed = r + e.len + es.len;
    if (e.value === 0x4DBB) { // Seek
      for (let s = ed; s < ed + es.value;) {
        const c = readId(out, s), cs = c && readSize(out, s + c.len);
        if (!c || !cs || cs.unknown) return false;
        const cd = s + c.len + cs.len;
        if (c.value === 0x53AC) { // SeekPosition
          let v = 0;
          for (let i = 0; i < cs.value; i++) v = v * 256 + out[cd + i];
          if (v > infoRel) {
            v += add;
            if (v >= Math.pow(2, 8 * cs.value)) return false;
            for (let i = cs.value - 1; i >= 0; i--) { out[cd + i] = v % 256; v = Math.floor(v / 256); }
          }
        }
        s = cd + cs.value;
      }
    }
    r = ed + es.value;
  }
  return true;
}

// The bytes to write at header.durOffset once the recording length is known.
function durationBytes(header, durationMs) {
  const units = durationMs / (header.scale / 1e6); // Duration is in TimecodeScale units
  const a = new Uint8Array(header.durLen);
  const dv = new DataView(a.buffer);
  if (header.durLen === 8) dv.setFloat64(0, units); else dv.setFloat32(0, units);
  return a;
}

if (typeof module !== 'undefined') module.exports = { patchWebmHeader, durationBytes };
