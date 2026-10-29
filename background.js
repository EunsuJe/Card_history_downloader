importScripts('selectors.js', 'lib/xlsx.full.min.js');
const C = globalThis.CARD_CONFIG;
let busy = false, timer, chain = Promise.resolve();
const serial = fn => { const r = chain.then(fn); chain = r.catch(() => {}); return r; };

const httpUrl = url => { try { const u = new URL(url); return u.protocol === 'http:' || u.protocol === 'https:'; } catch { return false; } };
const hostOf = url => { try { return new URL(url).hostname; } catch { return ''; } };
const read = async () => (await chrome.storage.local.get('state')).state;

async function log(type, message) {
  console.log(`[CardHistory][${type}] ${message}`);
  await serial(async () => {
    const { logs = [] } = await chrome.storage.local.get('logs');
    logs.push({ time: new Date().toISOString(), type, message });
    await chrome.storage.local.set({ logs: logs.slice(-2000) });
  });
}
// runId가 같을 때만 상태를 바꿈 (중지가 항상 우선)
async function patch(runId, fn) {
  return serial(async () => {
    const s = await read();
    if (!s?.running || s.runId !== runId) return null;
    fn(s);
    await chrome.storage.local.set({ state: s });
    return s;
  });
}
// 중지: 직접 기록 (serial 체어와 무관하게 항상 즉시 반영) + runId 교체로 진행 중 patch 차단
async function stop(s, type, reason) {
  const cur = await read();
  if (!cur || (s && cur.runId !== s.runId)) return;
  clearTimeout(timer);
  await chrome.storage.local.set({ state: { ...cur, running: false,
    runId: crypto.randomUUID(), phase: 'stopped', step: 'stopped', reason } });
  await log(type, reason);
}
function schedule(ms = C.pollMs) { clearTimeout(timer); timer = setTimeout(tick, ms); }
// phase와 표시용 step을 함께 갱신 — actionAt(단계 시작 시각)은 반드시 여기서 갱신
function go(x, phase, waitS) { x.phase = phase; x.step = phase; x.actionAt = Date.now();
  if (waitS) x.notBefore = Date.now() + waitS * 1000; }

// ── 날짜 유틸 (YYYYMMDD) ──
const ymd = d => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
const pd = s => { const d = String(s).replace(/\D/g, ''); return new Date(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8)); };
function validate(o) {
  if (!/^\d{8}$/.test(o.from || '') || !/^\d{8}$/.test(o.to || '')) throw new Error('조회 기간(시작/종료)을 확인하세요.');
  if (pd(o.from) > pd(o.to)) throw new Error('시작일이 종료일보다 늦습니다.');
  if (o.sheetSync && !/^https:\/\/script\.google/.test(o.gsUrl || ''))
    throw new Error('시트 연동을 켰으면 Apps Script 웹앱 URL(script.google.com/...)을 입력하세요.');
}

// ── 다운로드 감지: 클릭 시각 이후에 시작된 다운로드 기준 ──
async function dlStatus(clickAtMs) {
  let items = [];
  try { items = await chrome.downloads.search({ orderBy: ['-startTime'], limit: 20 }); } catch { items = []; }
  const t = (clickAtMs || 0) - 5000;   // 시계 오차 여유
  const fresh = items.filter(it => { try { return new Date(it.startTime).getTime() >= t; } catch { return false; } });
  const done = fresh.filter(it => it.state === 'complete');
  const bad = fresh.filter(it => it.state === 'interrupted');
  const name = it => (it.filename || '?').split(/[\\/]/).pop();
  if (done.length) return { status: 'done', files: done.map(name),
    url: done[0].url || done[0].finalUrl || '', path: done[0].filename || '' };
  if (bad.length) return { status: 'error', files: bad.map(name) };
  if (fresh.length) return { status: 'waiting' };
  return { status: 'none', last: items[0] ? `${name(items[0])} (${items[0].startTime})` : '기록 없음' };
}

