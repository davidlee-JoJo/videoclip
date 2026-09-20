const KEY = 'vc_diag_v1';

const STAGE_LABELS = {
  start: '準備中',
  'probe-video': '偵測影片編碼器',
  'probe-audio': '偵測音訊編碼器',
  'mux-init': '初始化混流器',
  'encode-clip': '解碼＋編碼影片',
  flush: '等待編碼排空',
  audio: '編碼音訊',
  'mux-finalize': '組裝 MP4 檔案',
  done: '完成',
};

function load() {
  try {
    const s = localStorage.getItem(KEY);
    return s ? JSON.parse(s) : null;
  } catch {
    return null;
  }
}

function save(st) {
  try {
    localStorage.setItem(KEY, JSON.stringify(st));
  } catch {
    /* private mode or quota: diagnostics are best-effort */
  }
}

let lastPctWritten = -1;

export function diagStart(meta) {
  const prev = load();
  const history = (prev && prev.history) || [];
  const st = {
    meta: meta || null,
    stage: 'start',
    pct: 0,
    extra: null,
    ts: Date.now(),
    startedTs: Date.now(),
    history: history.slice(-6),
  };
  lastPctWritten = 0;
  save(st);
  return st;
}

export function diagMark(stage, extra) {
  const st = load();
  if (!st || st.stage === 'done') return;
  st.stage = stage;
  st.extra = extra || null;
  st.ts = Date.now();
  save(st);
}

export function diagPct(p) {
  if (lastPctWritten >= 0 && Math.abs(p - lastPctWritten) < 0.03) return;
  lastPctWritten = p;
  const st = load();
  if (!st || st.stage === 'done') return;
  st.pct = p;
  st.ts = Date.now();
  save(st);
}

export function diagDone() {
  const st = load();
  if (!st) return;
  st.stage = 'done';
  st.pct = 1;
  st.ts = Date.now();
  save(st);
}

export function diagPeek() {
  return load();
}

export function stageLabel(stage) {
  return STAGE_LABELS[stage] || stage || '未知階段';
}

export function diagInterrupted(maxAgeMs = 12 * 3600 * 1000) {
  const st = load();
  if (!st) return null;
  if (st.stage === 'done' || st.stage === 'start') return null;
  if (!st.ts || Date.now() - st.ts > maxAgeMs) return null;
  return st;
}
