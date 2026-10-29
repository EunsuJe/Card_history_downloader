(() => {
  if (globalThis.CardAuto) return;
  const C = globalThis.CARD_CONFIG;
  const norm = v => String(v || '').replace(/\s+/g, ' ').trim();
  const digits = v => String(v || '').replace(/\D/g, '');
  const text = el => norm(el.innerText || el.textContent || '');
  const up = el => el.parentElement || el.getRootNode()?.host || null;
  function* ancestors(el) { for (let n = el; n; n = up(n)) yield n; }
  const contains = (root, el) => { for (const n of ancestors(el)) if (n === root) return true; return false; };
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // Shadow DOM 안까지 전체 요소 수집
  function all(root = document) {
    const out = [];
    for (const el of root.querySelectorAll('*')) {
      out.push(el);
      if (el.shadowRoot) out.push(...all(el.shadowRoot));
    }
    return out;
  }
  function visible(el) {
    if (!el.isConnected || !el.getClientRects().length) return false;
    for (const n of ancestors(el)) {
      if (!(n instanceof Element)) continue;
      const s = getComputedStyle(n);
      if (n.hidden || n.inert || s.display === 'none' || s.visibility === 'hidden' ||
          s.visibility === 'collapse' || Number(s.opacity) === 0) return false;
    }
    return true;
  }
  // 이 시스템은 버튼 div에 항상 disabled="" 가 붙어 있으므로 기본적으로 무시
  const blocked = el => !C.site?.ignoreDisabled && (() => {
    try { return el.matches(':disabled') || !!el.closest('[disabled]'); } catch { return !!el.closest('[disabled]'); }
  })() || !!el.closest('[aria-disabled="true"], [inert]');
  const interactive = el => !blocked(el);

  // 텍스트로 요소 찾기 — 문구가 들어 있는 가장 안쪽 요소만
  function byText(re) {
    const hits = all().filter(el => visible(el) && re.test(text(el)));
    const inner = hits.filter(el => !hits.some(o => o !== el && contains(el, o)));
    return inner.filter(interactive);
  }
  // CSS 셀렉터 또는 텍스트 규칙으로 버튼 찾기
  function finder(kind) {
    const S = C.selectors;
    const sel = kind === 'search' ? S.searchBtn : S.excelBtn;
    if (sel) return all().filter(el => { try { return el.matches(sel) && visible(el); } catch { return false; } }).filter(interactive);
    return byText(kind === 'search' ? C.labels.search : C.labels.excel);
  }

  // ── 날짜 입력란 (지정 셀렉터 우선, 없으면 자동 탐지) ──
  function dateScore(el) {
    let s = 0;
    if (el.type === 'date') s += 3;
    if (/^\d{4}[-./]?\d{2}[-./]?\d{2}$/.test(el.value.trim())) s += 4;
    if (/yyyy/i.test(el.placeholder || '')) s += 3;
    if (C.selectors.dateInputHint.test(`${el.id} ${el.name} ${el.className} ${el.placeholder} ${el.title}`)) s += 2;
    if (el.maxLength === 8 || el.maxLength === 10) s += 1;
    return s;
  }
  function dateInputs() {
    const S = C.selectors;
    try {
      if (S.dateFrom && S.dateTo) {
        const a = document.querySelector(S.dateFrom), b = document.querySelector(S.dateTo);
        if (a && b && visible(a) && visible(b)) return { from: a, to: b };
      }
    } catch {}
    const cands = all().filter(el => el.tagName === 'INPUT' && visible(el) &&
      ['text', 'date', ''].includes(el.type)).map(el => ({ el, s: dateScore(el) }))
      .filter(x => x.s >= 3).sort((a, b) => b.s - a.s);
    if (cands.length < 2) return null;
    const [a, b] = cands.slice(0, 2).map(x => x.el)
      .sort((x, y) => (x.compareDocumentPosition(y) & Node.DOCUMENT_POSITION_FOLLOWING) ? -1 : 1);
    return { from: a, to: b };
  }

  // ── 값 설정 (입력란 형식에 맞춰 변환 + 이벤트 발생 → Vue/React 등에서 인식) ──
  function toFmt(ymd, el) {
    const d = digits(ymd);
    if (!/^\d{8}$/.test(d)) return String(ymd || '');
    const fmt = C.site?.dateFormat || 'auto';
    if (fmt === 'YYYYMMDD') return d;
    if (fmt !== 'auto') {
      const sep = fmt.includes('.') ? '.' : fmt.includes('/') ? '/' : '-';
      return `${d.slice(0, 4)}${sep}${d.slice(4, 6)}${sep}${d.slice(6)}`;
    }
    if (el.type === 'date') return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}`;
    const cur = (el.value || el.placeholder || '').trim();
    if (/^\d{8}$/.test(cur) || (el.maxLength === 8 && cur)) return d;
    if (cur.includes('.')) return `${d.slice(0, 4)}.${d.slice(4, 6)}.${d.slice(6)}`;
    if (cur.includes('/')) return `${d.slice(0, 4)}/${d.slice(4, 6)}/${d.slice(6)}`;
    return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}`;
  }
  function setVal(el, v) {
    el.focus();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
    el.blur();
  }
  // 사람 입력처럼: 전체선택 → 한 글자씩 입력 → Enter → blur (달력 픽커 컴포넌트가 내부 값에 반영되도록)
  function typeInto(el, v) {
    try { el.focus(); el.select && el.select(); } catch {}
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(el, '');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    for (const ch of String(v)) {
      setter.call(el, (el.value || '') + ch);
      el.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true }));
      el.dispatchEvent(new InputEvent('input', { bubbles: true, data: ch }));
    }
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
    el.blur();
    el.dispatchEvent(new Event('focusout', { bubbles: true }));
  }
  // 날짜 입력: 값을 넣고 → 반영 확인 → 안 되면 타이핑+Enter로 재시도 → 그래도 안 되면 실패 보고
  async function commitDates(p, from, to) {
    setVal(p.from, toFmt(from, p.from));
    setVal(p.to, toFmt(to, p.to));
    await sleep(300);
    if (digits(p.from.value) === digits(from) && digits(p.to.value) === digits(to)) return { ok: true };
    typeInto(p.from, toFmt(from, p.from));
    typeInto(p.to, toFmt(to, p.to));
    await sleep(400);
    if (digits(p.from.value) === digits(from) && digits(p.to.value) === digits(to)) return { ok: true };
    return { ok: false, info: `시작일=${p.from.value || '빈값'} / 종료일=${p.to.value || '빈값'}` };
  }

  // ── 드롭다운(콤보 목록) 처리 ──
  // 목록 입력란의 표시 이름: aria-label → 조상 컨테이너의 짧은 라벨 → 순번
  function fieldName(el, idx) {
    const aria = el.getAttribute('aria-label');
    if (aria) return aria;
    for (const anc of ancestors(el)) {
      if (!(anc instanceof Element) || anc === document.body || anc === document.documentElement) break;
      const t = text(anc);
      if (t && t.length <= 20 && !t.includes(norm(el.value || '§'))) return t.slice(0, 10);
    }
    return `목록#${(idx ?? 0) + 1}`;
  }
  function listInputs() {
    const S = C.site || {};
    let list = [];
    try {
      if (S.selectInput) list = all().filter(el => {
        try { return el.matches(S.selectInput) && visible(el); } catch { return false; } });
    } catch {}
    if (!list.length) list = all().filter(el => el.tagName === 'INPUT' && visible(el) &&
      el.getAttribute('aria-autocomplete') === 'list');
    return list;
  }
  // 콤보 열기: click만으로 안 열리는 UI가 많아 포인터/마우스 이벤트를 순서대로 발생
  function openList(input) {
    input.scrollIntoView({ block: 'center', behavior: 'instant' });
    input.focus();
    const o = { bubbles: true, cancelable: true };
    input.dispatchEvent(new PointerEvent('pointerdown', o));
    input.dispatchEvent(new MouseEvent('mousedown', o));
    input.dispatchEvent(new MouseEvent('mouseup', o));
    input.click();
  }
  // 입력란 옆의 목록 열기 토글(화살표 버튼 등) 후보
  function openers(input) {
    let scope = null;
    for (const anc of ancestors(input)) {
      if (!(anc instanceof Element) || anc === document.body) break;
      if (anc.querySelectorAll('input').length <= 3 &&
          anc.getBoundingClientRect().height < 140 && anc !== input.parentElement?.parentElement?.parentElement) {
        scope = anc; break;
      }
    }
    if (!scope) return [];
    return all().filter(el => el !== input && !el.contains(input) && input.contains(el) === false &&
      scope.contains(el) && interactive(el) &&
      (el.matches('button, [role="button"], [class*="btn"], [class*="arrow"], [class*="icon"], [class*="toggle"], [class*="drop"], [class*="combo"]') ||
       text(el) === ''))
      .slice(0, 3);
  }
  // 현재 DOM에 있는 원하는 옵션 찾기 (1회 탐색)
  function findOptionNow(input, want) {
    const R = input.getBoundingClientRect();
    const cands = all().filter(el => el !== input && !el.contains(input) && !input.contains(el) &&
      visible(el) && interactive(el) && norm(el.textContent) === want);
    const li = cands.filter(el => {
      try { return !!el.closest('li, [role="option"], [role="listbox"], ul, ol'); } catch { return false; }
    });
    const pool = (li.length ? li : cands);
    if (!pool.length) return null;
    return pool.slice().sort((a, b) =>
      Math.abs(a.getBoundingClientRect().top - R.bottom) -
      Math.abs(b.getBoundingClientRect().top - R.bottom))[0];
  }
  // 화면에 보이는 옵션들 텍스트 (실패 원인 파악용) — 내비게이션 메뉴는 제외
  function inNav(el) {
    try {
      if (el.closest('nav, aside, [class*="menu"], [class*="Menu"], [id*="menu"], [class*="nav"], [id*="nav"], [class*="gnb"], [class*="lnb"], [class*="sidebar"]'))
        return true;
      return (C.site?.menuPath || []).some(re => re.test(text(el)));
    } catch { return false; }
  }
  function optionsSeen() {
    return all().filter(el => visible(el) && interactive(el) && !inNav(el) &&
      (el.matches('li, [role="option"]') || (!el.children.length && text(el) && text(el).length <= 12)))
      .map(el => text(el)).filter(t => t && t.length <= 12).slice(0, 15);
  }
  // 화면에서 스크롤 가능한 목록 컨테이너 (가상 렌더 목록용)
  function scrollersNear(input) {
    const R = input.getBoundingClientRect();
    return all().filter(el => {
      if (!visible(el) || el === input || el.contains(input)) return false;
      const s = getComputedStyle(el);
      return /(auto|scroll|overlay)/.test(s.overflowY) &&
        el.scrollHeight > el.clientHeight + 20 && el.clientHeight > 50 &&
        Math.abs(el.getBoundingClientRect().top - R.bottom) < 600;
    });
  }
  // 열린 목록에서 원하는 항목 찾기 — 최대 ms, 못 찾으면 목록을 굴려 가며 재탐색
  async function waitForOption(input, want, ms = 3500) {
    const t0 = Date.now();
    let dir = 1;
    while (Date.now() - t0 < ms) {
      const opt = findOptionNow(input, want);
      if (opt) { opt.scrollIntoView({ block: 'nearest', behavior: 'instant' }); return opt; }
      // 옵션이 아직 DOM에 없음 → 스크롤 메뉴를 조금씩 굴려 렌더 유도 (위→아래→위 왕복)
      for (const sc of scrollersNear(input).slice(0, 3)) {
        if (dir > 0 && sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 2) dir = -1;
        if (dir < 0 && sc.scrollTop <= 2) dir = 1;
        sc.scrollTop = Math.max(0, sc.scrollTop + dir * 90);
      }
      await sleep(150);
    }
    return null;
  }
  function clickEl(el) {
    const o = { bubbles: true, cancelable: true };
    el.dispatchEvent(new PointerEvent('pointerdown', o));
    el.dispatchEvent(new MouseEvent('mousedown', o));
    el.dispatchEvent(new MouseEvent('mouseup', o));
    el.click();
  }
  // 입력란 값이 원하는 값으로 실제 반영될 때까지 폴링 확인 (즉시 판정 금지)
  async function verifyValue(input, want, ms) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (norm(input.value) === want) return true;
      await sleep(150);
    }
    return norm(input.value) === want;
  }
  const esc = input => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  // 커밋 확정: 입력란을 한 번 더 클릭해 목록을 연 뒤 '전체' 옵션을 클릭 —
  // 이 시스템은 값이 보여도 목록에서 한 번 더 선택해야 조회에 실제 반영됨
  async function commitReclick(input, want) {
    openList(input);
    await sleep(400);
    const opt = await waitForOption(input, want, 2500);
    if (!opt) return false;
    clickEl(opt);
    await sleep(300);
    return verifyValue(input, want, 2000);
  }
  // 자동완성 입력: 값을 넣어 목록을 필터링 → 그려진 실제 옵션을 클릭(또는 Enter)
  // aria-autocomplete="list" UI의 정상 입력 경로 — 값 반영을 항상 확인
  async function typeSelect(input, want) {
    try { input.focus(); } catch {}
    input.select?.();
    setVal(input, want);
    const opt = await waitForOption(input, want, 2500);
    if (opt) {
      clickEl(opt);
      if (await verifyValue(input, want, 1500)) return true;
    }
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    if (await verifyValue(input, want, 1500)) return true;
    // 값이 보여도 미확정일 수 있음 — 입력란 재클릭 + 옵션 클릭으로 커밋
    return commitReclick(input, want);
  }
  // 한 항목 선택 — 4가지 경로 순서대로. 값 반영 확인은 항상 폴링으로.
  async function pickOption(input, want) {
    // ① 마우스: 입력란 클릭으로 열기
    for (let attempt = 0; attempt < 2; attempt++) {
      openList(input);
      const opt = await waitForOption(input, want, 2200);
      if (opt) { clickEl(opt); if (await verifyValue(input, want, 2000)) return true; }
      esc(input); await sleep(250);
    }
    // ② 토글: 입력란 옆의 열기 버튼(화살표 등) 클릭
    for (const op of openers(input)) {
      openList(input);
      clickEl(op);
      const opt = await waitForOption(input, want, 2500);
      if (opt) { clickEl(opt); if (await verifyValue(input, want, 2000)) return true; }
      esc(input); await sleep(250);
    }
    // ③ 자동완성 타이핑: 이 시스템의 목록은 입력으로 필터되는 방식 → 네이티브 경로
    for (let attempt = 0; attempt < 2; attempt++) {
      if (await typeSelect(input, want)) return true;
      esc(input); await sleep(250);
    }
    // ④ 키보드: Alt+↓(열기) → ↓ 이동(가상 목록이 포커스 항목을 렌더) → 클릭 또는 Enter
    try { input.focus(); } catch {}
    const kd = (k, alt) => input.dispatchEvent(new KeyboardEvent('keydown',
      { key: k, altKey: !!alt, bubbles: true, cancelable: true }));
    kd('ArrowDown', true);
    await sleep(500);
    for (let i = 0; i < 40; i++) {
      kd('ArrowDown');
      await sleep(120);
      const opt = findOptionNow(input, want);
      if (opt) {
        clickEl(opt);
        if (await verifyValue(input, want, 1500)) return true;
        kd('Enter');
        if (await verifyValue(input, want, 1500)) return true;
      }
    }
    // ⑤ 최종: 값이 '전체'로 보여도 미확정일 수 있으므로 재클릭 커밋을 한 번 더
    if (await commitReclick(input, want)) return true;
    return norm(input.value) === want;
  }

  const stateOk = async runId => {
    const { state } = await chrome.storage.local.get('state');
    return !!state?.running && state.runId === runId;
  };

  // 진단 정보 (버튼 목록 등) — 문제 보고용
  function diag(extra = {}) {
    const p = dateInputs();
    return {
      host: location.hostname,
      dates: p ? [p.from.value, p.to.value] : null,
      lists: listInputs().map((el, i) => `${fieldName(el, i)}=${el.value || '빈값'}`),
      ...extra
    };
  }

  globalThis.CardAuto = {
    // 화면 상태 요약 (백그라운드가 이 결과로 단계를 판단)
    async probe() {
      // 포털(hwenc.cleverse.kr) 화면: 로그인 대기 / E-Accounting 버튼 확인
      const isPortal = C.portal?.hostMatch?.test(location.hostname) || false;
      let loginNeeded = false, eaBtn = false;
      if (isPortal) {
        try {
          const pw = document.querySelector(C.portal.loginInput);
          loginNeeded = !!pw && visible(pw);
        } catch { loginNeeded = false; }
        const btns = all().filter(el => el.tagName === 'BUTTON' && visible(el) &&
          C.portal.eaButton.test(text(el)));
        eaBtn = btns.length === 1;
      }
      const form = !!dateInputs();
      // 메뉴: 뒤쪽(하위) 메뉴부터 우선
      let menuIdx = -1, menuLabel = '';
      const path = C.site?.menuPath || [];
      for (let i = path.length - 1; i >= 0; i--) {
        const hits = byText(path[i]);
        if (hits.length) { menuIdx = i; menuLabel = text(hits[0]); break; }
      }
      const sE = finder('search'), xE = finder('excel');
      // 조회 결과 행 수 — 레이아웃용 표를 제외하기 위해 데이터 셀 3개 이상인 행만 계산
      let rows = 0;
      try {
        for (const table of document.querySelectorAll(C.selectors.resultTable)) {
          const data = [...table.querySelectorAll(C.selectors.resultRows)]
            .filter(tr => tr.querySelectorAll('td, [role="cell"], [role="gridcell"]').length >= 3).length;
          rows = Math.max(rows, data);
        }
      } catch {}
      const empty = C.labels.noRows.test(text(document.body).slice(0, 20000));
      return {
        isPortal, loginNeeded, eaBtn, form, menuIdx, menuLabel,
        search: sE.length === 1, searchMulti: sE.length > 1,
        excel: xE.length === 1, excelMulti: xE.length > 1,
        rows, empty: empty && rows === 0,
        diag: diag(),
      };
    },

    // 포털에서 E-Accounting 버튼 클릭
    async navEa(runId) {
      if (!await stateOk(runId)) return false;
      const btns = all().filter(el => el.tagName === 'BUTTON' && visible(el) &&
        C.portal.eaButton.test(text(el)));
      if (btns.length !== 1) return false;
      btns[0].scrollIntoView({ block: 'center', behavior: 'instant' });
      btns[0].click();
      return true;
    },

    // 메뉴 항목 클릭 (menuPath[idx])
    async navClick(idx, runId) {
      if (!await stateOk(runId)) return false;
      const re = C.site?.menuPath?.[idx];
      if (!re) return false;
      const els = byText(re);
      if (!els.length) return false;
      els[0].scrollIntoView({ block: 'center', behavior: 'instant' });
      els[0].click();
      return true;
    },

    // 조회조건 입력: 모든 목록(담당자·상태 등)을 '전체'로 + 시작일/종료일
    async fill(from, to, runId) {
      if (!await stateOk(runId)) return null;
      const warn = [];
      const want = C.site.selectOptionText;
      // ① 드롭다운 전부 처리 (이미 '전체'인 것은 건드리지 않음)
      const applied = [], fail = [];
      const lists = listInputs();
      const only = C.site.selectOnly || [], skip = C.site.selectSkip || [];
      for (let i = 0; i < lists.length; i++) {
        const sel = lists[i], name = fieldName(sel, i);
        // 하단 '처리' 영역(행 처리 폼) 등 조회조건이 아닌 목록은 절대 건드리지 않음
        if (skip.some(s => name.includes(s))) { applied.push(`${name}:건드리지않음`); continue; }
        // 상위 조회조건 화이트리스트에 없는 목록도 건드리지 않음
        if (only.length && !only.some(t => name.includes(t))) { applied.push(`${name}:제외`); continue; }
        if (norm(sel.value) === want) { applied.push(`${name}:유지`); continue; }
        const ok = await pickOption(sel, want);
        if (ok) applied.push(`${name}:${norm(sel.value)}`);
        else fail.push(`${name}(보임: ${optionsSeen().join('/') || '없음'})`);
        sel.blur();
        await sleep(200);
      }
      // ② 날짜 입력
      const p = dateInputs();
      if (!p) return { ok: false, selectOk: !fail.length, selectInfo: applied.join(', '),
        warn: '날짜 입력란을 찾지 못함' };
      setVal(p.from, toFmt(from, p.from));
      setVal(p.to, toFmt(to, p.to));
      await sleep(300);
      const dr = await commitDates(p, from, to);
      const datesOk = dr.ok;
      if (!dr.ok) warn.push(`날짜 미반영 — ${dr.info}`);
      return { ok: datesOk, selectOk: !fail.length,
        selectInfo: applied.join(', ') + (fail.length ? ` 실패:${fail.join(', ')}` : ''),
        warn: warn.join(' / ') };
    },

    // 조회 직전 날짜 재확인 — 픽커가 내부값으로 되돌렸으면 다시 입력, 그래도 불일치면 조회 중단 신호
    async checkDates(from, to, runId) {
      if (!await stateOk(runId)) return { ok: true };
      const p = dateInputs();
      if (!p) return { ok: true };
      return commitDates(p, from, to);
    },

    // 조회/엑셀 버튼 클릭
    async click(kind, runId) {
      if (!await stateOk(runId)) return false;
      const el = finder(kind)[0];
      if (!el) return false;
      el.scrollIntoView({ block: 'center', behavior: 'instant' });
      el.click();
      return true;
    }
  };

  // MV3 서비스 워커가 실행 중 잠들지 않도록 주기적으로 깨움
  const timer = setInterval(async () => {
    try {
      const { state } = await chrome.storage.local.get('state');
      if (state?.running) await chrome.runtime.sendMessage({ type: 'WAKE' });
    } catch { clearInterval(timer); }
  }, 10000);
})();