// ── 다운로드 폴더의 파일 직접 읽기 (파일 URL 액세스 허용 시 동작) ──
async function readFileFromDisk(pathname) {
  try {
    if (!pathname) return null;
    let p = String(pathname).replace(/\\/g, '/');
    if (!/^file:/i.test(p)) p = 'file:///' + p.replace(/^\/+/, '');
    const r = await fetch(encodeURI(p).replace(/%3A/gi, ':'));
    if (!r.ok) return null;
    const ab = await r.arrayBuffer();
    return ab.byteLength ? new Uint8Array(ab) : null;
  } catch { return null; }   // 권한이 없으면 조용히 다음 경로로
}

// ── 파일 파싱 (백그라운드에서 실행 — xlsx/CSV 모두) ──
const b64dec = b64 => { const bin = atob(b64); const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; };
function parseCSV(t) {
  t = t.replace(/^\uFEFF/, '');
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) { if (c === '"') { if (t[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else if (c !== '\r') cur += c;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows;
}
function rowsFromBytes(u8, name) {
  const magic = String.fromCharCode(...u8.slice(0, 4));
  if (magic !== 'PK' && !/\.xlsx?$/i.test(name || '')) {
    // 텍스트(CSV) — 인코딩 자동 판별 (EUC-KR 시스템 대응)
    let txt = new TextDecoder('utf-8', { fatal: false }).decode(u8);
    if (/\ufffd/.test(txt)) { try { txt = new TextDecoder('euc-kr').decode(u8); } catch {} }
    if (/^\s*<(!doctype|html)/i.test(txt)) throw new Error('엑셀이 아닌 HTML 응답(로그인 페이지로 보임)');
    return parseCSV(txt);
  }
  const wb = XLSX.read(u8, { type: 'array' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' })
    .map(r => r.map(c => String(c ?? '')));
}
// 시트 응답을 사람이 읽을 수 있는 짧은 오류로 변환
function shortErr(txt) {
  if (/현재 파일을 열 수 없|페이지를 찾을 수 없|account[^"]*signin|accounts\.google\.com/i.test(txt))
    return '웹앱 액세스가 차단됨 — Apps Script [배포 관리 → 편집]에서 "Who has access"를 [모든 사용자]로 바꾸고 저장 (URL은 유지됨). 무단 사용 방지를 위해 팝업의 비밀번호와 스크립트의 SECRET을 같은 값으로 넣어 두세요';
  const t = txt.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return (t || '응답 없음').slice(0, 100);
}

// 스크립트 재주입 (2초에 한 번으로 제한)
async function reinject(s, runId) {
  if (Date.now() - (s.injectAt || 0) < 2000) return;
  await patch(runId, x => { x.injectAt = Date.now(); });
  await chrome.scripting.executeScript({ target: { tabId: s.tabId, allFrames: true },
    files: ['selectors.js', 'content.js'] }).catch(() => {});
}

// 여러 프레임 중 정확히 한 곳에서만 보이는 버튼 클릭 (iframe 대응)
async function click(s, kind, frames, after) {
  const hit = frames.filter(f => f.result?.[kind]);
  if (hit.length !== 1) return false;
  const [res] = await chrome.scripting.executeScript({
    target: { tabId: s.tabId, documentIds: [hit[0].documentId] },
    func: (k, id) => globalThis.CardAuto?.click(k, id) ?? false,
    args: [kind, s.runId]
  });
  if (!res?.result) return false;
  await patch(s.runId, after);
  return true;
}

async function tick() {
  if (busy) return;
  busy = true;
  let s;
  try {
    s = await read();
    if (!s?.running) return;
    const now = Date.now();
    // 전체 감시: 20분 이상 진행 시 자동 중지 (로그인 대기 포함)
    if (now - (s.startedAt || now) > 20 * 60 * 1000) {
      await stop(s, 'warning', '20분 초과로 자동 중지 — 진단 후 다시 시도하세요.');
      return;
    }
    const tab = await chrome.tabs.get(s.tabId);
    if (!httpUrl(tab.url)) throw new Error('대상 탭이 웹 페이지를 벗어났습니다.');
    if (tab.status === 'loading' || now < s.notBefore) return;

    let frames = [];
    try {
      frames = await chrome.scripting.executeScript({
        target: { tabId: s.tabId, allFrames: true },
        func: () => globalThis.CardAuto?.probe?.() ?? null }) || [];
    } catch { frames = []; }
    // 주입 안 된 프레임은 재주입만 하고, 있는 결과로 계속 진행 (여기서 멈추지 않음)
    if (frames.some(f => !f.result)) await reinject(s, s.runId);

    const results = frames.map(f => f.result).filter(Boolean);
    if (!results.length) return; // 아직 어느 프레임도 준비 안 됨 — 다음 폴링에서 재시도
    const any = k => results.some(r => r[k]);
    const find = () => results.find(r => r.rows > 0 || r.empty);
    const cfg = s.cfg, sinceAction = now - (s.actionAt || 0);
    const latest = await read();
    if (!latest?.running || latest.runId !== s.runId) return;

    // ⓪-① 포털: 로그인 대기 → E-Accounting 클릭
    if (s.phase === 'launch') {
      // E-Accounting 화면(iframe 포함)이 이미 열려 있으면 바로 진행
      if (any('form') || results.some(r => r.menuIdx >= 0)) {
        await patch(s.runId, x => go(x, 'nav', cfg.dFill));
        await log('info', '조회 화면 감지 — 메뉴 이동으로 진행');
        return;
      }
      const host = hostOf(tab.url);
      if (C.portal.eaTarget.test(host)) {
        await patch(s.runId, x => go(x, 'nav', cfg.dFill));
        await log('info', 'E-Accounting 화면 감지 — 메뉴 이동으로 진행');
        return;
      }
      if (!C.portal.hostMatch.test(host)) {
        await stop(s, 'error', '시작 탭이 포털(cleverse) 또는 E-Accounting 화면이 아닙니다.');
        return;
      }
      if (any('loginNeeded')) {
        if (now - (s.warnAt || s.startedAt) > 30000) {
          await patch(s.runId, x => { x.warnAt = now; });
          await log('warning', '포털 로그인 대기 중 — 로그인하면 자동으로 계속합니다.');
        }
        return;
      }
      if (any('eaBtn')) {
        const f = frames.find(x => x.result?.eaBtn);
        const [res] = await chrome.scripting.executeScript({
          target: { tabId: s.tabId, documentIds: [f.documentId] },
          func: id => globalThis.CardAuto?.navEa(id) ?? false,
          args: [s.runId] });
        if (res?.result) {
          await patch(s.runId, x => go(x, 'entering'));
          await log('info', 'E-Accounting 버튼 클릭 — 창 열림 대기');
        }
        return;
      }
      return; // 포털 화면 로딩 중 — 재폴링에서 재확인
    }

    // ⓪-② E-Accounting 창(새 탭/새 창) 감지 → 작업 탭 전환
    if (s.phase === 'entering') {
      if (C.portal.eaTarget.test(hostOf(tab.url))) {
        await patch(s.runId, x => go(x, 'nav', cfg.dFill));
        await log('info', 'E-Accounting 진입 — 메뉴 이동으로 진행');
        return;
      }
      const tabs = await chrome.tabs.query({});
      const ea = tabs.find(t => C.portal.eaTarget.test(hostOf(t.url)));
      if (ea) {
        await patch(s.runId, x => { x.tabId = ea.id; go(x, 'nav');
          x.notBefore = Date.now() + 2000; });
        await log('info', `E-Accounting 창 감지 — 해당 탭으로 진행 (${ea.url})`);
        return;
      }
      if (now - (s.enterAt || s.startedAt) > C.portal.enteringTimeoutS * 1000)
        await stop(s, 'error', 'E-Accounting 창이 열리지 않음 — 포털 화면을 직접 확인하세요.');
      return;
    }

    // ① 메뉴 이동: 개인 경비 → 법인카드 경비 신청 (이미 조회 화면이면 건너뜀)
    if (s.phase === 'nav') {
      if (any('form')) {
        await patch(s.runId, x => go(x, 'fill', cfg.dFill));
        await log('info', '조회 화면 감지 — 조건 입력으로 이동');
        return;
      }
      const fMenu = frames.find(f => f.result?.menuIdx >= 0);
      if (fMenu) {
        const idx = fMenu.result.menuIdx;
        const [res] = await chrome.scripting.executeScript({
          target: { tabId: s.tabId, documentIds: [fMenu.documentId] },
          func: (i, id) => globalThis.CardAuto?.navClick(i, id) ?? false,
          args: [idx, s.runId] });
        if (res?.result) {
          await patch(s.runId, x => { x.notBefore = now + 1000; });
          await log('info', `메뉴 클릭 — ${fMenu.result.menuLabel}`);
        }
      }
      return;
    }

    // ② 조회조건 입력: 모든 목록 '전체' + 시작일/종료일
    if (s.phase === 'fill') {
      if (any('form')) {
        const fForm = frames.find(f => f.result?.form);
        const [res] = await chrome.scripting.executeScript({
          target: { tabId: s.tabId, documentIds: [fForm.documentId] },
          func: (f, t, id) => globalThis.CardAuto?.fill(f, t, id) ?? null,
          args: [s.from, s.to, s.runId] });
        const r = res?.result;
        if (r?.ok && r?.selectOk) {
          await patch(s.runId, x => go(x, 'search', cfg.dFill));
          await log('info', `조건 입력 — ${r.selectInfo || '조회조건'} · ${s.from} ~ ${s.to}` +
            (r.warn ? ` (${r.warn})` : ''));
        } else if (r && r.ok && !r.selectOk) {
          await stop(s, 'error', `드롭다운 '전체' 적용 실패 — ${r.selectInfo || ''}. 해당 화면에서 직접 '전체'를 고른 뒤 다시 실행하세요. (반복되면 진단 로그를 공유해 주세요)`);
        } else if (r) {
          await stop(s, 'error', `조회조건 입력 실패${r.warn ? ' — ' + r.warn : ''}${!r.selectOk ? ' / 드롭다운 적용 실패' : ''}`);
        } else if (sinceAction > C.stepTimeoutMs) {
          await stop(s, 'error', '조회 화면(시작일자/종료일자)을 찾을 수 없습니다. 진단 버튼으로 화면 정보를 확인하세요.');
        }
      } else if (sinceAction > C.stepTimeoutMs) {
        await stop(s, 'error', '조회 화면(시작일자/종료일자)을 찾을 수 없습니다. 진단 버튼으로 화면 정보를 확인하세요.');
      }
      return;
    }

    // ③ 조회 클릭
    if (s.phase === 'search') {
      if (any('searchMulti')) {
        await stop(s, 'error', '"조회" 문구의 요소가 여러 개 보입니다 — selectors.js의 searchBtn에 셀렉터를 지정하세요.');
        return;
      }
      if (any('search')) {
        // 조회 직전 날짜 재확인 — 사이트에 반영 안 됐으면 재시도, 그래도 실패면 조회하지 않고 중단 (잘못된 기간 조회 방지)
        const fForm = frames.find(f => f.result?.form);
        if (fForm) {
          const [dc] = await chrome.scripting.executeScript({
            target: { tabId: s.tabId, documentIds: [fForm.documentId] },
            func: (f, t, id) => globalThis.CardAuto?.checkDates(f, t, id) ?? null,
            args: [s.from, s.to, s.runId] });
          if (dc?.result && !dc.result.ok) {
            await stop(s, 'error', `날짜가 사이트에 반영되지 않아 조회를 중단했습니다 (${dc.result.info}). 날짜 입력란을 클릭해 직접 입력해 보고, 형식이 다르면 selectors.js의 site.dateFormat 지정 (예: 'YYYYMMDD') 후 재실행하세요.`);
            return;
          }
        }
        const ok = await click(s, 'search', frames, x => go(x, 'wait_result', cfg.dSearch));
        if (ok) await log('info', '조회 클릭');
      } else if (sinceAction > C.stepTimeoutMs * 2) {
        await stop(s, 'error', '조회 버튼을 찾을 수 없습니다 — 진단 버튼으로 화면 정보를 확인하세요.');
      }
      return;
    }

    // ④ 결과 로딩 대기 (0건이면 빈 파일 다운로드를 하지 않고 종료)
    if (s.phase === 'wait_result') {
      const r = find();
      if (r) {
        if (r.empty) {
          await stop(s, 'info', `조회 결과 0건 — 빈 파일 다운로드를 생략합니다. 기간·조건(${s.from} ~ ${s.to})을 확인하세요.`);
          return;
        }
        await patch(s.runId, x => go(x, 'download', cfg.dResult));
        if (r.rows > 0) await log('info', `조회 결과 ${r.rows}행`);
      } else if (sinceAction > C.hardResultWaitS * 1000) {
        await patch(s.runId, x => go(x, 'download', cfg.dResult));
        await log('warning', '조회 결과 표를 확인하지 못함 — 그래도 다운로드를 시도합니다.');
      }
      return;
    }

    // ⑤ 엑셀 클릭 (클릭 전 응답 가로채기 훅 설치 — 시트 입력용)
    if (s.phase === 'download') {
      if (any('excelMulti')) {
        await stop(s, 'error', '"엑셀" 문구의 요소가 여러 개 보입니다 — selectors.js의 excelBtn에 셀렉터를 지정하세요.');
        return;
      }
      if (any('excel')) {
        const fAny = frames.find(f => f.result?.excel);
        // 응답 가로채기 훅 설치 + 이전 캡처 초기화 (MAIN 월드)
        await chrome.scripting.executeScript({
          target: { tabId: s.tabId, documentIds: [fAny.documentId] },
          world: 'MAIN',
          func: () => { if (window.__cardExport) window.__cardExport = null;
            return globalThis.CardAutoInstallHook?.() ?? false; } }).catch(() => {});
        const clickAt = Date.now();
        const ok = await click(s, 'excel', frames, x => { go(x, 'wait_download');
          x.clickAt = clickAt; });
        if (ok) await log('info', s.cfg.sheetSync ? '엑셀 클릭 — 다운로드 후 시트 입력 대기' : '엑셀 클릭 — 다운로드 대기');
      } else if (sinceAction > C.stepTimeoutMs * 2) {
        await stop(s, 'error', '엑셀 버튼을 찾을 수 없습니다 — 진단 버튼으로 화면 정보를 확인하세요.');
      }
      return;
    }

    // ⑥ 다운로드 완료 → (옵션) 구글 시트 입력 → 완료
    if (s.phase === 'wait_download') {
      // ① 페이지 훅이 파일 응답을 캡처했으면 즉시 성공으로 판단 (다운로드 기록과 무관)
      let hookHit = false;
      try {
        const fHook = frames.find(f => f.result);
        const [h] = await chrome.scripting.executeScript({
          target: { tabId: s.tabId, documentIds: [fHook.documentId] },
          world: 'MAIN',
          func: () => !!window.__cardExport });
        hookHit = !!h?.result;
      } catch { hookHit = false; }
      const st = hookHit ? { status: 'done', files: ['(엑셀 응답 수신 확인)'] }
                         : await dlStatus(s.clickAt ?? 0);
      if (st.status === 'done') {
        await log('success', `다운로드 완료 — ${st.files.join(', ')}`);
        if (s.cfg.sheetSync && s.cfg.gsUrl) {
          await patch(s.runId, x => { go(x, 'sheet_sync'); x.dlUrl = st.url || '';
            x.dlPath = st.path || ''; x.dlName = st.files[0] || ''; });
          await log('info', '구글 시트 입력 시작');
        } else {
          await stop(s, 'success', st.files.join(', '));
        }
      } else if (st.status === 'error') {
        await stop(s, 'error', `다운로드 실패(${st.files.join(', ')}) — 화면을 확인하세요.`);
      } else if (sinceAction > C.downloadTimeoutS * 1000) {
        await stop(s, 'warning', `다운로드 감지 실패 (최근 기록: ${st.last || '없음'}) — 파일이 저장됐다면 정상 완료된 것입니다.`);
      }
      return;
    }

    // ⑦ 구글 시트 입력: 모든 프레임에서 파일 읽기(훅 캡처 → 페이지 세션 재요청)
    //    → 백그라운드에서 파싱 → 시트 전송 (다운로드 흐름에는 영향 없음)
    if (s.phase === 'sheet_sync') {
      const rFrames = frames.filter(f => f.result);
      if (!rFrames.length) {
        await reinject(s, s.runId);
        if (sinceAction > 30000) await stop(s, 'warning', '시트 입력 실패 — 화면을 읽을 수 없습니다. (다운로드 파일은 정상 저장되어 있습니다)');
        return;
      }
      // 엑셀 파일 읽기 — 가장 확실한 순서로:
      // ⓪ 다운로드 폴더의 파일 직접 읽기 (파일 URL 액세스 허용 시)
      // ① 훅이 가로챈 응답  ② 다운로드 URL을 페이지 세션(쿠키·blob 모두 접근 가능)으로 재요청
      let u8 = null, fname = '';
      const disk = await readFileFromDisk(s.dlPath);
      if (disk) { u8 = disk; fname = s.dlName || ''; }
      if (!u8) for (const f of rFrames) {
        const [res] = await chrome.scripting.executeScript({
          target: { tabId: s.tabId, documentIds: [f.documentId] },
          world: 'MAIN',
          func: (u, ms) => new Promise(resolve => {
            const b64 = buf => { const a = new Uint8Array(buf); let t = '';
              for (let i = 0; i < a.length; i += 32768) t += String.fromCharCode(...a.subarray(i, i + 32768));
              return btoa(t); };
            const t0 = Date.now();
            (async function poll() {
              try {
                if (window.__cardExport?.b64)
                  return resolve({ ok: true, b64: window.__cardExport.b64, name: window.__cardExport.name || '' });
                if (u && Date.now() - t0 > 800) {
                  try {
                    const r = await fetch(u, { credentials: 'include' });
                    if (r.ok) {
                      const ab = await r.arrayBuffer();
                      if (ab.byteLength) return resolve({ ok: true, b64: b64(ab),
                        name: decodeURIComponent((u.split('/').pop() || '').split('?')[0] || '') });
                    }
                  } catch {}
                }
                if (Date.now() - t0 > ms) return resolve({ ok: false });
                setTimeout(poll, 500);
              } catch (e) { resolve({ ok: false, err: String(e) }); }
            })();
          }),
          args: [s.dlUrl || '', 8000] }).catch(() => [{ result: null }]);
        if (res?.result?.ok && res.result.b64) {
          u8 = b64dec(res.result.b64); fname = res.result.name || '';
          break;
        }
      }
      if (!u8) {
        if (sinceAction > 30000)
          await stop(s, 'warning', '시트 입력 실패 — 파일 내용을 읽지 못했습니다 (다운로드 파일은 정상 저장되어 있습니다).');
        return;
      }
      try {
        const rows = rowsFromBytes(u8, fname).filter(r => r.some(c => String(c).trim() !== ''));
        const resp = await fetch(s.cfg.gsUrl, { method: 'POST',
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: JSON.stringify({ secret: s.cfg.gsSecret || '', sheet: s.cfg.sheetName || '카드사용',
            rows }) });
        const txt = (await resp.text()).trim();
        if (!resp.ok || !/^ok/i.test(txt)) throw new Error(shortErr(txt || `HTTP ${resp.status}`));
        const md = d => /^\d{8}$/.test(d || '') ? d.slice(4, 6) + '-' + d.slice(6) : d;
        const m = txt.match(/(\d+)\s*행[^·]*·\s*R열\s*매핑\s*(\d+)건\s*·\s*미매핑\s*(\d+)건(?:\s*·\s*기존값유지\s*(\d+)건)?/i);
        await stop(s, 'success', m
          ? `구글 시트 입력 완료 (${md(s.from)}~${md(s.to)}, 총 ${m[1]}건, R열 매핑 ${m[2]}건, 미매핑 ${m[3]}건` +
            (m[4] ? `, 기존값 유지 ${m[4]}건` : '') + ')'
          : `구글 시트 입력 완료 — ${txt}`);
      } catch (e) {
        await stop(s, 'error', `시트 전송 실패 — ${e.message}`);
      }
      return;
    }
  } catch (e) {
    if (s?.running) {
      const tab = await chrome.tabs.get(s.tabId).catch(() => null);
      const transient = tab && httpUrl(tab.url) &&
        (tab.status === 'loading' || /frame|document|context|Receiving end/i.test(e.message || ''));
      if (!transient) await stop(s, 'error', e.message);
    }
  } finally {
    busy = false;
    if ((await read())?.running) schedule();
  }
}

async function command(m) {
  if (m.type === 'START') {
    const cfg = { ...C.defaults, ...(m.cfg || {}) };
    validate(cfg);
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !httpUrl(tab.url)) throw new Error('포털 또는 E-Accounting 화면 탭에서 실행하세요.');
    const prev = await read();
    if (prev?.running) throw new Error('이미 실행 중입니다 — 중지 또는 초기화 후 다시 시도하세요.');
    const host = hostOf(tab.url);
    const phase = C.portal.eaTarget.test(host) ? 'nav' : 'launch';
    await chrome.storage.local.set({ settings: cfg, state: {
      running: true, runId: crypto.randomUUID(), tabId: tab.id, cfg,
      from: cfg.from, to: cfg.to,
      phase, step: phase, last: '', actionAt: 0, notBefore: 0, clickAt: 0, injectAt: 0,
      dlUrl: '', dlPath: '', dlName: '',
      enterAt: 0, startedAt: Date.now(), reason: '' } });
    if (phase === 'launch')
      await log('info', '포털에서 시작 — 로그인 확인 후 E-Accounting에 진입합니다.');
    await log('info', `시작 · ${cfg.from} ~ ${cfg.to}`);
    schedule(0);
  } else if (m.type === 'STOP') {
    // 직접 기록 — 다른 로직과 얽히지 않고 항상 즉시 반영됨
    const s = await read();
    if (s) await chrome.storage.local.set({ state: { ...s, running: false,
      runId: crypto.randomUUID(), phase: 'stopped', step: 'stopped', reason: '사용자 중지' } });
    clearTimeout(timer);
    await log('info', '중지');
  } else if (m.type === 'RESET') {
    clearTimeout(timer);
    await chrome.storage.local.set({ state: null });
    await log('info', '초기화 — 모든 상태를 지웠습니다.');
  } else if (m.type === 'DIAG') {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !httpUrl(tab.url)) throw new Error('진단은 웹 페이지 탭에서 실행하세요.');
    await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true },
      files: ['selectors.js', 'content.js'] }).catch(() => {});
    const frames = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: () => globalThis.CardAuto?.probe?.() ?? null }).catch(() => []);
    const parts = (frames || []).filter(f => f.result).map(f => {
      const d = f.result.diag || {};
      return `[${d.host || '?'}] ` + JSON.stringify({ ...f.result, diag: undefined }) +
        ` 날짜:${(d.dates || []).join('~') || '없음'}` +
        ` 목록:${(d.lists || []).join(', ') || '없음'}`;
    });
    await log('info', `진단 결과 — ${parts.length ? parts.join(' ◆ ') : '인식된 요소 없음(화면 로딩 상태 확인)'}`);
  } else if (m.type === 'CLEAR') {
    await serial(() => chrome.storage.local.set({ logs: [] }));
  } else if (m.type === 'WAKE') {
    if (!busy) schedule();
  } else throw new Error('알 수 없는 명령');
  return { ok: true };
}

chrome.runtime.onMessage.addListener((m, sender, respond) => {
  const fromPopup = !sender.tab && sender.url === chrome.runtime.getURL('popup.html');
  if (m.type !== 'WAKE' && !fromPopup) { respond({ ok: false, error: '허용되지 않은 요청' }); return; }
  command(m).then(respond, e => respond({ ok: false, error: e.message }));
  return true;
});
chrome.tabs.onUpdated.addListener((id, info) => {
  if (info.status === 'complete') read().then(s => { if (s?.running && (s.tabId === id || s.phase === 'entering') && !busy) schedule(); });
});
chrome.tabs.onRemoved.addListener(id => {
  read().then(async s => {
    if (s?.running && s.tabId === id) await stop(s, 'error', '대상 탭이 닫혔습니다.');
  });
});
chrome.runtime.onStartup.addListener(() => {
  read().then(async s => { if (s?.running) await stop(s, 'warning', '브라우저 재시작으로 중지됨'); });
});
read().then(s => { if (s?.running) schedule(); });
