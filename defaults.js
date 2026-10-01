/**
 * 기본 설정. **처음에는 전부 꺼져 있다.** 켜는 것은 팝업·설정 화면에서 사람이 한다.
 *
 * 흐름(flows)의 단계는 node 판 설정의 pg_clicks · pg_finish 와 같은 모양이다.
 *   "글자"                          그 글자가 보이는 버튼·링크·라벨을 누른다
 *   { text: ["가", "나"] }           앞엣것부터 찾아 보고 처음 찾은 것을 누른다
 *   { text, contains: true }        품고 있기만 하면 된다 (금액 롤러가 든 결제 버튼)
 *   { text, class: "button-pay" }   클래스에 이 말이 든 것을 먼저 고른다
 *   { fill: "#css", value: "..." }  칸을 채운다
 * trusted: true 면 진짜 클릭(chrome.debugger)으로 누른다. 그 흐름의 페이지가 열리자마자 미리 켜 둔다.
 * kind 가 있으면 글자 목록 대신 content.js 의 그 이름 처리기가 맡는다 (naverBuy).
 * match 는 주소에 들어 있어야 할 조각이다. 결제창이 iframe 이면 그 iframe 의 주소로 본다.
 * site 는 팝업에서 묶어 보여 줄 자리다 (SITES 의 id).
 */

/** 팝업에 이 순서로 묶어 보여 준다. */
export const SITES = [
  { id: "naver", name: "네이버" },
  { id: "lotte", name: "롯데온" },
  { id: "bnkr", name: "반다이남코몰" },
];

