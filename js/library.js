const MIN_DURATION = 0.1;

let nextId = 1;

function findFourcc(bytes, fourcc, start = 0, end = bytes.length) {
  const t = [fourcc.charCodeAt(0), fourcc.charCodeAt(1), fourcc.charCodeAt(2), fourcc.charCodeAt(3)];
  const stop = Math.min(end, bytes.length - 4);
  outer:
  for (let i = Math.max(start, 0); i < stop; i++) {
    for (let j = 0; j < 4; j++) if (bytes[i + j] !== t[j]) continue outer;
    return i;
  }
  return -1;
}

export function isMp4Container(bytes) {
  return findFourcc(bytes, 'ftyp', 4, 12) === 4;
}

function extractBoxDescription(bytes, fourcc) {
  const idx = findFourcc(bytes, fourcc);
  if (idx === -1) return null;
  const size = ((bytes[idx - 4] << 24) >>> 0) + (bytes[idx - 3] << 16) + (bytes[idx - 2] << 8) + bytes[idx - 1];
  if (size < 8 || idx - 4 + size > bytes.length) return null;
  return bytes.slice(idx + 4, idx - 4 + size);
}

export function extractAvcCDescription(bytes) {
  return extractBoxDescription(bytes, 'avcC');
}

export function extractHvcCDescription(bytes) {
  return extractBoxDescription(bytes, 'hvcC');
}

export function hasHevc(bytes) {
  return findFourcc(bytes, 'hvcC') !== -1;
}

export function displayRotation(matrix) {
  try {
    const m = matrix;
    if (!m || m.length < 9) return 0;
    const a = m[0] / 65536;
    const b = m[1] / 65536;
    if (a === 0 && b === 0) return 0;
    let angle = Math.round(Math.atan2(b, a) * (180 / Math.PI));
    angle = ((angle % 360) + 360) % 360;
    return Math.abs(angle - 90) < 2 ? 90 : Math.abs(angle - 180) < 2 ? 180 : Math.abs(angle - 270) < 2 ? 270 : 0;
  } catch {
    return 0;
  }
}

export function avcCodecString(desc) {
  const hex = (b) => b.toString(16).padStart(2, '0');
  return `avc1.${hex(desc[1])}${hex(desc[2])}${hex(desc[3])}`;
}

export function hevcCodecString(d) {
  const hexn = (b) => {
    const s = (b || 0).toString(16).replace(/^0+(?=.)/, '');
    return s || '';
  };
  const profile = hexn(d[1]) || '1';
  const compat = hexn(d[2]) || '6';
  const level = `L${d[12] || 120}`;
  const constraints = hexn(d[6]);
  const parts = [`hvc1.${profile}.${compat}.${level}`];
  if (constraints) parts.push(constraints);
  return parts.join('.');
}

const HEAD_SCAN = 2 * 1024 * 1024;
export const MP4_CHUNK = 4 * 1024 * 1024;

export async function feedMp4(file, mp4, startOffset = 0, chunkBytes = MP4_CHUNK) {
  let off = startOffset;
  while (!mp4.__vcReady && off < file.size) {
    const end = Math.min(off + chunkBytes, file.size);
    const buf = await file.slice(off, end).arrayBuffer();
    buf.fileStart = off;
    mp4.appendBuffer(buf);
    off = end;
  }
  mp4.__vcBytesFed = off;
  return off;
}

async function probeMp4(file) {
  const mp4 = MP4Box.createFile();
  let info = null;
  mp4.onReady = (i) => { info = i; mp4.__vcReady = true; };
  await feedMp4(file, mp4, 0, MP4_CHUNK);
  try { mp4.flush(); } catch { /* noop */ }
  if (!info) throw new Error('無法解析 MP4 結構（moov 遺失或檔案損毀）');
  const vt = info.videoTracks && info.videoTracks[0];
  const snap = {
    video: vt ? {
      nb_samples: vt.nb_samples,
      duration: vt.duration,
      timescale: vt.timescale,
      matrix: vt.matrix ? Array.from(vt.matrix) : null,
      track_width: vt.track_width,
      track_height: vt.track_height,
      rawWidth: vt.video ? vt.video.width : vt.width,
      rawHeight: vt.video ? vt.video.height : vt.height,
    } : null,
    hasAudio: !!(info.audioTracks && info.audioTracks.length),
    __bytesFed: mp4.__vcBytesFed || 0,
  };
  try { mp4.stop(); } catch { /* noop */ }
  try { mp4.releaseUsedSamples(); } catch { /* noop */ }
  try { if (mp4.stream) mp4.stream.buffers = []; } catch { /* noop */ }
  mp4.onReady = null;
  mp4.onError = null;
  mp4.boxes = [];
  info = null;
  return snap;
}

function makeThumb(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.muted = true;
    video.preload = 'auto';
    let done = false;
    const finish = (val) => { if (!done) { done = true; URL.revokeObjectURL(url); resolve(val); } };
    const timer = setTimeout(() => finish(null), 5000);
    video.onloadeddata = () => {
      try {
        const seekTo = Math.min(Math.max(video.duration * 0.1, 0.05), Math.max(video.duration - 0.05, 0));
        if (video.currentTime < seekTo - 0.01) video.currentTime = seekTo;
        else draw();
      } catch { finish(null); }
    };
    video.onseeked = draw;
    function draw() {
      try {
        const w = 160, h = 90;
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, w, h);
        const vw = video.videoWidth || 16, vh = video.videoHeight || 9;
        const s = Math.min(w / vw, h / vh);
        const dw = vw * s, dh = vh * s;
        ctx.drawImage(video, (w - dw) / 2, (h - dh) / 2, dw, dh);
        clearTimeout(timer);
        finish(canvas.toDataURL('image/jpeg', 0.65));
      } catch { clearTimeout(timer); finish(null); }
    }
    video.onerror = () => { clearTimeout(timer); finish(null); };
    video.src = url;
  });
}

