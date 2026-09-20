import { extractAvcCDescription, extractHvcCDescription, avcCodecString, hevcCodecString, feedMp4, MP4_CHUNK } from './library.js';
import { diagMark } from './diag.js';

function resolveVideoConfig(clip) {
  if (clip.videoCodec && clip.codecString && clip.description) {
    return { type: clip.videoCodec, codec: clip.codecString, description: clip.description };
  }
  return null;
}

export async function demuxVideo(clip) {
  const file = clip.file;
  let cfg = resolveVideoConfig(clip);

  diagMark('demux', { clip: file.name, mb: Math.round(file.size / 104857.6) / 10 });
  const mp4 = MP4Box.createFile();
  let readyFlag = false;
  const infoP = new Promise((resolve, reject) => {
    mp4.onReady = (i) => { readyFlag = true; mp4.__vcReady = true; resolve(i); };
    mp4.onError = (e) => reject(new Error('mp4box 錯誤：' + JSON.stringify(e)));
  });
  infoP.catch(() => {});
  try {
    await feedMp4(file, mp4, 0, MP4_CHUNK);
    try { mp4.flush(); } catch { /* noop */ }
  } catch (e) {
    try { mp4.stop(); } catch { /* noop */ }
    throw e;
  }
  clip.__demuxFeedBytes = mp4.__vcBytesFed || 0;
  if (!readyFlag) {
    try { mp4.stop(); } catch { /* noop */ }
    throw new Error(`${file.name}：mp4box 無法解析檔案（找不到 moov）`);
  }
  const info = await infoP;

  if (!cfg) {
    const scanHead = new Uint8Array(await file.slice(0, MP4_CHUNK).arrayBuffer());
    const scanTail = new Uint8Array(await file.slice(Math.max(0, file.size - MP4_CHUNK)).arrayBuffer());
    const avc = extractAvcCDescription(scanHead) || extractAvcCDescription(scanTail);
    const hvc = extractHvcCDescription(scanHead) || extractHvcCDescription(scanTail);
    if (avc) cfg = { type: 'avc', codec: avcCodecString(avc), description: avc };
    else if (hvc) cfg = { type: 'hevc', codec: hevcCodecString(hvc), description: hvc };
    else throw new Error(`${file.name}：匯出時找不到 avcC / hvcC 設定`);
  }

  const track = info.videoTracks[0];
  let samples = null;
  try {
    const table = mp4.getTrackSamplesInfo ? mp4.getTrackSamplesInfo(track.id) : null;
    if (table && table.length) {
      samples = [];
      for (const s of table) {
        if (typeof s.offset !== 'number' || typeof s.size !== 'number' || !(s.size > 0)) {
          samples = null;
          break;
        }
        samples.push({
          cts: s.cts,
          duration: s.duration,
          is_sync: !!s.is_sync,
          offset: s.offset,
          size: s.size,
        });
      }
    }
  } catch { samples = null; }
  if (!samples) {
    try { mp4.stop(); } catch { /* noop */ }
    throw new Error(`${file.name}：無法取得樣本表（stbl 損毀或 mp4box 不支援）`);
  }

  try { mp4.stop(); } catch { /* noop */ }
  try { mp4.releaseUsedSamples(track.id); } catch { /* noop */ }
  try { if (mp4.stream) mp4.stream.buffers = []; } catch { /* noop */ }
  mp4.onSamples = null;
  mp4.onReady = null;
  mp4.onError = null;
  mp4.boxes = [];

  return {
    samples,
    timescale: track.timescale,
    description: cfg.description,
    codec: cfg.codec,
    type: cfg.type,
  };
}

function chunkFromSample(sample, timescale, data) {
  return new EncodedVideoChunk({
    type: sample.is_sync ? 'key' : 'delta',
    timestamp: Math.round((sample.cts * 1e6) / timescale),
    duration: Math.round((sample.duration * 1e6) / timescale),
    data,
  });
}

