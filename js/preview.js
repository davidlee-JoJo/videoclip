export class Preview {
  constructor(videoEl, api) {
    const { getClips, getTotal, onTime } = api;
    this.v = videoEl;
    this.getClips = getClips;
    this.getTotal = getTotal;
    this.onTime = onTime;
    this.idx = -1;
    this.loadedId = null;
    this.pending = null;
    this.playing = false;

    this.v.addEventListener('loadedmetadata', () => {
      if (this.pending !== null) {
        try { this.v.currentTime = this.pending; } catch { /* noop */ }
        this.pending = null;
        if (this.playing) this.v.play().catch(() => {});
      }
    });

    this._tick = this._tick.bind(this);
    requestAnimationFrame(this._tick);
  }

  keptDur(c) {
    return Math.max(0, c.outPoint - c.inPoint);
  }

  sumBefore(idx) {
    const clips = this.getClips();
    let t = 0;
    for (let i = 0; i < idx && i < clips.length; i++) t += this.keptDur(clips[i]);
    return t;
  }

  locate(global) {
    const clips = this.getClips();
    if (!clips.length) return null;
    let t = global;
    for (let i = 0; i < clips.length; i++) {
      const d = this.keptDur(clips[i]);
      if (t < d - 1e-6 || i === clips.length - 1) return { idx: i, local: Math.min(t, d) };
      t -= d;
    }
    return { idx: clips.length - 1, local: this.keptDur(clips[clips.length - 1]) };
  }

  loadClip(idx, localTime) {
    const clips = this.getClips();
    const clip = clips[idx];
    if (!clip) return;
    this.idx = idx;
    const vt = clip.inPoint + localTime + 0.01;
    if (this.loadedId !== clip.id) {
      this.loadedId = clip.id;
      this.pending = vt;
      this.v.src = clip.url;
      this.v.load();
    } else {
      try { this.v.currentTime = vt; } catch { /* noop */ }
      if (this.playing) this.v.play().catch(() => {});
    }
  }

  seek(global) {
    const clips = this.getClips();
    if (!clips.length) {
      this.stop();
      return;
    }
    const total = this.getTotal();
    const loc = this.locate(Math.min(Math.max(global, 0), total));
    this.loadClip(loc.idx, loc.local);
    this.onTime(Math.min(Math.max(global, 0), total), clips[loc.idx]);
  }

  stop() {
    this.playing = false;
    this.idx = -1;
    this.loadedId = null;
    this.v.removeAttribute('src');
    this.v.load();
    this.v.pause();
  }

  play() {
    const clips = this.getClips();
    if (!clips.length) return;
    if (this.v.paused && (this.idx < 0 || this.v.ended)) this.seek(0);
    this.playing = true;
    this.v.play().catch(() => {});
  }

  pause() {
    this.playing = false;
    this.v.pause();
  }

  toggle() {
    if (this.playing && !this.v.paused) this.pause();
    else this.play();
  }

  _tick() {
    const clips = this.getClips();
    if (this.playing && clips.length && this.idx >= 0 && !this.v.paused) {
      const clip = clips[this.idx];
      if (!clip || this.loadedId !== clip.id) {
        this.loadClip(Math.max(0, Math.min(this.idx, clips.length - 1)), 0);
      } else if (this.v.readyState >= 2 && this.v.currentTime >= clip.outPoint - 0.04) {
        const next = this.idx + 1;
        if (next < clips.length && this.keptDur(clips[next]) > 0.05) {
          this.loadClip(next, 0);
        } else if (next < clips.length) {
          this.idx = next;
        } else {
          this.playing = false;
          this.v.pause();
          this.onTime(this.getTotal(), clip);
        }
      } else {
        this.onTime(this.sumBefore(this.idx) + Math.max(0, this.v.currentTime - clip.inPoint), clip);
      }
    }
    requestAnimationFrame(this._tick);
  }
}
