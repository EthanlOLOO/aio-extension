/**
 * 네이버페이 간편결제 비밀번호 자판 읽기.
 *
 * node/src/naver/pin.ts 의 KEYPAD_JS 를 옮긴 것이다. 거기서 설명한 그대로다:
 *   자판 숫자는 글자가 아니라 스프라이트 그림이고, 매 결제(때로는 매 입력)마다 자리가 바뀐다.
 *   키마다 보여 주는 조각을 12×16 그물로 줄여 본보기 + 글꼴 투표로 숫자를 맞춘다.
 *
 * 다른 점은 둘뿐이다.
 *   - 그림 로딩을 바쁜 대기 대신 onload 로 기다린다 (decode() 는 창이 가려지면 끝나지 않는다).
 *   - 셀레니움 참조 대신 DOM 요소를 그대로 돌려준다.
 * 판독 규칙을 고칠 일이 생기면 **pin.ts · bnkr-test/browser.ts 와 같이 고친다.**
 */
(() => {
  const CW = 12, CH = 16;
  const ORDER = "1482967350";
  const TEMPLATES = [
    "A/D/P//P8PwPAPAPAPAPAPAPAPAPAPAP",  // 1
    "A8A8B8BsDMHMGMOMcMYM4M////AMAMAM",  // 4
    "DwP8PecOcGcGOOH4P8eO4H4H4HcPP+H4",  // 8
    "HwP8f+4H4HAHAOAOAcA4DwHgPAeA////",  // 2
    "GAfAfg5wwwwwwxxxfxfxOwAwwwZgfgPA",  // 9
    "DwH8P+cHYA4A78/++P8H4H4HcHOPP+H4",  // 6
    "//////AHAOAOAcA4A4BwBwDgDAHAHAOA",  // 7
    "DwH8f+cPYHAGAOD8D8APAHAH4HcPP+H8",  // 3
    "f+f+f+cA4A4A78/+8HAHAH4H4HcPf+H4",  // 5
    "Hgf4/84ewOwPgPgPgHgHwPwOwO4c/8Pw",  // 0
  ];
  const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const TPL = TEMPLATES.map((s) => {
    const bits = [];
    for (const ch of s) {
      const v = B64.indexOf(ch);
      for (let k = 5; k >= 0; k--) bits.push((v >> k) & 1);
    }
    return bits;
  });
  const FONT_VOTERS = ["Arial Black", "Arial", "Malgun Gothic", "Segoe UI", "Arial Rounded MT Bold"];
  const refCache = {};
  const spriteCache = {};

  function visible(el) {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const s = getComputedStyle(el);
    return s.visibility !== "hidden" && s.display !== "none" && s.opacity !== "0";
  }

  function clickable(el) {
    for (let up = el; up && up !== document.body; up = up.parentElement) {
      const tag = up.tagName;
      if (tag === "A" || tag === "BUTTON" || tag === "LABEL" || tag === "INPUT") return up;
      if (up.getAttribute("onclick") || up.getAttribute("role") === "button") return up;
    }
    return null;
  }

  /** 잉크만 남은 부분을 감싸 잘라 CW×CH 그물로 줄인다. */
  function grid(alphaAt, x0, y0, w, h) {
    let minX = x0 + w, minY = y0 + h, maxX = x0, maxY = y0, found = false;
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) {
      if (alphaAt(x, y)) {
        found = true;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
    if (!found) return null;
    const bits = [];
    for (let r = 0; r < CH; r++) {
      const ya = minY + Math.floor((maxY - minY + 1) * r / CH);
      const yb = minY + Math.floor((maxY - minY + 1) * (r + 1) / CH) - 1;
      for (let c = 0; c < CW; c++) {
        const xa = minX + Math.floor((maxX - minX + 1) * c / CW);
        const xb = minX + Math.floor((maxX - minX + 1) * (c + 1) / CW) - 1;
        let tot = 0, cnt = 0;
        for (let y = ya; y <= yb; y++) for (let x = xa; x <= xb; x++) { tot++; if (alphaAt(x, y)) cnt++; }
        bits.push(tot > 0 && cnt / tot >= 0.35 ? 1 : 0);
      }
    }
    return bits;
  }

  function compareBits(a, b) {
    let best = -1;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      let same = 0, tot = 0;
      for (let r = 0; r < CH; r++) for (let c = 0; c < CW; c++) {
        const rr = r + dy, cc = c + dx;
        if (rr < 0 || rr >= CH || cc < 0 || cc >= CW) continue;
        if (a[r * CW + c] === b[rr * CW + cc]) same++;
        tot++;
      }
      if (tot > 0 && same / tot > best) best = same / tot;
    }
    return best;
  }

  function refBits(font, ch) {
    const key = font + "/" + ch;
    if (key in refCache) return refCache[key];
    const c = document.createElement("canvas");
    c.width = 96; c.height = 132;
    const x = c.getContext("2d");
    x.font = "600 58px " + font;
    x.textAlign = "center"; x.textBaseline = "middle";
    x.fillStyle = "#000";
    x.fillText(ch, 48, 68);
    const d = x.getImageData(0, 0, 96, 132).data;
    return (refCache[key] = grid((px, py) => d[(py * 96 + px) * 4 + 3] > 100, 0, 0, 96, 132));
  }

  function classify(bits) {
    const totals = new Array(10).fill(0);
    let tBest = -1, tV = -1;
    TPL.forEach((t, i) => {
      const v = compareBits(bits, t);
      if (v > tV) { tV = v; tBest = i; }
    });
    totals[Number(ORDER[tBest])] += tV;
    for (const font of FONT_VOTERS) {
      let best = -1, bv = -1;
      for (let d = 0; d <= 9; d++) {
        const rb = refBits(font, String(d));
        if (!rb) continue;
        const v = compareBits(bits, rb);
        if (v > bv) { bv = v; best = d; }
      }
      if (best >= 0) totals[best] += bv;
    }
    let win = 0;
    for (let d = 1; d <= 9; d++) if (totals[d] > totals[win]) win = d;
    const sorted = totals.slice().sort((a, b) => b - a);
    return { digit: String(win), score: sorted[0], next: sorted[1] };
  }

  async function sprite(url) {
    if (spriteCache[url]) return spriteCache[url];
    // img.decode() 는 창이 가려져(백그라운드) 있으면 끝나지 않는다 — 그러면 자판을 영영 못 읽는다.
    // onload 는 가려져 있어도 온다. 데이터 URL 이라 보통 몇 ms 안에 끝나고, 2초가 지나면 포기한다.
    const img = new Image();
    await new Promise((ok, bad) => {
      const timer = setTimeout(() => bad(new Error("sprite timeout")), 2000);
      img.onload = () => { clearTimeout(timer); ok(); };
      img.onerror = () => { clearTimeout(timer); bad(new Error("sprite error")); };
      img.src = url;
    });
    const c = document.createElement("canvas");
    c.width = img.width; c.height = img.height;
    const ctx = c.getContext("2d");
    ctx.drawImage(img, 0, 0);
    const data = ctx.getImageData(0, 0, img.width, img.height).data;
    return (spriteCache[url] = { W: img.width, H: img.height, data });
  }

  /**
   * 자판을 읽는다.
   *   null                             자판이 아직 없다
   *   { ok: false, why }               자판은 있는데 0-9 를 한 자씩 못 읽었다
   *   { ok: true, keys: Map(숫자→버튼), debug }
   */
  async function readKeypad() {
    let keyboard = document.getElementById("keyboard");
    if (!keyboard) {
      const tbl = document.querySelector("table[class*='SecureKeyboard_keyboard'], [class*='SecureKeyboard_keyboard']");
      if (tbl) keyboard = tbl.parentElement;
    }
    // 그릇은 있는데 아직 안 보이면 뜨지 않은 것이다. "못 읽었다" 로 치면 2초 뒤 포기해 버린다.
    if (!keyboard || !visible(keyboard)) return null;

    const spans = [...keyboard.querySelectorAll("span")].filter((s) => {
      const bg = s.style && s.style.backgroundImage;
      return bg && bg.includes("data:image");
    });
    if (spans.length < 9) return null;

    const debug = [];
    const keys = new Map();
    for (const span of spans) {
      const btn = clickable(span);
      if (!btn) continue;
      const url = span.style.backgroundImage.replace(/^url\(["']?/, "").replace(/["']?\)$/, "");
      let sp;
      try {
        sp = await sprite(url);
      } catch {
        return { ok: false, why: "스프라이트를 못 읽었습니다" };
      }
      const cs = getComputedStyle(span);
      const [px0, py0] = cs.backgroundPosition.split(/\s+/).map(parseFloat);
      const sw = span.offsetWidth || 0, sh = span.offsetHeight || 0;
      if (isNaN(px0) || isNaN(py0) || !sw || !sh) {
        debug.push("pos=" + cs.backgroundPosition);
        continue;
      }
      let sx = -px0, sy = -py0, fw = sw, fh = sh;
      const [bw, bh] = cs.backgroundSize.split(/\s+/).map(parseFloat);
      if (!isNaN(bw) && !isNaN(bh) && bw > 0 && bh > 0) {
        sx = -px0 * (sp.W / bw); fw = sw * (sp.W / bw);
        sy = -py0 * (sp.H / bh); fh = sh * (sp.H / bh);
      }
      const alphaAt = (x, y) =>
        x >= 0 && y >= 0 && x < sp.W && y < sp.H && sp.data[(y * sp.W + x) * 4 + 3] > 100;
      const bits = grid(alphaAt, Math.round(sx), Math.round(sy), Math.round(fw), Math.round(fh));
      if (!bits) continue;
      const m = classify(bits);
      keys.set(m.digit, btn);
      debug.push(`${m.digit}:${m.score.toFixed(2)}/${m.next.toFixed(2)}`);
    }
    for (let d = 0; d <= 9; d++) {
      if (!keys.has(String(d))) return { ok: false, why: `${d} 을 못 찾았습니다 (${debug.join(" ")})` };
    }
    return { ok: true, keys, debug: debug.join(" ") };
  }

  /** 채워진 비밀번호 점 개수. 점이 없는 화면이면 null. */
  function dots() {
    const all = document.querySelectorAll('[class*="Password_dot"]');
    if (!all.length) return null;
    let n = 0;
    all.forEach((el) => { if (String(el.className).includes("Password_on")) n++; });
    return n;
  }

  /**
   * 틀렸다는 말이 떠 있는가. 뜨면 다시 넣지 않는다 — 몇 번 틀리면 결제가 잠긴다.
   * "5회 잘못·재설정" 은 롯데온 자판이 잠긴 것이다 (lotte-test/browser.ts PIN_ERROR_JS,
   * 2026-08-25 에 시험하다 실제로 잠겼다).
   */
  function pinRejected() {
    return /비밀번호가 일치하지|비밀번호가 올바르지|비밀번호를 다시|비밀번호가 틀렸|간편비밀번호가 일치|5회 잘못|재설정하세요/
      .test(document.body.innerText || "");
  }

  // ── L.PAY (롯데온) ─────────────────────────────────────
  //
  // 2026-08-25 에 받아 적은 자판 (lotteon-test-keypad-html.txt). 네이버페이와 달리 숫자가
  // **글자로** 들어 있고, 주문서 위에 뜨는 레이어라 새 창도 iframe 도 아니다.
  //
  //   <section class="btnSection">
  //     <button class="btnCustom btnCustom_1" id="z8uvjhswx3"><span>1</span></button>
  //     <div class="btnCustom dummy dummy_1"></div>          ← 빈 칸. 자리를 섞으려고 끼운다
  //     …
  //     <button class="btnCustom enter ir_pm ACoff">확인…</button>
  //
  // 버튼 클래스의 숫자(btnCustom_1)와 글자가 같았지만, 글자를 믿는다. 클래스 이름은 언제
  // 섞일지 모른다.

  /**
   * 숫자 키가 든 그릇. **`.btnSection` 을 querySelector 로 하나만 집으면 안 된다** — 흔한 이름이라
   * 주문서의 다른 곳에 먼저 있으면 그걸 집고 자판을 못 찾는다. 보이는 숫자 키(btnCustom)를
   * 가장 많이 품은 그릇을 고른다. 2026-08-25 기록의 그릇 이름은 ownKeypadCustom 이었다.
   */
  function lpayBowl() {
    let best = null, most = 0;
    const bowls = document.querySelectorAll(".btnSection, [class*='ownKeypad'], [class*='Keypad'], [class*='keypad']");
    for (const bowl of bowls) {
      if (!visible(bowl)) continue;
      let n = 0;
      for (const b of bowl.querySelectorAll("button")) {
        if (/^[0-9]$/.test((b.textContent || "").replace(/\s+/g, "")) && visible(b)) n++;
      }
      // 같은 수면 안쪽(더 작은) 그릇이 낫다 — 확인 키를 찾을 때 엉뚱한 버튼을 덜 본다.
      if (n > most || (n === most && n > 0 && best && best.contains(bowl))) { best = bowl; most = n; }
    }
    return most ? best : null;
  }

  async function readLpay() {
    const bowl = lpayBowl();
    if (!bowl) return null;
    const keys = new Map();
    for (const btn of bowl.querySelectorAll("button")) {
      const t = (btn.textContent || "").replace(/\s+/g, "");
      if (/^[0-9]$/.test(t) && visible(btn)) keys.set(t, btn);
    }
    if (keys.size < 10) return { ok: false, why: `숫자 키가 ${keys.size}개뿐입니다` };
    const debug = [...keys.keys()].map((d) => {
      const r = keys.get(d).getBoundingClientRect();
      return `${d}@${Math.round(r.left)},${Math.round(r.top)}`;
    }).join(" ");
    return { ok: true, keys, debug };
  }

  /** 채워진 점. `<div class="apiPassword"><span class="on">*</span>…` (lotte-test PROGRESS_JS). */
  function lpayDots() {
    const seats = document.querySelectorAll(".apiPassword span, [class*='apiPassword'] span");
    if (!seats.length) return null;
    return [...seats].filter((s) => s.classList.contains("on")).length;
  }

  /** 여섯 자리 뒤에도 자판이 남아 있으면 누를 확인 키. */
  function lpayConfirm() {
    const bowl = lpayBowl();
    if (!bowl) return null;
    return bowl.querySelector("button.enter") ||
      [...bowl.querySelectorAll("button")].find((b) => (b.textContent || "").trim().startsWith("확인")) || null;
  }

  globalThis.AIO_KEYPAD = {
    visible, pinRejected,
    npay: { read: readKeypad, dots, confirm: () => null },
    lpay: { read: readLpay, dots: lpayDots, confirm: lpayConfirm },
  };
})();