async function readSampleGroup(file, group) {
  let min = Infinity;
  let max = 0;
  for (const s of group) {
    if (s.offset < min) min = s.offset;
    const end = s.offset + s.size;
    if (end > max) max = end;
  }
  const buf = new Uint8Array(await file.slice(min, max).arrayBuffer());
  return { buf, min };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function decodeAndEncode(clip, ctxObj) {
  const { startUs, encoder, canvas, ctx, muxer, onFrameDone, onFeedProgress, isErrored } = ctxObj;
  const { samples, timescale, description, codec } = await demuxVideo(clip);
  diagMark('encode-clip', { clip: clip.name, samples: samples.length, phase: 'feed' });
  const aborted = () => (isErrored ? isErrored() : false);

  const inUs = Math.round(clip.inPoint * 1e6);
  const outUs = Math.round(clip.outPoint * 1e6);

  const MEM_BUDGET = ctxObj.memBudgetBytes ?? 600 * 1024 * 1024;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v | 0));
  const srcW = clip.width || canvas.width, srcH = clip.height || canvas.height;
  const decodedCost = Math.max(1, srcW * srcH * 4);
  const canvasCost = Math.max(1, canvas.width * canvas.height * 4);
  const frameQueueCap = clamp(ctxObj.frameQueueCap ?? (MEM_BUDGET / decodedCost), 2, 48);
  const encodeQueueCap = clamp(ctxObj.encodeQueueCap ?? (MEM_BUDGET / canvasCost), 2, 16);
  const decodeQueueCap = Math.max(30, ctxObj.decodeQueueCap ?? 240);

  const queue = [];
  let decodeError = null;
  let feedDone = false;

  const decoder = new VideoDecoder({
    output: (frame) => queue.push(frame),
    error: (e) => { decodeError = e; },
  });
  decoder.configure({ codec, description });

  const CHUNK = Math.min(30, Math.max(frameQueueCap, 4));
  (async () => {
    try {
      for (let i = 0; i < samples.length; i += CHUNK) {
        while ((queue.length > frameQueueCap || decoder.decodeQueueSize > decodeQueueCap) && !decodeError && !aborted()) await sleep(5);
        if (decodeError || aborted()) return;
        const group = samples.slice(i, i + CHUNK);
        const { buf, min } = await readSampleGroup(clip.file, group);
        for (const s of group) {
          decoder.decode(chunkFromSample(s, timescale, buf.subarray(s.offset - min, s.offset - min + s.size)));
        }
        onFeedProgress?.(Math.min(1, (i + CHUNK) / samples.length));
      }
      await decoder.flush();
    } catch (e) {
      decodeError = decodeError || e;
    } finally {
      feedDone = true;
    }
  })();

  let kept = 0;
  let lastFrameUs = 0;

  while (true) {
    if (decodeError) throw decodeError;
    if (aborted()) break;
    if (!queue.length) {
      if (feedDone) break;
      await sleep(2);
      continue;
    }
    const frame = queue.shift();
    try {
      const t = frame.timestamp;
      const keep = t >= inUs - 500 && t < outUs - 500;
      if (keep) {
        while (encoder.encodeQueueSize > encodeQueueCap && !aborted()) await sleep(5);
        if (aborted()) { frame.close(); break; }
        const sw = frame.displayWidth, sh = frame.displayHeight;
        const rot = ((clip.rotation || 0) % 360 + 360) % 360;
        const swap = rot === 90 || rot === 270;
        const vsw = swap ? sh : sw, vsh = swap ? sw : sh;
        const s = Math.min(canvas.width / vsw, canvas.height / vsh);
        const dw = Math.max(2, Math.round((vsw * s) / 2) * 2);
        const dh = Math.max(2, Math.round((vsh * s) / 2) * 2);
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        if (rot === 0) {
          ctx.drawImage(frame, Math.round((canvas.width - dw) / 2), Math.round((canvas.height - dh) / 2), dw, dh);
        } else {
          ctx.save();
          ctx.translate(canvas.width / 2, canvas.height / 2);
          ctx.rotate((rot * Math.PI) / 180);
          const rw = swap ? dh : dw, rh = swap ? dw : dh;
          ctx.drawImage(frame, -Math.round(rw / 2), -Math.round(rh / 2), rw, rh);
          ctx.restore();
        }
        const outFrame = new VideoFrame(canvas, { timestamp: startUs + (t - inUs) });
        encoder.encode(outFrame);
        outFrame.close();
        lastFrameUs = t;
        kept++;
        onFrameDone?.();
      }
    } finally {
      frame.close();
    }
  }
  for (const f of queue) { try { f.close(); } catch { /* already closed */ } }
  queue.length = 0;
  decoder.close();
  if (decodeError) throw decodeError;

  const endUs = startUs + (kept > 0 ? (lastFrameUs - inUs) : 0);
  return { kept, endUs };
}
