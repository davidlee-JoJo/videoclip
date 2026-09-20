import { diagMark } from './diag.js';
import { getAudioTrackInfo } from './library.js';

const SR = 48000;
const SEG = 5 * SR;
const FALLBACK_MAX_BYTES = 300 * 1024 * 1024;

let sharedCtx = null;
function getAudioCtx() {
  if (!sharedCtx) sharedCtx = new AudioContext({ sampleRate: SR });
  return sharedCtx;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function encodeClipAudioAAC(clip, encoder, startSample, outSamplesMax) {
  if (typeof AudioDecoder === 'undefined' || typeof EncodedAudioChunk === 'undefined') return false;
  const track = await getAudioTrackInfo(clip.file);
  if (!track) return false;
  const srcRate = track.sampleRate;
  const ch = track.channelCount;
  const cfg = { codec: 'mp4a.40.2', sampleRate: srcRate, numberOfChannels: ch, description: track.description };
  let support = null;
  try { support = await AudioDecoder.isConfigSupported(cfg); } catch { return false; }
  if (!support || !support.supported) return false;

  const ts = track.timescale || srcRate;
  const winInS = clip.inPoint * ts;
  const winEndS = clip.outPoint * ts;
  let i0 = 0;
  while (i0 < track.samples.length && (track.samples[i0].cts + track.samples[i0].duration) <= winInS) i0++;
  let iEnd = track.samples.length - 1;
  while (iEnd >= 0 && track.samples[iEnd].cts >= winEndS) iEnd--;
  if (i0 > iEnd) return true;
  const totalOut = Math.min(outSamplesMax, Math.round((clip.outPoint - clip.inPoint) * SR));
  if (totalOut <= 0) return true;
  const ratio = SR / ts;

  const frameQ = [];
  let decodeError = null;
  let feedDone = false;
  let wroteAny = false;

  const decoder = new AudioDecoder({
    output: (f) => frameQ.push(f),
    error: (e) => { decodeError = decodeError || e; },
  });
  try {
    decoder.configure(cfg);
  } catch {
    try { decoder.close(); } catch { /* noop */ }
    return false;
  }

  (async () => {
    try {
      for (let i = i0; i <= iEnd; i++) {
        const s = track.samples[i];
        while (frameQ.length > 96 && !decodeError) await sleep(3);
        if (decodeError) break;
        const bytes = new Uint8Array(await clip.file.slice(s.offset, s.offset + s.size).arrayBuffer());
        decoder.decode(new EncodedAudioChunk({
          type: s.is_sync === false ? 'delta' : 'key',
          timestamp: Math.round((s.cts * 1e6) / ts),
          duration: Math.round((s.duration * 1e6) / ts),
          data: bytes,
        }));
      }
      await decoder.flush();
    } catch (e) {
      decodeError = decodeError || e;
    } finally {
      feedDone = true;
    }
  })();

  const pending = new Float32Array(SEG * 2);
  let segBase = 0;
  let filledEnd = 0;

  const flushPending = async (cnt) => {
    if (cnt <= 0) return;
    const data = new Float32Array(cnt * 2);
    data.set(pending.subarray(0, cnt), 0);
    data.set(pending.subarray(SEG, SEG + cnt), cnt);
    const ad = new AudioData({
      format: 'f32-planar',
      sampleRate: SR,
      numberOfFrames: cnt,
      numberOfChannels: 2,
      timestamp: startSample + segBase,
      data,
    });
    while (encoder.encodeQueueSize > 24) await sleep(5);
    encoder.encode(ad);
    ad.close();
    wroteAny = true;
    pending.fill(0, 0, cnt);
    pending.fill(0, SEG, SEG + cnt);
  };

  const planeToFloat = (f, planeIdx, n, fmt) => {
    const base = fmt.replace(/-planar$/, '');
    const per = base === 'f32' ? 4 : base === 's16' ? 2 : base === 'u8' ? 1 : base === 's32' ? 4 : 0;
    if (per === 0) return null;
    const view = new Uint8Array(n * per);
    f.copyTo(view, { planeIndex: planeIdx, layout: 'planar' });
    if (base === 'f32') return new Float32Array(view.buffer, view.byteOffset, n);
    if (base === 's16') {
      const s16 = new Int16Array(view.buffer, view.byteOffset, n);
      const out = new Float32Array(n);
      for (let j = 0; j < n; j++) out[j] = s16[j] / 32768;
      return out;
    }
    if (base === 's32') {
      const s32 = new Int32Array(view.buffer, view.byteOffset, n);
      const out = new Float32Array(n);
      for (let j = 0; j < n; j++) out[j] = s32[j] / 2147483648;
      return out;
    }
    const out = new Float32Array(n);
    for (let j = 0; j < n; j++) out[j] = (view[j] - 128) / 128;
    return out;
  };

  try {
    while (true) {
      if (!frameQ.length) {
        if (feedDone || decodeError) break;
        await sleep(3);
        continue;
      }
      const f = frameQ.shift();
      try {
        const n = f.numberOfFrames;
        const fmt = f.format;
        const chCount = Math.max(1, f.numberOfChannels);
        const L = planeToFloat(f, 0, n, fmt);
        const R = planeToFloat(f, Math.min(1, chCount - 1), n, fmt);
        if (!L || !R) { decodeError = decodeError || new Error('不支援的音訊格式：' + fmt); continue; }
        const baseTs = (f.timestamp * ts) / 1e6;
        for (let j = 0; j < n; j++) {
          const t = baseTs + j;
          if (t < winInS) continue;
          if (t >= winEndS) break;
          const outIdx = Math.round((t - winInS) * ratio);
          if (outIdx >= totalOut) break;
          let rel = outIdx - segBase;
          while (rel >= SEG) {
            await flushPending(SEG);
            segBase += SEG;
            rel = outIdx - segBase;
          }
          pending[rel] = L[j] || 0;
          pending[SEG + rel] = R[j] || 0;
          if (outIdx + 1 > filledEnd) filledEnd = outIdx + 1;
        }
      } finally {
        try { f.close(); } catch { /* noop */ }
      }
    }
    const tail = filledEnd - segBase;
    if (tail > 0) await flushPending(tail);
  } finally {
    while (frameQ.length) {
      const f = frameQ.shift();
      try { f.close(); } catch { /* noop */ }
    }
    try { decoder.close(); } catch { /* noop */ }
  }

  if (decodeError) return wroteAny;
  return true;
}

export async function encodeAllAudio(clips, encoder, totalUs, onSegmentDone) {
  let curUs = 0;

  for (const clip of clips) {
    const segDur = clip.outPoint - clip.inPoint;
    if (segDur <= 0.01) continue;
    const curSamples = Math.round((curUs / 1e6) * SR);
    let n = Math.round(segDur * SR);
    const maxSamples = Math.round(((totalUs - curUs) / 1e6) * SR);
    n = Math.min(n, Math.max(0, maxSamples));

    let handled = false;
    if (clip.hasAudio && n > 0) {
      try {
        handled = await encodeClipAudioAAC(clip, encoder, curSamples, n);
      } catch {
        handled = false;
      }
      if (handled) {
        clip.__audioPath = 'webcodecs-aac';
        diagMark('audio', { clip: clip.name, path: 'webcodecs-aac' });
      }
    }

    let audioBuf = null;
    if (!handled && clip.hasAudio && n > 0) {
      if (clip.file.size <= FALLBACK_MAX_BYTES) {
        clip.__audioPath = 'decode-audio-data';
        diagMark('audio', { clip: clip.name, path: 'decode-audio-data' });
        try {
          audioBuf = await getAudioCtx().decodeAudioData(clip.file);
        } catch {
          try {
            const buf = await clip.file.arrayBuffer();
            audioBuf = await getAudioCtx().decodeAudioData(buf);
          } catch {
            audioBuf = null;
          }
        }
      } else {
        clip.__audioPath = 'skipped-large';
        diagMark('audio', { clip: clip.name, path: 'skipped-large' });
      }
    }

    if (!handled && n > 0) {
      const multi = audioBuf && audioBuf.length > 0;
      const ch0 = multi ? audioBuf.getChannelData(0) : null;
      const ch1 = multi && audioBuf.numberOfChannels > 1 ? audioBuf.getChannelData(1) : ch0;
      const ratio = multi ? audioBuf.sampleRate / SR : 0;
      const startSamp = multi ? Math.round(clip.inPoint * audioBuf.sampleRate) : 0;
      for (let off = 0; off < n; off += SEG) {
        const cnt = Math.min(SEG, n - off);
        const data = new Float32Array(cnt * 2);
        if (ch0) {
          for (let i = 0; i < cnt; i++) {
            const src = startSamp + Math.round((off + i) * ratio);
            data[i] = ch0[src] || 0;
            data[cnt + i] = (ch1 ? ch1[src] : ch0[src]) || 0;
          }
        }
        const audioData = new AudioData({
          format: 'f32-planar',
          sampleRate: SR,
          numberOfFrames: cnt,
          numberOfChannels: 2,
          timestamp: curSamples + off,
          data,
        });
        while (encoder.encodeQueueSize > 24) await sleep(5);
        encoder.encode(audioData);
        audioData.close();
        await sleep(0);
      }
    }
    audioBuf = null;
    curUs = Math.round(curUs + segDur * 1e6);
    onSegmentDone?.();
  }
  await encoder.flush();
}