export const DEFAULT_SETTINGS = {
  enabled: false,
  dryRun: false,

  flows: [
    // ── 네이버 ──
    {
      id: "naver-buy",
      site: "naver",
      name: "상품 페이지 → 구매하기 (옵션 없는 상품만)",
      enabled: false,
      // 누르는 순서가 글자 목록으로는 안 적혀서(옵션 판단·레이어) content.js naverBuy 가 따로 맡는다.
      kind: "naverBuy",
      match: ["brand.naver.com/", "smartstore.naver.com/"],   // 그중 /products/<번호> 만
      trusted: true,
      // node/src/naver/browser.ts BUY_TEXTS · LAYER_MARKS · LAYER_CONFIRM 그대로.
      // 구매하기는 주문서로 곧장 가지 않고 레이어를 띄우는 일이 있다. 레이어가 뜨면 그 안에서 한 번 더 누른다.
      steps: [{ text: ["구매하기", "바로구매", "바로 구매"], retry: { afterMs: 1500, max: 4 } }],
      layerMarks: ["상품 구매 옵션", "수량 선택"],
      layerConfirm: ["바로구매", "바로 구매", "구매하기"],
      // 옵션 선택 칸의 글자 (상태 JSON 을 못 읽었을 때만 본다). node 판 OPTION_OPENERS.
      optionOpeners: ["옵션 선택", "옵션선택", "선택하세요", "선택해주세요", "선택해 주세요"],
    },
    {
      id: "naver-order",
      site: "naver",
      name: "주문서 → 결제하기",
      enabled: false,
      match: ["orders.pay.naver.com"],
      // node/src/naver/browser.ts PAY_FIND_JS 와 같은 기준. 버튼 글자가 금액 롤러 때문에 수십 자다.
      steps: [{ text: "결제하기", contains: true, class: "button-pay" }],
      settleMs: 0,
      trusted: true,   // 진짜 클릭 (L.PAY 처럼). 주문서가 열리자마자 켜 둔다 — content.js prepareReal
    },
    {
      id: "npay-finish",
      site: "naver",
      name: "네이버페이 마지막 확인 (비밀번호 뒤)",
      enabled: false,
      match: ["://pay.naver.com"],  // orders.pay.naver.com(주문서)은 빼려고 앞에 :// 를 붙였다
      // bnkr-test/config.ts NPAY_FINISH. 앞엣것을 못 찾으면 뒤엣것은 누르지 않는다.
      steps: ["결제내용에 동의", "결제"],
      // 동의 체크 → 결제 버튼이 살아나는 사이. 기본 0.7초는 길다. 버튼이 아직 죽어 있으면
      // findTarget 이 disabled 를 건너뛰므로 살아나는 바퀴에 누른다.
      settleMs: 100,
      trusted: true,
    },

    // ── 롯데온 ──
    {
      id: "lotte-buy",
      site: "lotte",
      name: "상품 페이지 → 바로 구매하기",
      enabled: false,
      match: ["lotteon.com/p/product/", "lotteon.com/m/product/"],
      // node/src/lotte/browser.ts BUY_TEXTS. 실제 버튼은 띄어쓰기가 있는 "바로 구매하기" 다.
      //   <button class="hasBgColor bgColorRed sizeLarge alignLeft">바로 구매하기</button>
      // 같은 줄의 "장바구니 담기"·"선물하기" 는 글자가 달라 걸리지 않는다.
      // 버튼이 없으면(품절) 기다리기만 하고, 생기는 순간 누른다.
      // 화면 밖에 숨은 건너뛰기 링크 <a href="#toGoPurchase">구매하기</a> 가 있어서 "구매하기" 는 넣지 않는다.
      //
      // readyMs: 버튼이 이만큼 그대로 있을 때 누른다. 뜨자마자 누르면 사이트가 상품 데이터를 덜
      //   불러온 채라 눌러도 아무 일이 없을 수 있다. 재 보니(2026-09-19) 버튼은 0.9초에 뜨고 페이지
      //   로딩 완료는 2.8초였다 — 로딩 완료까지 기다리면 2초를 버린다. 그래서 짧게 두고 retry 로 받친다.
      // retry: 누른 뒤 afterMs 가 지나도 주소가 그대로고 버튼이 그대로면 다시 누른다 (max 번까지).
      //   주문서로 가는 버튼이라 다시 눌러도 결제되지 않는다. 결제 버튼에는 쓰지 말 것.
      steps: [{ text: ["바로 구매하기", "바로구매"], readyMs: 300, retry: { afterMs: 1500, max: 4 } }],
      // 품절 글자가 버튼에 보이면 reloadSeconds 초 뒤 새로고침한다. 0 이면 안 한다 (팝업에서 켠다).
      // 2026-09-19 에 본 품절 버튼: <button class="hasBgColor bgColorRed …">일시품절된 상품입니다</button>
      soldOutText: ["일시품절", "품절", "판매종료", "판매 종료"],
      reloadSeconds: 0,
    },
    {
      id: "lotte-order",
      site: "lotte",
      name: "주문서 → 결제하기",
      enabled: false,
      match: ["/order/orderSheet"],
      steps: [{ text: "결제하기", contains: true }],
    },

    // ── 반다이남코몰 ──
    {
      id: "bnkr-npay",
      site: "bnkr",
      name: "결제창 → 네이버페이",
      enabled: false,
      match: ["bnkrmall.co.kr"],
      // bnkr-test/config.ts NPAY_CLICKS. 결제창이 다른 주소의 iframe 이면 그 주소도 match 에 넣는다.
      steps: ["동의합니다", "다음", "네이버페이", "다음", "결제하기"],
      settleMs: 900,
    },
  ],

  // 간편결제 비밀번호. 비밀번호 값은 여기 두지 않는다 (background.js 의 pin 저장소).
  pins: {
    npay: {
      site: "naver",
      name: "네이버페이",
      enabled: false,
      // 인증 화면 주소 (pin.ts AUTH_MARK). 2026-08-24 에 본 것은 pay.naver.com/authentication/pw/check.
      match: ["pay.naver.com/authentication"],
    },
    lpay: {
      site: "lotte",
      name: "L.PAY",
      enabled: false,
      // L.PAY 자판은 주문서 위에 뜨는 레이어다. 자판(.btnSection)이 보일 때만 움직인다.
      match: ["lotteon.com"],
    },
  },

  // 자판이 자바스크립트 클릭을 무시하면 chrome.debugger 로 누를까: "auto" | "always" | "never"
  trustedClick: "auto",

  // 디스코드 링크 오프너 — 정한 채널에 **웹훅**이 보내고 (링크 또는 @everyone 멘션이 있고)
  // 제외 키워드가 없는 알림이 오면, 그 메시지의 링크를 새 창으로 자동으로 연다.
  // 0.4 의 "모니터링(기록만)" 은 없애고 이 하나로 돌아온다.
  discord: {
    enabled: false,
    token: "",
    channels: [],        // 볼 채널 아이디 (비우면 봇이 보는 모든 채널)
    keywords: [],        // 이 말이 든 알림만 열기 (본문·embed 전체에서 찾는다)
    skipKeywords: [],    // 이 말이 든 알림은 건너뛰기
    openLink: true,      // 링크가 있으면 링크를 연다
    everyoneToUrl: "",   // @everyone 멘션이 있는데 링크가 없을 때 열 주소 (비우면 링크 없는 @everyone 알림은 건다)
    newWindow: true,     // 새 창(window)으로 열까, 아니면 새 탭으로 열까
    reopenSeconds: 30,   // 같은 주소를 이만큼 지나야 다시 연다 (0 = 매번 열기)
  },
};
