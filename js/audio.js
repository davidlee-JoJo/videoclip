const SR = 48000;
const SEG = 5 * SR;

let sharedCtx = null;
function getAudioCtx() {
  if (!sharedCtx) sharedCtx = new AudioContext({ sampleRate: SR });
  return sharedCtx;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function encodeAllAudio(clips, encoder, totalUs, onSegmentDone) {
  const audioCtx = getAudioCtx();
  let curUs = 0;

  for (const clip of clips) {
    const segDur = clip.outPoint - clip.inPoint;
    if (segDur <= 0.01) continue;
    let curSamples = Math.round((curUs / 1e6) * SR);
    let n = Math.round(segDur * SR);
    const maxSamples = Math.round(((totalUs - curUs) / 1e6) * SR);
    n = Math.min(n, Math.max(0, maxSamples));

    let audioBuf = null;
    if (clip.hasAudio && n > 0) {
      try {
        const buf = await clip.file.arrayBuffer();
        audioBuf = await audioCtx.decodeAudioData(buf);
      } catch {
        audioBuf = null;
      }
    }

    if (n > 0) {
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
