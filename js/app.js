import { analyzeFile, checkWebCodecsSupport, isMobileDevice } from './library.js';
import { createTimeline } from './timeline.js';
import { Preview } from './preview.js';
import { exportMovie } from './exporter.js';

const $ = (id) => document.getElementById(id);

function start() {
  if (typeof Log !== 'undefined' && Log.setLogLevel) Log.setLogLevel(4);

  const state = { clips: [], playhead: 0 };
  window.__vcState = state;
  let lastResultUrl = null;
  let lastResultBlob = null;
  let lastResultName = 'merged.mp4';
  let uploading = false;
  let exporting = false;

  const els = {
    compatWarning: $('compatWarning'),
    fileInput: $('fileInput'),
    btnUpload: $('btnUpload'),
    btnClear: $('btnClear'),
    uploadStatus: $('uploadStatus'),
    previewVideo: $('previewVideo'),
    btnPlay: $('btnPlay'),
    timeLabel: $('timeLabel'),
    clipLabel: $('clipLabel'),
    btnKeepBefore: $('btnKeepBefore'),
    btnKeepAfter: $('btnKeepAfter'),
    btnResetTrim: $('btnResetTrim'),
    selReference: $('selReference'),
    btnExport: $('btnExport'),
    progressWrap: $('progressWrap'),
    progressBar: $('progressBar'),
    progressText: $('progressText'),
    resultArea: $('resultArea'),
    resultVideo: $('resultVideo'),
    btnDownload: $('btnDownload'),
    btnShare: $('btnShare'),
    timeline: $('timeline'),
    playhead: $('playhead'),
  };

  const codecSupport = checkWebCodecsSupport();
  const codecsOk = codecSupport.ok;
  if (!codecsOk && codecSupport.missing.length) {
    els.compatWarning.innerHTML =
      `您的瀏覽器缺少必要的 <strong>${codecSupport.missing.join('、')}</strong>，無法匯出。請改用最新版 <strong>Chrome</strong> 或 <strong>Edge</strong>。`;
    els.compatWarning.classList.remove('hidden');
  }

  const mobile = isMobileDevice();
  if (mobile) {
    const lowScale = document.querySelector('input[name="scale"][value="50"]');
    const lowQ = document.querySelector('input[name="quality"][value="low"]');
    if (lowScale) lowScale.checked = true;
    if (lowQ) lowQ.checked = true;
  }

  const getTotal = () => state.clips.reduce((s, c) => s + Math.max(0, c.outPoint - c.inPoint), 0);

  function fmt(s) {
    if (!isFinite(s) || s < 0) s = 0;
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${String(sec).padStart(2, '0')}`;
  }

  function updateLabels(clip) {
    els.timeLabel.textContent = `${fmt(state.playhead)} / ${fmt(getTotal())}`;
    els.clipLabel.textContent = clip ? `目前片段：${clip.name}` : '';
  }

  const timelineCtl = createTimeline(els.timeline, els.playhead, {
    getClips: () => state.clips,
    getTotal,
    getPlayhead: () => state.playhead,
    seekTo,
    onReorder: afterStructureChange,
    onRemove: removeClip,
  });

  const preview = new Preview(els.previewVideo, {
    getClips: () => state.clips,
    getTotal,
    onTime: (t, clip) => {
      state.playhead = t;
      timelineCtl.updatePlayhead();
      updateLabels(clip);
    },
  });

  function seekTo(t) {
    const total = getTotal();
    state.playhead = Math.min(Math.max(0, t), total);
    preview.seek(state.playhead);
    timelineCtl.updatePlayhead();
    updateLabels();
  }

  function afterStructureChange() {
    timelineCtl.render();
    refreshReferenceSelect();
    updateExportEnabled();
    seekTo(Math.min(state.playhead, getTotal()));
  }

  function refreshReferenceSelect() {
    const sel = els.selReference;
    const prev = sel.value;
    sel.innerHTML = '';
    for (const clip of state.clips) {
      const opt = document.createElement('option');
      opt.value = String(clip.id);
      opt.textContent = `${clip.name}（${clip.width}×${clip.height}）`;
      sel.appendChild(opt);
    }
    if (prev && state.clips.some((c) => String(c.id) === prev)) sel.value = prev;
    else if (state.clips.length) sel.value = String(state.clips[0].id);
  }

  function updateExportEnabled() {
    els.btnExport.disabled = exporting || uploading || state.clips.length === 0 || !codecsOk;
  }

  async function handleFiles(fileList) {
    const files = Array.from(fileList);
    if (!files.length) return;
    uploading = true;
    updateExportEnabled();
    const errors = [];
    for (let i = 0; i < files.length; i++) {
      els.uploadStatus.textContent = `剖析中 (${i + 1}/${files.length})：${files[i].name}`;
      await new Promise((r) => setTimeout(r, 0));
      try {
        const clip = await analyzeFile(files[i]);
        state.clips.push(clip);
      } catch (e) {
        errors.push(e.message);
      }
    }
    uploading = false;
    els.uploadStatus.textContent = errors.length
      ? `完成，但有 ${errors.length} 個檔案被跳過：${errors.join('；')}`
      : `已加入 ${files.length} 段影片`;
    els.fileInput.value = '';
    timelineCtl.render();
    refreshReferenceSelect();
    updateExportEnabled();
    if (state.clips.length) seekTo(state.clips.length === files.length ? 0 : state.playhead);
  }

  function removeClip(id) {
    const idx = state.clips.findIndex((c) => c.id === id);
    if (idx < 0) return;
    URL.revokeObjectURL(state.clips[idx].url);
    state.clips.splice(idx, 1);
    if (!state.clips.length) preview.stop();
    afterStructureChange();
  }

  els.btnUpload.addEventListener('click', () => els.fileInput.click());
  els.fileInput.addEventListener('change', () => handleFiles(els.fileInput.files));

  els.btnClear.addEventListener('click', () => {
    if (exporting) return;
    for (const c of state.clips) URL.revokeObjectURL(c.url);
    state.clips = [];
    state.playhead = 0;
    preview.stop();
    els.uploadStatus.textContent = '';
    if (lastResultUrl) { URL.revokeObjectURL(lastResultUrl); lastResultUrl = null; }
    lastResultBlob = null;
    els.resultArea.classList.add('hidden');
    afterStructureChange();
  });

  els.btnPlay.addEventListener('click', () => {
    preview.toggle();
    els.btnPlay.textContent = preview.playing && !els.previewVideo.paused ? '⏸' : '▶';
  });
  els.previewVideo.addEventListener('pause', () => { els.btnPlay.textContent = '▶'; });
  els.previewVideo.addEventListener('play', () => { els.btnPlay.textContent = '⏸'; });

  function trimAtPlayhead(keep) {
    if (!state.clips.length) return;
    const loc = preview.locate(state.playhead);
    if (!loc) return;
    const clip = state.clips[loc.idx];
    if (!clip) return;
    const cut = clip.inPoint + loc.local;
    if (keep === 'before') {
      if (cut - clip.inPoint > 0.05) clip.outPoint = cut;
    } else {
      if (clip.outPoint - cut > 0.05) clip.inPoint = cut;
    }
    afterStructureChange();
  }

  els.btnKeepBefore.addEventListener('click', () => trimAtPlayhead('before'));
  els.btnKeepAfter.addEventListener('click', () => trimAtPlayhead('after'));
  els.btnResetTrim.addEventListener('click', () => {
    if (!state.clips.length) return;
    const loc = preview.locate(state.playhead);
    if (!loc) return;
    const clip = state.clips[loc.idx];
    if (!clip) return;
    clip.inPoint = 0;
    clip.outPoint = clip.duration;
    afterStructureChange();
  });

  els.btnExport.addEventListener('click', async () => {
    if (exporting || !state.clips.length) return;
    exporting = true;
    updateExportEnabled();
    els.progressWrap.classList.remove('hidden');
    els.progressBar.style.width = '0%';
    els.progressText.textContent = '0%';
    els.resultArea.classList.add('hidden');

    const refId = Number(els.selReference.value);
    const reference = state.clips.find((c) => c.id === refId) || state.clips[0];
    const scalePct = Number(document.querySelector('input[name="scale"]:checked').value);
    const quality = document.querySelector('input[name="quality"]:checked').value;

    try {
      const result = await exportMovie({
        clips: [...state.clips],
        reference,
        scalePct,
        quality,
        onProgress: (p) => {
          els.progressBar.style.width = `${Math.round(p * 100)}%`;
          els.progressText.textContent = `${Math.round(p * 100)}%`;
        },
      });
      if (lastResultUrl) URL.revokeObjectURL(lastResultUrl);
      lastResultUrl = URL.createObjectURL(result.blob);
      lastResultBlob = result.blob;
      lastResultName = `merged-${result.width}x${result.height}.mp4`;
      els.resultVideo.src = lastResultUrl;
      els.btnDownload.href = lastResultUrl;
      els.btnDownload.download = lastResultName;
      const canShare = typeof navigator.canShare === 'function' &&
        typeof File !== 'undefined' &&
        navigator.canShare({ files: [new File([result.blob], lastResultName, { type: 'video/mp4' })] });
      if (els.btnShare) els.btnShare.classList.toggle('hidden', !canShare);
      els.resultArea.classList.remove('hidden');
      els.resultVideo.play().catch(() => {});
    } catch (e) {
      console.error(e);
      alert(`匯出失敗：${e && e.message ? e.message : e}`);
    } finally {
      exporting = false;
      els.progressWrap.classList.add('hidden');
      updateExportEnabled();
    }
  });

  if (els.btnShare) {
    els.btnShare.addEventListener('click', async () => {
      if (!lastResultBlob) return;
      try {
        const file = new File([lastResultBlob], lastResultName, { type: 'video/mp4' });
        if (navigator.canShare && navigator.canShare({ files: [file] }) && navigator.share) {
          await navigator.share({ files: [file], title: lastResultName });
        }
      } catch (e) {
        if (e && e.name !== 'AbortError') console.error('分享失敗：', e);
      }
    });
  }

  updateLabels();
  updateExportEnabled();
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
}