export async function analyzeFile(file) {
  const head = new Uint8Array(await file.slice(0, HEAD_SCAN).arrayBuffer());
  if (!isMp4Container(head)) {
    throw new Error(`${file.name}：不是 MP4/MOV 容器，請改用 H.264 或 H.265 編碼的 MP4 / MOV 檔案`);
  }
  let avcDesc = extractAvcCDescription(head);
  let hvcDesc = extractHvcCDescription(head);
  if (!avcDesc || !hvcDesc) {
    const tailStart = Math.max(HEAD_SCAN, file.size - HEAD_SCAN);
    if (file.size > HEAD_SCAN) {
      const tail = new Uint8Array(await file.slice(tailStart).arrayBuffer());
      if (!avcDesc) avcDesc = extractAvcCDescription(tail);
      if (!hvcDesc) hvcDesc = extractHvcCDescription(tail);
    }
  }
  let videoCodec, codecString, description;
  if (avcDesc) {
    videoCodec = 'avc';
    description = avcDesc;
    codecString = avcCodecString(avcDesc);
  } else if (hvcDesc) {
    videoCodec = 'hevc';
    description = hvcDesc;
    codecString = hevcCodecString(hvcDesc);
  } else {
    throw new Error(`${file.name}：找不到 H.264 (avcC) 或 H.265 (hvcC) 視訊設定`);
  }
  if (typeof VideoDecoder !== 'undefined' && VideoDecoder.isConfigSupported) {
    const candidates = videoCodec === 'avc' ? [codecString] : [
      codecString,
      `hvc1.${(description[1] || 1).toString(16).replace(/^0+(?=.)/, '') || '1'}.6.L${description[12] || 120}.b0`,
      'hvc1.1.6.L120.b0',
      'hvc1.1.6.L153.b0',
    ];
    let supportedCodec = null;
    for (const cand of candidates) {
      try {
        const probe = await VideoDecoder.isConfigSupported({ codec: cand, description });
        if (probe.supported) { supportedCodec = cand; break; }
      } catch { /* next */ }
    }
    if (!supportedCodec) {
      if (videoCodec === 'hevc') {
        throw new Error(`${file.name}：此瀏覽器／裝置不支援 H.265 (HEVC) 解碼，請改用最新版 Chrome/Edge、安裝 HEVC 擴充，或改用 H.264 檔案`);
      }
      throw new Error(`${file.name}：此瀏覽器不支援解碼 ${codecString}`);
    }
    codecString = supportedCodec;
  }

  const info = await probeMp4(file);
  const vTrack = info.video;
  if (!vTrack || !vTrack.nb_samples) throw new Error(`${file.name}：沒有可用的視訊軌道`);
  const hasAudio = info.hasAudio;
  const rotation = displayRotation(vTrack.matrix);

  const duration = vTrack.timescale ? vTrack.duration / vTrack.timescale : 0;
  if (duration < MIN_DURATION) throw new Error(`${file.name}：影片時長過短`);
  let fps = vTrack.nb_samples && vTrack.duration ? (vTrack.nb_samples * vTrack.timescale) / vTrack.duration : 30;
  if (!isFinite(fps) || fps <= 0 || fps > 240) fps = 30;

  const url = URL.createObjectURL(file);
  const measured = await measureWithVideo(url).catch(() => null);
  let width, height;
  if (measured) { width = measured.width; height = measured.height; }
  else if (vTrack.track_width && vTrack.track_height) { width = vTrack.track_width; height = vTrack.track_height; }
  else {
    width = vTrack.rawWidth;
    height = vTrack.rawHeight;
  }
  if (!width || !height) throw new Error(`${file.name}：無法取得解析度`);

  const thumb = await makeThumb(file);

  return {
    id: nextId++,
    file,
    name: file.name.replace(/\.[^.]+$/, ''),
    url,
    duration,
    inPoint: 0,
    outPoint: duration,
    width,
    height,
    fps,
    hasAudio,
    rotation,
    thumb,
    videoCodec,
    codecString,
    description,
  };
}

function measureWithVideo(url) {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.muted = true;
    const timer = setTimeout(() => reject(new Error('metadata timeout')), 5000);
    video.onloadedmetadata = () => {
      clearTimeout(timer);
      resolve({ width: video.videoWidth, height: video.videoHeight });
    };
    video.onerror = () => { clearTimeout(timer); reject(new Error('metadata error')); };
    video.src = url;
  });
}

export function checkWebCodecsSupport() {
  const required = [
    ['VideoDecoder', () => typeof VideoDecoder !== 'undefined'],
    ['VideoEncoder', () => typeof VideoEncoder !== 'undefined'],
    ['AudioEncoder', () => typeof AudioEncoder !== 'undefined'],
    ['EncodedVideoChunk', () => typeof EncodedVideoChunk !== 'undefined'],
    ['AudioData', () => typeof AudioData !== 'undefined'],
    ['OffscreenCanvas', () => typeof OffscreenCanvas !== 'undefined'],
    ['MP4Box', () => typeof MP4Box !== 'undefined'],
    ['Mp4Muxer', () => typeof Mp4Muxer !== 'undefined'],
  ];
  const missing = required.filter(([, test]) => !test()).map(([name]) => name);
  return { ok: missing.length === 0, missing };
}

export function isMobileDevice() {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent || '' : '';
  if (/Android|iPhone|iPad|iPod|Mobile/i.test(ua)) return true;
  if (typeof navigator !== 'undefined' && navigator.platform === 'MacIntel' && (navigator.maxTouchPoints || 0) > 1) return true;
  return false;
}
