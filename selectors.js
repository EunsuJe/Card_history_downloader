// ════════════════════════════════════════════════════════════════
//  법인카드 내역 조회·다운로드 — 사이트별 설정
//  ① 포털(hwenc.cleverse.kr) → E-Accounting 진입  ② E-Accounting(ea.hwenc.com) 조회·다운로드
//  수정하는 부분은 대부분 이 파일 하나뿐입니다.
// ════════════════════════════════════════════════════════════════
globalThis.CARD_CONFIG = Object.freeze({
  pollMs: 300,             // 화면 상태 확인 주기 (ms)
  stepTimeoutMs: 15000,    // 같은 단계에서 재시도가 허용되는 최소 간격 (ms)
  hardResultWaitS: 12,     // 결과 표를 못 찾아도 다운로드로 넘어가는 시간 (초)
  downloadTimeoutS: 90,    // 다운로드 완료 대기 최대 시간 (초)

  defaults: {
    dFill: 1.5,            // 조건 입력 → 조회 클릭까지 대기 (초)
    dSearch: 2,            // 조회 클릭 → 결과 판정 시작까지 (초)
    dResult: 4,            // 결과 확인 → 엑셀 클릭까지 (초)
  },

  // ── 포털(hwenc.cleverse.kr) 앞단 설정 ──
  // localhost / 127.0.0.1 은 mock-test 폴더 모의 화면 테스트용 — 실사용 시 제거해도 됩니다.
  portal: {
    hostMatch: /(^|\.)cleverse\.kr$|^127\.0\.0\.1$/,  // 포털 화면으로 보는 도메인
    eaTarget:  /(^|\.)hwenc\.com$|(^|\.)localhost$/,  // E-Accounting 화면으로 보는 도메인
    eaButton:  /^E-?Accounting$/i,         // E-Accounting 버튼 문구
    loginInput: 'input[type="password"]',  // 로그인 화면 판정용
    enteringTimeoutS: 180,                 // E-Accounting 창 열림 최대 대기 (초)
  },

  // ── E-Accounting 화면 설정 ──
  site: {
    // 메뉴 이동: 이미 조회 화면이 열려 있으면 자동으로 건너뜁니다.
    menuPath: [
      /^개인\s*경비$/,
      /^법인카드\s*경비\s*신청$/,
    ],

    // 상태 드롭다운을 '전체'로 변경
    selectInput: 'input[aria-autocomplete="list"]',
    selectIndex: 0,          // 0 = 첫 번째 (상태 필드)
    selectOptionText: '전체',

    // 조회조건으로 실제로 바꿀 목록 화이트리스트 (이름에 이 문자열이 포함된 목록만 '전체'로 변경)
    // 화면 상단의 조회조건(담당자/법인/대상/상태)만 대상으로 합니다.
    selectOnly: ['담당자', '법인', '대상', '상태'],

    // 절대 건드리지 않을 목록 — 하단 '처리' 영역(행 처리 폼)의 처리/실사용자/귀속부서/계정/품의 등
    // (이름에 이 문자열이 포함되면 무조건 스킵. selectOnly보다 우선)
    selectSkip: ['처리', '실사용자', '귀속부서', '계정', '품의'],

    // 날짜 입력 형식: 'auto' = 입력란 기존 값을 보고 판단
    // 안 맞으면 'YYYYMMDD' | 'YYYY-MM-DD' | 'YYYY.MM.DD' | 'YYYY/MM/DD' 로 지정
    dateFormat: 'auto',

    // 이 시스템은 조회/엑셀 버튼에 항상 disabled="" 속성이 붙어 있으므로
    // 이 속성을 무시하고 클릭합니다 (true 유지 권장)
    ignoreDisabled: true,
  },

  // ── 버튼/문구 인식 규칙 (요소 라벨 텍스트와 비교) ──
  labels: {
    search:  /^조회(?:하기)?$/,
    excel:   /^엑셀(?:\s*다운로드)?$/,
    noRows:  /데이터가\s?없|내역이\s?없|조회된?\s?(?:결과가|내역이)\s?없|0\s?건|no\s?data/i,
    loading: /로딩|조회\s?중|처리\s?중|loading|please wait/i,
  },

  // ── 요소 셀렉터 ──
  selectors: {
    dateFrom: 'input[aria-label="시작일자"]',
    dateTo:   'input[aria-label="종료일자"]',
    searchBtn: '',           // 정확한 셀렉터를 알면 지정, 예: '#btnSearch'
    excelBtn: '',
    dateInputHint: /date|cal|dt|day|일자|기간|start|end|from|to|sdate|edate/i,
    resultTable: 'table, [role="grid"]',
    resultRows:  'tbody tr, [role="row"]',
    clickable: 'button, a, [role="button"], [role="link"], input[type="button"], input[type="submit"], input[type="image"]',
  },
});
