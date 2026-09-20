import { extractAvcCDescription, extractHvcCDescription, avcCodecString, hevcCodecString } from './library.js';

function resolveVideoConfig(clip) {
  if (clip.videoCodec && clip.codecString && clip.description) {
    return { type: clip.videoCodec, codec: clip.codecString, description: clip.description };
  }
  return null;
}

export async function demuxVideo(clip) {
  const file = clip.file;
  let cfg = resolveVideoConfig(clip);
  let raw = await file.arrayBuffer();
  if (!cfg) {
    const scanRange = raw.byteLength > 20 * 1024 * 1024
      ? new Uint8Array(raw, 0, Math.min(raw.byteLength, 4 * 1024 * 1024))
      : new Uint8Array(raw);
    const tailRange = new Uint8Array(raw, Math.max(0, raw.byteLength - 4 * 1024 * 1024));
    const avc = extractAvcCDescription(scanRange) || extractAvcCDescription(tailRange);
    const hvc = extractHvcCDescription(scanRange) || extractHvcCDescription(tailRange);
    if (avc) cfg = { type: 'avc', codec: avcCodecString(avc), description: avc };
    else if (hvc) cfg = { type: 'hevc', codec: hevcCodecString(hvc), description: hvc };
    else throw new Error(`${file.name}：匯出時找不到 avcC / hvcC 設定`);
  }

  const mp4 = MP4Box.createFile();
  const info = await new Promise((resolve, reject) => {
    let done = false;
    mp4.onReady = (i) => { done = true; resolve(i); };
    mp4.onError = (e) => reject(new Error('mp4box 錯誤：' + JSON.stringify(e)));
    raw.fileStart = 0;
    mp4.appendBuffer(raw);
    mp4.flush();
    setTimeout(() => { if (!done) reject(new Error('mp4box 無法解析檔案')); }, 0);
  });

  const track = info.videoTracks[0];
  const total = track.nb_samples;
  const samples = [];
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (samples.length === 0) reject(new Error(`${file.name}：無法提取視訊樣本`));
      else resolve();
    }, 30000);
    mp4.onSamples = (id, user, s) => {
      if (id === track.id) {
        for (const one of s) {
          if (!(one.data instanceof Uint8Array) || one.data.buffer === raw?.buffer) {
            one.data = new Uint8Array(one.data);
          }
        }
        samples.push(...s);
        if (samples.length >= total) {
          clearTimeout(timer);
          resolve();
        }
      }
    };
    try {
      mp4.setExtractionOptions(track.id, null, { nbSamples: Infinity });
    } catch { /* older mp4box */ }
    mp4.start();
    if (samples.length >= total) {
      clearTimeout(timer);
      resolve();
    }
  });

  try { mp4.stop(); } catch { /* noop */ }
  try { mp4.releaseUsedSamples(track.id); } catch { /* noop */ }
  try { if (mp4.stream) mp4.stream.buffers = []; } catch { /* noop */ }
  mp4.onSamples = null;
  mp4.onReady = null;
  mp4.onError = null;
  raw = null;

  return {
    samples,
    timescale: track.timescale,
    description: cfg.description,
    codec: cfg.codec,
    type: cfg.type,
  };
}

function chunkFromSample(sample, timescale) {
  return new EncodedVideoChunk({
    type: sample.is_sync ? 'key' : 'delta',
    timestamp: Math.round((sample.cts * 1e6) / timescale),
    duration: Math.round((sample.duration * 1e6) / timescale),
    data: sample.data,
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function decodeAndEncode(clip, ctxObj) {
  const { startUs, encoder, canvas, ctx, muxer, onFrameDone, onFeedProgress, isErrored } = ctxObj;
  const { samples, timescale, description, codec } = await demuxVideo(clip);
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
        for (const s of samples.slice(i, i + CHUNK)) decoder.decode(chunkFromSample(s, timescale));
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
