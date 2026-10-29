const $ = id => document.getElementById(id);
const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
const iso = s => `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
const today = new Date();
const DEFAULTS = {
  from: ymd(new Date(today.getFullYear(), today.getMonth(), 1)),  // 이번 달 1일
  to: ymd(today),                                                  // 오늘
  sheetSync: false, gsUrl: '', gsSecret: '', sheetName: '카드사용' };
const STEPS = { launch: '포털 확인', entering: 'E-Accounting 진입 대기',
  nav: '메뉴 이동', fill: '조회조건 입력', search: '조회 클릭 대기',
  wait_result: '결과 로딩 대기', download: '엑셀 클릭 대기',
  wait_download: '다운로드 완료 대기', sheet_sync: '구글 시트 입력',
  stopped: '중지됨' };
let entries = [];

function readForm() {
  const cfg = { from: '', to: '' };
  if ($('from').value) cfg.from = ymd(new Date($('from').value));
  if ($('to').value) cfg.to = ymd(new Date($('to').value));
  cfg.sheetSync = $('sheetSync').checked;
  cfg.gsUrl = $('gsUrl').value.trim();
  cfg.gsSecret = $('gsSecret').value;
  cfg.sheetName = $('sheetName').value.trim() || '카드사용';
  return cfg;
}
function fillForm(cfg) {
  $('from').value = iso(cfg.from || DEFAULTS.from);
  $('to').value = iso(cfg.to || DEFAULTS.to);
  $('sheetSync').checked = cfg.sheetSync ?? false;
  $('gsUrl').value = cfg.gsUrl || '';
  $('gsSecret').value = cfg.gsSecret || '';
  $('sheetName').value = cfg.sheetName || '카드사용';
}
async function send(type, data = {}) {
  $('error').textContent = '';
  try {
    const r = await chrome.runtime.sendMessage({ type, ...data });
    if (!r?.ok) throw new Error(r?.error || '백그라운드 응답 없음');
  } catch (e) { $('error').textContent = e.message; }
}
function renderState(s) {
  const run = !!s?.running;
  $('go').disabled = run;
  $('stop').style.display = run ? '' : 'none';
  const runFields = ['from', 'to', 'sheetSync', 'gsUrl', 'gsSecret', 'sheetName'];
  for (const k of runFields) $(k).disabled = run;
  if (!s) { $('state').textContent = '대기 중'; return; }
  // phase 기준으로 표시 (하위 버전 state 호환: phase 없으면 step)
  const stepKey = s.phase || s.step;
  $('state').textContent = run
    ? `실행 중 · ${STEPS[stepKey] || stepKey || '진행'}` + (s.reason ? ` — ${s.reason}` : '')
    : (s.reason ? `정지 · ${s.reason}` : `정지 · ${STEPS[stepKey] || stepKey || '대기'}`);
}
function renderLogs(logs) {
  entries = logs;
  const t = { info: '안내', success: '성공', warning: '실패/대기', error: '오류' };
  $('logs').textContent = logs.map(e =>
    `${new Date(e.time).toLocaleTimeString('ko-KR', { hour12: false })} [${t[e.type] || e.type}] ${e.message}`).join('\n');
  $('logs').scrollTop = $('logs').scrollHeight;
}

$('go').addEventListener('click', () => send('START', { cfg: readForm() }));
$('stop').addEventListener('click', () => send('STOP'));
$('reset').addEventListener('click', () => send('RESET'));
$('diag').addEventListener('click', () => send('DIAG'));
$('clear').addEventListener('click', () => send('CLEAR'));
for (const k of ['from', 'to', 'sheetSync', 'gsUrl', 'gsSecret', 'sheetName'])
  $(k).addEventListener('change', () => send('SAVE', { cfg: readForm() }));
$('csv').addEventListener('click', () => {
  const q = v => '"' + String(v).replace(/^[=+@\-\t\r]/, "'$&").replace(/"/g, '""') + '"';
  const csv = '﻿' + [['시간', '유형', '메시지'], ...entries.map(e => [e.time, e.type, e.message])]
    .map(r => r.map(q).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url; a.download = `card-history-${Date.now()}.csv`; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
});
chrome.storage.onChanged.addListener((c, area) => {
  if (area !== 'local') return;
  if (c.state) renderState(c.state.newValue);
  if (c.logs) renderLogs(c.logs.newValue || []);
});
chrome.storage.local.get(['state', 'logs', 'settings']).then(({ state, logs = [], settings }) => {
  fillForm({ ...DEFAULTS, ...(settings || {}) });
  renderState(state); renderLogs(logs);
});
