import { decodeAndEncode } from './decoder.js';
import { encodeAllAudio } from './audio.js';
import { diagMark, diagPct } from './diag.js';

const BPP = { high: 0.15, medium: 0.1, low: 0.06 };
const AUDIO_BR = { high: 192000, medium: 128000, low: 96000 };

function even(v) {
  const r = Math.round(v);
  return r % 2 === 0 ? r : r + (r > 0 ? 1 : -1);
}

// H.264 level_idc values (hex) ascending: 4.0,4.1,4.2,5.0,5.1,5.2
const AVC_LEVELS = ['28', '29', '2a', '32', '33', '34'];

async function pickCodec(trials) {
  const diag = [];
  for (const t of trials) {
    let codec = '';
    try {
      const cfg = t.probe();
      codec = cfg.codec;
      const res = await (t.kind === 'video' ? VideoEncoder : AudioEncoder).isConfigSupported(cfg);
      if (res.supported) return { pick: { cfg, muxerName: t.muxerName, label: t.label }, diag };
      diag.push(`${t.label}(${codec}):not-supported`);
    } catch (e) {
      diag.push(`${t.label}(${codec}):${e && e.message ? e.message : e}`);
    }
  }
  return { pick: null, diag };
}

function buildVideoTrials(outW, outH, bitrate, fps) {
  const trials = [];
  const mk = (codec, muxerName, label) => ({
    kind: 'video', muxerName, label,
    probe: () => ({ codec, width: outW, height: outH, bitrate, framerate: fps }),
  });
  for (const lv of AVC_LEVELS) trials.push(mk(`avc1.6400${lv}`, 'avc', 'H.264'));
  for (const lv of AVC_LEVELS) trials.push(mk(`avc1.4d00${lv}`, 'avc', 'H.264'));
  trials.push(mk('vp9', 'vp9', 'VP9'));
  trials.push(mk('av1', 'av1', 'AV1'));
  return trials;
}

