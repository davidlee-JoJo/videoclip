const SR = 48000;

let sharedCtx = null;
function getAudioCtx() {
  if (!sharedCtx) sharedCtx = new AudioContext({ sampleRate: SR });
  return sharedCtx;
}

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
    if (clip.hasAudio) {
      try {
        audioBuf = await audioCtx.decodeAudioData(await clip.file.arrayBuffer());
      } catch {
        audioBuf = null;
      }
    }

    if (n > 0) {
      const data = new Float32Array(n * 2);
      if (audioBuf && audioBuf.length > 0) {
        const ch0 = audioBuf.getChannelData(0);
        const ch1 = audioBuf.numberOfChannels > 1 ? audioBuf.getChannelData(1) : ch0;
        const ratio = audioBuf.sampleRate / SR;
        const startSamp = Math.round(clip.inPoint * audioBuf.sampleRate);
        for (let i = 0; i < n; i++) {
          const src = startSamp + Math.round(i * ratio);
          data[i] = ch0[src] || 0;
          data[n + i] = ch1[src] || 0;
        }
      }
      const audioData = new AudioData({
        format: 'f32-planar',
        sampleRate: SR,
        numberOfFrames: n,
        numberOfChannels: 2,
        timestamp: curSamples,
        data,
      });
      encoder.encode(audioData);
      audioData.close();
    }
    curUs = Math.round(curUs + segDur * 1e6);
    onSegmentDone?.();
  }
  await encoder.flush();
}
