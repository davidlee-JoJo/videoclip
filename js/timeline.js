export function createTimeline(timelineEl, playheadEl, api) {
  const { getClips, getTotal, getPlayhead, seekTo, onReorder, onRemove } = api;
  let dragId = null;
  let suppressSeekClick = 0;

  timelineEl.appendChild(playheadEl);

  function fmt(s) {
    if (!isFinite(s) || s < 0) s = 0;
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${String(sec).padStart(2, '0')}`;
  }

  function kept(c) {
    return Math.max(0, c.outPoint - c.inPoint);
  }

  function globalAt(idx, offset) {
    const clips = getClips();
    let t = 0;
    for (let i = 0; i < idx; i++) t += kept(clips[i]);
    return t + Math.min(offset, kept(clips[idx] || { outPoint: 0, inPoint: 0 }));
  }

  function moveClip(fromId, toId) {
    const clips = getClips();
    const fi = clips.findIndex((c) => c.id === fromId);
    const ti = clips.findIndex((c) => c.id === toId);
    if (fi < 0 || ti < 0 || fi === ti) return;
    const [c] = clips.splice(fi, 1);
    clips.splice(ti, 0, c);
    onReorder();
  }

  function seekFromClientX(clientX) {
    const r = timelineEl.getBoundingClientRect();
    const pad = 5;
    const frac = Math.min(1, Math.max(0, (clientX - r.left - pad) / Math.max(1, r.width - pad * 2)));
    seekTo(frac * getTotal());
  }

  function bindStripDragSeek(e) {
    if (!getClips().length) return;
    e.preventDefault();
    seekFromClientX(e.clientX);
    const move = (ev) => seekFromClientX(ev.clientX);
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  playheadEl.addEventListener('pointerdown', bindStripDragSeek);
  timelineEl.addEventListener('pointerdown', (e) => {
    if (e.target === playheadEl || e.target.closest('.clip-block')) return;
    bindStripDragSeek(e);
  });

  function render() {
    timelineEl.querySelectorAll('.clip-block').forEach((n) => n.remove());
    const clips = getClips();
    const empty = document.getElementById('emptyState');
    if (empty) empty.classList.toggle('hidden', clips.length > 0);
    playheadEl.classList.toggle('hidden', clips.length === 0);

    clips.forEach((clip, idx) => {
      const block = document.createElement('div');
      block.className = 'clip-block';
      block.draggable = true;
      block.dataset.id = String(clip.id);
      block.style.flexGrow = String(Math.max(kept(clip), 0.06));
      if (kept(clip) <= 0.05) block.classList.add('empty-clip');

      const win = document.createElement('div');
      win.className = 'kept-window';
      if (clip.thumb) win.style.backgroundImage = `url(${clip.thumb})`;
      block.appendChild(win);

      const name = document.createElement('span');
      name.className = 'clip-name';
      name.textContent = `${clip.name}｜${fmt(clip.inPoint)}–${fmt(clip.outPoint)} / ${fmt(clip.duration)}`;
      block.appendChild(name);

      const rm = document.createElement('button');
      rm.className = 'clip-remove';
      rm.textContent = '×';
      rm.title = '移除這段影片';
      rm.addEventListener('pointerdown', (e) => e.stopPropagation());
      rm.addEventListener('click', (e) => {
        e.stopPropagation();
        onRemove(clip.id);
      });
      block.appendChild(rm);

      const mvGroup = document.createElement('div');
      mvGroup.className = 'clip-move-group';
      [['◀', -1, '向前移動'], ['▶', 1, '向後移動']].forEach(([txt, dir, tip]) => {
        const mb = document.createElement('button');
        mb.className = 'clip-move';
        mb.textContent = txt;
        mb.title = tip;
        mb.addEventListener('pointerdown', (e) => e.stopPropagation());
        mb.addEventListener('click', (e) => {
          e.stopPropagation();
          e.preventDefault();
          const clips = getClips();
          const i = clips.findIndex((c) => c.id === clip.id);
          const j = i + dir;
          if (j < 0 || j >= clips.length || i < 0) return;
          moveClip(clip.id, clips[j].id);
        });
        mvGroup.appendChild(mb);
      });
      block.appendChild(mvGroup);

      block.addEventListener('pointerdown', (e) => {
        if (e.pointerType !== 'touch') return;
        if (e.target.closest('button')) return;
        const startX = e.clientX;
        const startY = e.clientY;
        let mode = 'pending';
        let targetBlock = null;
        const finish = () => {
          clearTimeout(timer);
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
          window.removeEventListener('pointercancel', up);
          block.classList.remove('dragging');
          timelineEl.querySelectorAll('.drop-target').forEach((n) => n.classList.remove('drop-target'));
          targetBlock = null;
        };
        const timer = setTimeout(() => {
          if (mode !== 'pending') return;
          mode = 'reorder';
          suppressSeekClick = Date.now() + 500;
          block.classList.add('dragging');
          block.classList.add('drop-target');
          if (navigator.vibrate) { try { navigator.vibrate(25); } catch { /* noop */ } }
        }, 320);
        const move = (ev) => {
          const dx = ev.clientX - startX;
          const dy = ev.clientY - startY;
          if (mode === 'pending') {
            if (Math.abs(dx) > 10 || Math.abs(dy) > 10) {
              clearTimeout(timer);
              mode = 'seek';
              seekFromClientX(ev.clientX);
            }
            return;
          }
          if (mode === 'seek') { seekFromClientX(ev.clientX); return; }
          const under = document.elementFromPoint(ev.clientX, ev.clientY);
          const tb = under && under.closest ? under.closest('.clip-block') : null;
          if (targetBlock && targetBlock !== tb) targetBlock.classList.remove('drop-target');
          if (tb && tb !== block) {
            tb.classList.add('drop-target');
            targetBlock = tb;
          } else if (!tb) {
            targetBlock = null;
          }
        };
        const up = () => {
          const dropId = mode === 'reorder' && targetBlock ? Number(targetBlock.dataset.id) : null;
          finish();
          if (dropId && dropId !== clip.id) moveClip(clip.id, dropId);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
        window.addEventListener('pointercancel', up);
      });


      block.addEventListener('dragstart', (e) => {
        dragId = clip.id;
        block.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', String(clip.id));
      });
      block.addEventListener('dragend', () => {
        block.classList.remove('dragging');
        dragId = null;
        timelineEl.querySelectorAll('.drop-target').forEach((n) => n.classList.remove('drop-target'));
      });
      block.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        block.classList.add('drop-target');
      });
      block.addEventListener('dragleave', () => block.classList.remove('drop-target'));
      block.addEventListener('drop', (e) => {
        e.preventDefault();
        block.classList.remove('drop-target');
        if (dragId != null && dragId !== clip.id) moveClip(dragId, clip.id);
      });
      block.addEventListener('click', (e) => {
        if (e.target.closest('.clip-remove') || e.target.closest('.clip-move')) return;
        if (Date.now() < suppressSeekClick) return;
        const r = block.getBoundingClientRect();
        const ratio = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
        seekTo(globalAt(idx, ratio * kept(clip)));
      });

      timelineEl.appendChild(block);
    });
    updatePlayhead();
  }

  function updatePlayhead() {
    const total = getTotal();
    if (!getClips().length || total <= 0) return;
    const frac = Math.min(1, Math.max(0, getPlayhead() / total));
    const pad = 5;
    const x = pad + frac * Math.max(0, timelineEl.clientWidth - pad * 2);
    playheadEl.style.left = `${x}px`;
  }

  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(() => updatePlayhead()).observe(timelineEl);
  }

  return { render, updatePlayhead };
}