export async function exportMovie({ clips, reference, scalePct, quality, onProgress, maxOutputSide = 0, memBudgetBytes, maxFps = 60, forceSoftwareEncoder = false }) {
  const baseW = reference.width, baseH = reference.height;
  let outW = even(baseW * scalePct / 100);
  let outH = even(baseH * scalePct / 100);
  if (maxOutputSide > 0 && Math.max(outW, outH) > maxOutputSide) {
    const r = maxOutputSide / Math.max(outW, outH);
    outW = even(outW * r);
    outH = even(outH * r);
  }
  const fps = Math.min(Math.max(Math.round(reference.fps) || 30, 10), maxFps);
  const videoBitrate = Math.min(Math.max(Math.round(outW * outH * fps * BPP[quality]), 400_000), 80_000_000);
  const audioBitrate = AUDIO_BR[quality];
  diagMark('probe-video', { outW, outH, fps, bitrate: videoBitrate, hw: !forceSoftwareEncoder });

  const videoRes = await pickCodec(buildVideoTrials(outW, outH, videoBitrate, fps));
  if (!videoRes.pick) {
    throw new Error(
      `找不到可用的影片編碼器（輸出 ${outW}×${outH} @ ${fps}fps）。` +
      `可嘗試：改用較低解析度（50%），或最新版 Chrome/Edge。` +
      `\n診斷：${videoRes.diag.join(', ')}`
    );
  }
  const videoPick = videoRes.pick;
  diagMark('probe-audio', { codec: undefined });

  const audioRes = await pickCodec([
    { kind: 'audio', muxerName: 'aac', label: 'AAC', probe: () => ({ codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2, bitrate: audioBitrate }) },
    { kind: 'audio', muxerName: 'opus', label: 'Opus', probe: () => ({ codec: 'opus', sampleRate: 48000, numberOfChannels: 2, bitrate: audioBitrate }) },
  ]);
  const audioPick = audioRes.pick;

  const { Muxer, ArrayBufferTarget, StreamTarget } = Mp4Muxer;
  const useStreamingTarget = typeof StreamTarget === 'function' && typeof Blob === 'function';
  let muxer;
  let finalizeBlob;
  if (useStreamingTarget) {
    const parts = [];
    let totalLen = 0;
    const target = new StreamTarget({
      onData: (data, position) => {
        const copy = data instanceof Uint8Array ? data.slice(0) : new Uint8Array(data.slice(0));
        let pos = typeof position === 'number' ? position : totalLen;
        if (pos >= totalLen) {
          parts.push({ buf: copy, off: pos });
          totalLen = pos + copy.length;
          return;
        }
        let done = 0;
        for (let i = 0; i < parts.length && done < copy.length; i++) {
          const p = parts[i];
          const pEnd = p.off + p.buf.length;
          if (pos >= p.off && pos < pEnd) {
            const n = Math.min(copy.length - done, pEnd - pos);
            p.buf.set(copy.subarray(done, done + n), pos - p.off);
            pos += n;
            done += n;
          }
        }
      },
    });
    muxer = new Muxer({
      target,
      fastStart: false,
      firstTimestampBehavior: 'offset',
      video: { codec: videoPick.muxerName, width: outW, height: outH, frameRate: fps },
      audio: audioPick ? { codec: audioPick.muxerName, numberOfChannels: 2, sampleRate: 48000 } : undefined,
    });
    finalizeBlob = () => {
      muxer.finalize();
      const blob = new Blob(parts.map((p) => p.buf), { type: 'video/mp4' });
      parts.length = 0;
      return blob;
    };
  } else {
    const target = new ArrayBufferTarget();
    muxer = new Muxer({
      target,
      fastStart: 'in-memory',
      firstTimestampBehavior: 'offset',
      video: { codec: videoPick.muxerName, width: outW, height: outH, frameRate: fps },
      audio: audioPick ? { codec: audioPick.muxerName, numberOfChannels: 2, sampleRate: 48000 } : undefined,
    });
    finalizeBlob = () => {
      muxer.finalize();
      return new Blob([muxer.target.buffer], { type: 'video/mp4' });
    };
  }

  const activeClips = clips.filter(c => c.outPoint - c.inPoint > 0.05);
  const totalKept = activeClips.reduce((s, c) => s + (c.outPoint - c.inPoint), 0);
  if (totalKept <= 0.1) throw new Error('所有片段都被剪掉了，沒有內容可匯出');

  const estFrames = Math.max(1, Math.round(activeClips.reduce((s, c) => s + (c.outPoint - c.inPoint) * (c.fps || 30), 0)));
  let framesDone = 0;
  let feedFrac = 0;
  const report = (audioFrac = 0) => {
    const frameProg = (framesDone / estFrames) * 0.9;
    const feedProg = feedFrac * 0.45;
    const frac = Math.min(0.95, Math.max(frameProg, feedProg)) + audioFrac * 0.05;
    diagPct(frac);
    onProgress?.(frac);
  };

  const canvas = new OffscreenCanvas(outW, outH);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, outW, outH);

  const gop = Math.max(1, Math.round(fps * 2));
  let frameSeq = 0;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => { encoderError = e; },
  });
  let encoderError = null;
  const hwRequested = !forceSoftwareEncoder;
  const encCfgBase = {
    ...videoPick.cfg,
    bitrateMode: 'variable',
    avc: videoPick.muxerName === 'avc' ? { format: 'avc' } : undefined,
  };
  try {
    encoder.configure({ ...encCfgBase, hardwareAcceleration: forceSoftwareEncoder ? 'prefer-software' : 'no-preference' });
  } catch (e) {
    if (!forceSoftwareEncoder) throw e;
    encoder.configure({ ...encCfgBase, hardwareAcceleration: 'no-preference' });
    forceSoftwareEncoder = false;
  }
  diagMark('mux-init', { codec: videoPick.cfg.codec, hwReq: hwRequested, hw: !forceSoftwareEncoder });

  let startUs = 0;
  for (const clip of activeClips) {
    if (encoderError) throw encoderError;
    diagMark('encode-clip', { clip: clip.name, frames: Math.round((clip.outPoint - clip.inPoint) * (clip.fps || 30)) });
    const wrappedEncoder = {
      encode: (frame) => {
        encoder.encode(frame, { keyFrame: frameSeq % gop === 0 });
        frameSeq++;
      },
      get encodeQueueSize() { return encoder.encodeQueueSize; },
    };
    await decodeAndEncode(clip, {
      startUs,
      encoder: wrappedEncoder,
      canvas,
      ctx,
      muxer,
      memBudgetBytes,
      onFrameDone: () => { framesDone++; report(); },
      onFeedProgress: (f) => { feedFrac = Math.max(feedFrac, f); report(); },
      isErrored: () => !!encoderError,
    });
    startUs += Math.round((clip.outPoint - clip.inPoint) * 1e6);
    report();
    await new Promise((r) => setTimeout(r, 0));
  }
  diagMark('flush');
  await encoder.flush();
  if (encoderError) throw encoderError;

  const totalUs = startUs;

  if (audioPick) {
    diagMark('audio');
    const audioEncoder = new AudioEncoder({
      output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
      error: (e) => { audioEncoderError = e; },
    });
    let audioEncoderError = null;
    audioEncoder.configure(audioPick.cfg);
    let segDone = 0;
    await encodeAllAudio(activeClips, audioEncoder, totalUs, () => {
      segDone++;
      onProgress?.(0.95 + (segDone / activeClips.length) * 0.04);
    });
    if (audioEncoderError) throw audioEncoderError;
  }

  onProgress?.(0.99);
  diagMark('mux-finalize');
  const blob = finalizeBlob();
  onProgress?.(1);
  return { blob, width: outW, height: outH };
}
