/**
 * 모든 창·프레임에 들어가 두 가지를 한다.
 *
 *   1. 클릭 흐름 — 설정의 flows 중 지금 주소에 맞는 것의 단계를 차례로 누른다
 *      (주문서의 결제하기, 결제창의 동의합니다 → 다음 → 네이버페이 → …)
 *   2. 간편결제 비밀번호 — 네이버페이 인증 화면·롯데온 L.PAY 자판이 뜨면 읽어 누른다
 *
 * 둘 다 꺼 두면 아무것도 하지 않는다. 기본은 전부 꺼져 있다.
 *
 * 흐름이 어디까지 갔는지는 background 가 쥐고 있다. 결제창은 새 창·iframe 을 오가며 넘어가서,
 * 한 페이지 안의 변수로는 "지금 몇 번째 단계인가" 를 이어 갈 수 없다. 누르기 전에
 * background 에 그 단계를 "잡는다" — 두 프레임이 같은 단계를 두 번 누르지 않게.
 */
(() => {
  if (globalThis.__aioContent) return;
  globalThis.__aioContent = true;

  const K = globalThis.AIO_KEYPAD;
  const TICK_MS = 200;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  let settings = null;
  let busy = false;
  const pinTried = {};        // 결제수단마다, 이 문서에서 한 번 넣었으면 다시 넣지 않는다

  const send = (msg) => chrome.runtime.sendMessage(msg).catch(() => null);
  const say = (text, level = "info") => send({ type: "log", level, text, where: location.host });

  async function loadSettings() {
    const got = await send({ type: "getSettings" });
    if (got) settings = got;
  }
  chrome.storage.onChanged.addListener((changes, area) => {
    // 저장된 것을 그대로 쓰지 않고 background 에서 다시 받는다 — 옛 모양이면 거기서 맞춰 준다.
    if (area === "local" && changes.settings) loadSettings();
  });

  // ── 찾기·누르기 ────────────────────────────────────────

  function visible(el) {
    return K.visible(el);
  }

  function labelOf(el) {
    const text = (el.textContent || "").replace(/\s+/g, " ").trim();
    return text || (el.value || el.alt || el.getAttribute("aria-label") || el.getAttribute("title") || "").trim();
  }

  const CLICKABLE = 'button, a, label, [role="button"], [role="radio"], [role="checkbox"], input[type="submit"], input[type="button"], input[type="radio"], input[type="checkbox"]';

  /**
   * 누를 것을 찾는다. pin.ts·bnkr-test 와 같은 순서로 고른다 —
   * 누를 수 있는 것 먼저, 글자가 정확히 같은 것 먼저, 짧은 것 먼저.
   * 품고 있는 것은 찾는 글자 + 10자까지만 (contains 를 켜면 길이 제한 없음 — 금액 롤러가 든 버튼).
   */
  function findTarget(step) {
    // text 가 목록이면 앞엣것부터 찾아 본다 (["바로 구매하기", "바로구매"]).
    if (Array.isArray(step.text)) {
      for (const text of step.text) {
        const hit = findTarget({ ...step, text });
        if (hit) return hit;
      }
      return null;
    }
    const want = step.text.replace(/\s+/g, " ").trim();
    const hits = [];
    for (const el of document.querySelectorAll(CLICKABLE)) {
      if (!visible(el) && !(el.tagName === "INPUT" && el.labels && el.labels.length)) continue;
      if (el.disabled || el.getAttribute("aria-disabled") === "true") continue;
      const text = labelOf(el);
      if (!text.includes(want)) continue;
      if (!step.contains && text.length > want.length + 10) continue;
      hits.push({
        el, text, want,
        exact: text === want,
        named: step.class ? String(el.className || "").includes(step.class) : false,
      });
    }
    if (!hits.length) return null;
    hits.sort((a, b) =>
      (b.named - a.named) || (b.exact - a.exact) || (a.text.length - b.text.length));
    return hits[0];
  }

  /** 페이지가 자바스크립트로 값을 읽게 input 이벤트까지 낸다 (React 가 이것만 듣는다). */
  function fill(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
    el.focus();
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  /** 사람이 누른 것처럼 포인터·마우스 이벤트를 차례로 내고 click. */
  function jsClick(el) {
    el.scrollIntoView({ block: "center", inline: "center" });
    const r = el.getBoundingClientRect();
    const at = { bubbles: true, cancelable: true, view: window, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
    el.dispatchEvent(new PointerEvent("pointerdown", { ...at, pointerType: "mouse" }));
    el.dispatchEvent(new MouseEvent("mousedown", at));
    el.dispatchEvent(new PointerEvent("pointerup", { ...at, pointerType: "mouse" }));
    el.dispatchEvent(new MouseEvent("mouseup", at));
    el.click();
  }

  /**
   * 진짜 클릭 (chrome.debugger). 페이지가 isTrusted 를 보고 자바스크립트 클릭을 무시할 때만 쓴다.
   * 좌표가 창 기준이어야 해서 **맨 위 문서에서만** 된다.
   */
  async function trustedClick(el) {
    if (window !== window.top) return false;
    el.scrollIntoView({ block: "center", inline: "center" });
    await sleep(50);
    const r = el.getBoundingClientRect();
    const got = await send({ type: "trustedClick", x: r.left + r.width / 2, y: r.top + r.height / 2 });
    return !!(got && got.ok);
  }

  /**
   * 진짜 클릭을 **미리** 켠다. 켜는 순간 크롬 위에 "디버깅 중" 띠가 생기며 페이지가 아래로 밀려서,
   * 켜면서 잰 좌표는 버튼 옆을 누를 수 있다 (L.PAY 에서 배운 것, 2026-09-19). 그래서 누를 일이 있는
   * 페이지가 열리면 먼저 켜 두고, 막 켰으면 띠가 자리 잡을 때까지 기다린다. 한 문서에서 한 번만 한다.
   * → 진짜 클릭을 쓸 수 있는가
   */
  let realReady = null;
  function prepareReal(why) {
    if (window !== window.top || settings.trustedClick === "never" || settings.dryRun) return Promise.resolve(false);
    if (!realReady) {
      realReady = send({ type: "debuggerAttach", holdMs: 60000 }).then(async (got) => {
        if (!got || !got.ok) {
          say(`[${why}] 진짜 클릭을 켜지 못했습니다 (개발자 도구를 닫아 주세요). 자바스크립트 클릭으로 누릅니다.`, "warn");
          return false;
        }
        if (got.fresh) await sleep(500);
        return true;
      });
    }
    return realReady;
  }

  /** 진짜 클릭으로 누른다. 못 켰거나 실패하면 자바스크립트 클릭으로 누른다. */
  async function realClick(el, why) {
    if ((await prepareReal(why)) && (await trustedClick(el))) return;
    jsClick(el);
  }

  // ── 클릭 흐름 ─────────────────────────────────────────

  function matches(flow) {
    const href = location.href;
    return (flow.match || []).some((m) => m && href.includes(m));
  }

  function normStep(step) {
    if (typeof step === "string") return { text: step };
    return step;
  }

  // 흐름마다 이 문서에서 본 것. 페이지가 바뀌면(새 문서) 처음부터 다시 센다.
  const seen = {};      // flow.id → { el, at }   누를 것이 처음 보인 때 (readyMs 를 재려고)
  const tries = {};     // flow.id:단계 → 누른 횟수 (retry)
  const noted = {};     // flow.id → 못 찾은 이유를 이미 기록했는가
  const pageAt = Date.now();
  const finishedHere = new Set();   // 이 페이지에서 끝까지 누른 흐름 (다시 누르기로 되돌리면 뺀다)
  let reloading = false;

  /** 사람이 알아볼 만한 보이는 버튼 글자들. 못 찾았을 때 무엇이 보였는지 남기려는 것. */
  function visibleButtons(pattern) {
    const out = [];
    for (const el of document.querySelectorAll("button, a[role='button'], input[type='submit']")) {
      if (!visible(el)) continue;
      const t = labelOf(el);
      if (t && t.length <= 30 && pattern.test(t) && !out.includes(t)) out.push(t);
    }
    return out.slice(0, 6);
  }

  /**
   * 누를 것이 안 보일 때. 품절 글자가 보이면 reloadSeconds 뒤 새로고침한다 (켜 둔 흐름만).
   * 롯데온 상품 페이지는 재입고돼도 스스로 바뀌지 않는다 — 버튼이 "일시품절된 상품입니다" 인 채로 남는다.
   */
  function missing(flow, step) {
    delete seen[flow.id];
    const soldOut = (flow.soldOutText || []).length
      ? visibleButtons(new RegExp((flow.soldOutText || []).join("|"))) : [];

    if (!noted[flow.id] && Date.now() - pageAt > 6000) {
      noted[flow.id] = true;
      const want = [].concat(step.text).join(" / ");
      const shown = soldOut.length ? soldOut : visibleButtons(/구매|결제|품절|판매|오픈|예정|대기|알림/);
      say(`[${flow.name}] '${want}' 버튼이 안 보입니다${shown.length ? ` — 보이는 버튼: ${shown.join(" · ")}` : ""}`, "warn");
    }

    if (flow.reloadSeconds > 0 && soldOut.length && !reloading && window === window.top && !settings.dryRun) {
      reloading = true;
      setTimeout(() => location.reload(), flow.reloadSeconds * 1000);
    }
  }

  /**
   * 누른 뒤 retry.afterMs 가 지나도 주소가 그대로고 그 버튼이 그대로 보이면, 눌린 것이 안 먹은 것이다.
   * 페이지 데이터가 덜 불러와졌을 때 누르면 사이트가 조용히 무시한다. 단계를 돌려놓아 다시 누르게 한다.
   * 결제 버튼에는 쓰지 않는다 — 두 번 결제될 수 있다. 롯데온 바로 구매하기처럼 주문서로 가는 버튼에만.
   */
  function watchRetry(flow, i, step, el) {
    const key = `${flow.id}:${i}`;
    const n = (tries[key] = (tries[key] || 0) + 1);
    const href = location.href;
    setTimeout(async () => {
      if (location.href !== href || !el.isConnected || !visible(el)) return;
      if (n >= (step.retry.max ?? 3)) {
        say(`[${flow.name}] ${n}번 눌러도 넘어가지 않습니다 — 화면을 확인해 주세요 (옵션 선택·로그인·알림창 등)`, "error");
        return;
      }
      if (await send({ type: "unclaimStep", id: flow.id, index: i })) {
        finishedHere.delete(flow.id);
        say(`[${flow.name}] 눌렀는데 넘어가지 않아 다시 누릅니다 (${n + 1}/${step.retry.max ?? 3})`, "warn");
      }
    }, step.retry.afterMs ?? 2500);
  }

  // ── 네이버 상품 페이지 → 구매하기 (옵션 없는 상품만) ──────────────────────────
  //
  // 글자 목록으로는 안 적히는 흐름이라 따로 둔다. 한 상품 페이지 안에서 시작해 끝난다.
  //   1. 옵션이 있는 상품인가 — 있으면 누르지 않는다 (사람이 고른다)
  //   2. 구매하기를 진짜 클릭으로 누른다
  //   3. 구매 레이어가 뜨면 그 안의 바로구매·구매하기를 한 번 더 누른다 (node 판 throughLayer)
  //   4. 1.5초 지나도 레이어도 안 뜨고 버튼이 그대로면 다시 누른다 (4번까지) — 페이지가 덜
  //      준비됐을 때 누른 첫 클릭은 먹지 않는다 (롯데온에서 본 것)

  function naverProductId() {
    const m = location.pathname.match(/\/products\/(\d+)/);
    return m ? m[1] : null;
  }

  /**
   * window.__PRELOADED_STATE__={…} 를 값으로 만든다 (node/src/naver/product.ts carveJson 그대로).
   * 이건 JSON 이 아니라 자바스크립트 객체 리터럴이라 값 자리에 undefined 가 박혀 있다 — 문자열 밖의
   * undefined·NaN 만 null 로 바꾼다. 상품 설명 HTML 이 문자열로 들어 있어 } 를 정규식으로 끊으면 안 된다.
   * 페이지 스크립트는 격리된 곳에서 돌아 window.__PRELOADED_STATE__ 를 직접 못 본다 — <script> 글자를 읽는다.
   */
  function carveState() {
    for (const script of document.scripts) {
      const text = script.textContent || "";
      const at = text.indexOf("__PRELOADED_STATE__");
      if (at < 0) continue;
      const start = text.indexOf("{", at);
      if (start < 0) continue;
      const out = [];
      let depth = 0, quoted = false, escaped = false, from = start;
      for (let i = start; i < text.length; i++) {
        const ch = text[i];
        if (escaped) { escaped = false; continue; }
        if (quoted) {
          if (ch === "\\") escaped = true;
          else if (ch === '"') quoted = false;
          continue;
        }
        if (ch === '"') quoted = true;
        else if (ch === "{" || ch === "[") depth++;
        else if (ch === "}" || ch === "]") {
          if (--depth === 0) {
            out.push(text.slice(from, i + 1));
            try {
              return JSON.parse(out.join(""));
            } catch {
              return null;
            }
          }
        } else if (ch === "u" && text.startsWith("undefined", i) && !/[\w$]/.test(text[i - 1] || "")) {
          out.push(text.slice(from, i), "null");
          i += 8;
          from = i + 1;
        } else if (ch === "N" && text.startsWith("NaN", i) && !/[\w$]/.test(text[i - 1] || "")) {
          out.push(text.slice(from, i), "null");
          i += 2;
          from = i + 1;
        }
      }
    }
    return null;
  }

  /** 상태 안에서 이 상품(주소의 번호)의 덩어리 중 옵션 정보가 든 것. node 판 findProduct 처럼 번호로 찾는다. */
  function findProduct(state, id) {
    const stack = [state];
    let seen = 0;
    while (stack.length && seen < 300000) {
      const node = stack.pop();
      seen++;
      if (!node || typeof node !== "object") continue;
      if (!Array.isArray(node)) {
        const ids = [node.id, node.channelProductNo, node.productNo].map((v) => (v == null ? "" : String(v)));
        if (ids.includes(id) && ("optionUsable" in node || "optionCombinations" in node)) return node;
      }
      for (const k in node) stack.push(node[k]);
    }
    return null;
  }

  /**
   * 옵션이 있는 상품인가. → true · false · null(모르겠다)
   * 상태 JSON 이 먼저다 (optionUsable, optionCombinations). 못 읽으면 화면의 옵션 선택 칸을 본다.
   * 2026-08-23 의 포켓몬 상품(naver-page-dump.txt)은 "optionUsable": false 였다.
   */
  let optionAnswer;   // undefined = 아직 안 봤다
  function naverHasOptions(flow) {
    if (optionAnswer !== undefined) return optionAnswer;
    const id = naverProductId();
    const product = id ? findProduct(carveState(), id) : null;
    if (product) {
      const combos = product.optionCombinations;
      optionAnswer = product.optionUsable === true || (Array.isArray(combos) && combos.length > 0);
      return optionAnswer;
    }
    // 상태를 못 읽었다 — 옵션 선택 칸이 보이면 옵션 상품이다. 안 보이면 아직 모른다 (다음 바퀴에 또 본다).
    const openers = flow.optionOpeners || [];
    for (const el of document.querySelectorAll("a, button, [role='button'], [role='combobox'], select")) {
      if (!visible(el)) continue;
      const t = labelOf(el);
      if (t.length <= 40 && openers.some((w) => t.includes(w))) return (optionAnswer = true);
    }
    return null;
  }

  /** 레이어 안의 확인 버튼. 처음 누른 버튼을 품지 않은 그릇 중 레이어 글자가 든 곳에 있는 것만. */
  function layerConfirm(flow, clicked) {
    const marks = flow.layerMarks || [];
    for (const want of flow.layerConfirm || []) {
      for (const el of document.querySelectorAll("button, a, [role='button']")) {
        if (el === clicked || !visible(el) || el.disabled) continue;
        const t = labelOf(el);
        if (!t.includes(want) || t.length > want.length + 10) continue;
        for (let up = el.parentElement, n = 0; up && up !== document.body && n < 10; up = up.parentElement, n++) {
          if (up.contains(clicked)) break;   // 본문의 구매 영역이다 — 레이어가 아니다
          const txt = up.textContent || "";
          if (marks.some((m) => txt.includes(m))) return el;
        }
      }
    }
    return null;
  }

  const nb = { phase: "start", clicked: null, at: 0, tries: 0 };

  async function naverBuy(flow) {
    if (nb.phase === "done" || !naverProductId()) return;
    const step = normStep(flow.steps[0]);

    if (nb.phase === "start") {
      const hasOpt = naverHasOptions(flow);
      if (hasOpt === true) {
        nb.phase = "done";
        say(`[${flow.name}] 옵션이 있는 상품이라 구매하기를 누르지 않습니다 — 옵션을 골라 직접 눌러 주세요.`, "warn");
        return;
      }
      const hit = findTarget(step);
      if (!hit) {
        missing(flow, step);
        return;
      }
      // 옵션 여부를 아직 모르면(상태도 못 읽고 옵션 칸도 안 보임) 잠깐 더 본다. 그래도 모르면 누른다 —
      // 옵션 상품에 잘못 눌러도 네이버가 "옵션을 선택해 주세요" 로 막을 뿐이다.
      if (hasOpt === null && Date.now() - pageAt < 800) return;
      if (!(await send({ type: "claimStep", id: flow.id, index: 0 }))) {
        nb.phase = "done";   // 이 페이지에서 이미 눌렀다
        return;
      }
      await pressBuy(flow, hit, hasOpt);
      return;
    }

    // phase === "clicked": 레이어가 떴으면 그 안에서 한 번 더
    const confirm = layerConfirm(flow, nb.clicked);
    if (confirm) {
      nb.phase = "done";
      await realClick(confirm, flow.name);
      say(`[${flow.name}] 구매 레이어에서 '${labelOf(confirm).slice(0, 20)}' 를 눌렀습니다`);
      return;
    }
    // 레이어도 안 뜨고 버튼이 그대로면 안 먹은 것이다 — 다시 누른다
    const retry = step.retry || {};
    if (Date.now() - nb.at < (retry.afterMs ?? 1500)) return;
    if (!nb.clicked.isConnected || !visible(nb.clicked)) {
      nb.phase = "done";   // 버튼이 사라졌다 — 넘어간 것이다
      return;
    }
    if (nb.tries >= (retry.max ?? 4)) {
      nb.phase = "done";
      say(`[${flow.name}] ${nb.tries}번 눌러도 넘어가지 않습니다 — 화면을 확인해 주세요 (로그인·알림창 등)`, "error");
      return;
    }
    const again = findTarget(step);
    if (!again) return;
    say(`[${flow.name}] 눌렀는데 넘어가지 않아 다시 누릅니다 (${nb.tries + 1}/${retry.max ?? 4})`, "warn");
    await pressBuy(flow, again, optionAnswer ?? null);
  }

  async function pressBuy(flow, hit, hasOpt) {
    const why = hasOpt === false ? "옵션 없음" : "옵션 여부 모름";
    nb.tries++;
    if (settings.dryRun) {
      hit.el.style.outline = "3px solid #e11";
      nb.phase = "done";
      say(`[연습] [${flow.name}] '${hit.want}' 를 누를 차례입니다 (${why})`);
      return;
    }
    nb.phase = "clicked";
    nb.clicked = hit.el;
    await realClick(hit.el, flow.name);
    nb.at = Date.now();
    say(`[${flow.name}] '${hit.want}' 를 눌렀습니다 (${why}) ← "${hit.text.slice(0, 30)}"`);
  }

  async function runFlows() {
    for (const flow of settings.flows || []) {
      if (!flow.enabled || !matches(flow)) continue;
      if (flow.kind === "naverBuy") {
        await naverBuy(flow);
        continue;
      }
      if (finishedHere.has(flow.id)) continue;
      const state = await send({ type: "flowState", id: flow.id });
      if (!state) continue;
      if (state.cooling) {
        finishedHere.add(flow.id);   // 이 페이지에선 끝났다. 바퀴마다 백그라운드에 묻지 않는다
        continue;
      }
      const i = state.index;
      const step = normStep(flow.steps[i]);
      if (!step) continue;

      // 앞 단계를 누른 뒤 화면이 자리 잡을 틈을 준다.
      if (Date.now() - state.touchedAt < (flow.settleMs ?? 700)) continue;

      if (step.fill) {
        const el = document.querySelector(step.fill);
        if (!el || !visible(el)) continue;
        if (!(await send({ type: "claimStep", id: flow.id, index: i }))) continue;
        fill(el, step.value ?? "");
        say(`[${flow.name}] ${i + 1}/${flow.steps.length} ${step.fill} 칸을 채웠습니다`);
        continue;
      }

      const hit = findTarget(step);
      if (!hit) {
        missing(flow, step);
        continue;
      }

      // 버튼이 readyMs 동안 그대로 있을 때 누른다. 보이자마자 누르면 사이트가 상품 데이터를
      // 아직 못 불러온 채라 눌러도 아무 일이 없을 수 있다. 페이지 로딩 완료(readyState)는
      // 기다리지 않는다 — 롯데온은 이미지·광고 때문에 버튼보다 2초쯤 늦다.
      const readyMs = step.readyMs ?? flow.readyMs ?? 0;
      if (readyMs) {
        const s = seen[flow.id];
        if (!s || s.el !== hit.el) {
          seen[flow.id] = { el: hit.el, at: Date.now() };
          continue;
        }
        if (Date.now() - s.at < readyMs) continue;
      }

      if (!(await send({ type: "claimStep", id: flow.id, index: i }))) continue;
      if (settings.dryRun) {
        hit.el.style.outline = "3px solid #e11";
        say(`[연습] [${flow.name}] ${i + 1}/${flow.steps.length} '${hit.want}' ← "${hit.text.slice(0, 40)}"`);
      } else {
        if (flow.trusted || step.trusted) await realClick(hit.el, flow.name);
        else jsClick(hit.el);
        say(`[${flow.name}] ${i + 1}/${flow.steps.length} '${hit.want}' 를 눌렀습니다 ← "${hit.text.slice(0, 40)}"`);
        if (step.retry) watchRetry(flow, i, step, hit.el);
      }
      return; // 한 바퀴에 하나만 누른다. 화면이 바뀌는 것을 보고 다음을 누른다.
    }
  }

  // ── 간편결제 비밀번호 ──────────────────────────────────
  //
  // 결제수단마다 자판이 다르다. 읽는 법은 keypad.js 에 있고, 여기서는 누르는 순서만 같다.
  //   npay  네이버페이 — 숫자가 스프라이트 그림. 누를 때마다 섞일 수 있어 자리마다 다시 읽는다
  //   lpay  롯데온 L.PAY — 숫자가 글자. 주문서 위 레이어. 여섯 자리 뒤 확인 키가 남아 있으면 누른다
  //
  // 한 문서에서 결제수단마다 **한 번만** 넣는다. 틀린 비밀번호를 되풀이해 넣으면 잠긴다.
  // 다시 넣게 하려면 페이지를 새로고침한다.

  const PIN_KINDS = ["npay", "lpay"];

  /**
   * 이 화면이 그 결제수단의 자판이 뜨는 곳인가. 자판이 다른 주소의 iframe 에 들어 있어도
   * 바깥 페이지 주소(ancestorOrigins)로 알아본다.
   */
  function onPinPage(cfg) {
    const places = [location.href, ...(location.ancestorOrigins || [])];
    return (cfg.match || []).some((m) => m && places.some((p) => p.includes(m)));
  }

  // ── 비밀번호 넣기: node/src/lotte-test/browser.ts enterPin 을 그대로 옮긴 것 ──────────
  //
  // 2026-08-25 23:08 부터 여섯 자리를 끝까지 넣은 그 판의 순서다. 다른 점은 셀레니움 대신
  // 크롬 익스텐션 API 를 쓰는 것뿐이다. L.PAY 에서 잘 되는 것을 보고(2026-09-19) 네이버페이도
  // 이 길로 옮겼다 — 결제수단마다 다른 것은 쉬는 시간(PIN_TIMING)뿐이다.
  //   element.click()  (셀레니움 진짜 클릭) → chrome.debugger Input.dispatchMouseEvent (같은 CDP 명령)
  //   widenWindow      → chrome.windows.update
  //   PROGRESS_JS      → keypad.js lpayDots (.apiPassword span.on)
  //
  // 자바스크립트 클릭을 먼저 쓰던 0.2.4 까지는 두 번째 자리부터 안 들어갔다(2026-09-19).
  // lotte-test 는 처음부터 진짜 클릭이었다.

  /**
   * 결제수단마다 쉬는 시간. L.PAY 는 lotte-test 그대로(잘 된다). 네이버페이는 빠르게 해 달라고 해서
   * 짧게 둔다 — 안 먹으면 자리마다 다시 누르므로 짧아도 빠지는 자리는 없다.
   *   settle  자판이 보이고 이만큼 지나서 시작 (핸들러가 붙을 틈)
   *   poll    점이 늘었는지 보는 간격
   *   gap     한 자리가 들어간 뒤 다음 자리를 읽기 전 쉼 (자리가 갈리는 자판)
   *   retry   안 들어갔을 때 다시 누르기 전 쉼
   */
  const PIN_TIMING = {
    lpay: { settle: 500, poll: 150, gap: 300, retry: 400 },
    npay: { settle: 150, poll: 40, gap: 40, retry: 150 },
  };

  /** 채워진 점이 expect 개가 될 때까지 기다린다. → [됐나, 점 자리가 있었나] (lotte-test waitProgress) */
  async function waitProgress(pad, expect, ms = 1500, poll = 150) {
    const until = Date.now() + ms;
    let sawSignal = false;
    while (Date.now() < until) {
      const n = pad.dots();
      if (n !== null) sawSignal = true;
      if (n === expect) return [true, true];
      // 점 자리를 봤는데 사라졌으면 자판이 닫힌 것이다 — 마지막 자리를 받고 넘어갔다.
      if (n === null && sawSignal) return [true, true];
      await sleep(poll);
    }
    return [false, sawSignal];
  }

  /** 키가 창 밖으로 잘려 있으면 창을 키운다 (lotte-test widenWindow — 2026-08-25 의 '0'). */
  async function keepOnScreen(key) {
    const r = key.getBoundingClientRect();
    if (r.bottom <= window.innerHeight && r.right <= window.innerWidth && r.top >= 0 && r.left >= 0) return;
    if (await send({ type: "widenWindow", screenW: screen.availWidth, screenH: screen.availHeight })) {
      await sleep(400);
    }
  }

  async function enterPinReal(kind, cfg, pad, digits) {
    const t = PIN_TIMING[kind];
    // 진짜 클릭을 **먼저** 켠다 (prepareReal). 네이버페이 인증창은 열리자마자 켜 두므로(tick) 여기선 이미 켜져 있다.
    const real = await prepareReal(cfg.name);

    const deadline = Date.now() + 15000;   // pinTail: Math.min(timeout, 15)
    let typed = 0;
    let noSignal = false;
    while (Date.now() < deadline && typed < digits.length) {
      const ch = digits[typed];
      // 이 자리를 누른다 — 점이 실제로 하나 늘 때까지 되풀이한다 (lotte-test 와 같다).
      let done = false;
      let dotFails = 0;
      while (Date.now() < deadline && !done) {
        if (K.pinRejected()) {
          say(`[${cfg.name}] 비밀번호가 틀렸다(또는 5회 잘못)는 말이 떴습니다. 다시 넣지 않습니다.`, "error");
          return;
        }
        const now = await pad.read();
        if (!now || !now.ok) {
          await sleep(t.retry);
          continue;
        }
        // 앞 시도가 늦게 먹었으면 또 누르지 않는다 — 같은 숫자가 두 번 들어가면 틀린 비밀번호다.
        const before = pad.dots();
        if (before !== null && before > typed) {
          done = true;
          break;
        }
        const key = now.keys.get(ch);
        if (settings.dryRun) {
          key.style.outline = "3px solid #e11";
          await sleep(400);
          key.style.outline = "";
          done = true;
          break;
        }
        await keepOnScreen(key);
        if (!real || !(await trustedClick(key))) jsClick(key);

        const [ok, hasSignal] = await waitProgress(pad, typed + 1, 1500, t.poll);
        if (ok) {
          done = true;
          await sleep(t.gap);   // 자리가 갈리는 자판은 다음 읽기 전에 잠깐 쉰다
        } else if (!hasSignal) {
          if (!noSignal) {
            say(`[${cfg.name}] 점 자리를 못 찾았습니다 — 눌림만 확인하고 넘어갑니다.`, "warn");
            noSignal = true;
          }
          done = true;
        } else {
          dotFails += 1;
          if (dotFails === 1) say(`[${cfg.name}] ${typed + 1}번째 자리를 눌렀는데 점이 안 늘었습니다. 다시 시도합니다.`, "warn");
          await sleep(t.retry);
        }
      }
      if (!done) break;
      typed += 1;
    }

    if (typed < digits.length) {
      say(`[${cfg.name}] 자판 키를 누르지 못했습니다 — ${typed}/${digits.length}자리. 직접 넣어 주세요.`, "error");
      return;
    }
    if (settings.dryRun) {
      say(`[연습] [${cfg.name}] 비밀번호 자리를 짚어 보기만 했습니다.`, "ok");
      return;
    }

    // 다 눌렀는데 자판이 그대로면 확인 키가 따로 있는 화면이다. 틀린 비밀번호는 여섯 번째
    // 자리에서 이미 말해 줄 수 있으니, 확인을 누르기 전에 본다. 네이버페이는 확인 키가 없고
    // 여섯 자리에서 바로 넘어가므로 기다리지 않는다.
    if (kind === "lpay") await sleep(700);
    if (K.pinRejected()) {
      say(`[${cfg.name}] 비밀번호가 틀린 것 같습니다 — 확인해 주세요.`, "error");
      return;
    }
    const confirm = pad.confirm();
    if (confirm && visible(confirm)) {
      if (!real || !(await trustedClick(confirm))) jsClick(confirm);
      await sleep(800);
      if (K.pinRejected()) {
        say(`[${cfg.name}] 비밀번호가 틀린 것 같습니다 — 확인해 주세요.`, "error");
        return;
      }
    }
    say(`[${cfg.name}] 비밀번호를 다 넣었습니다 (${digits.length}자리).`, "ok");
    send({ type: "pinDone", kind });
  }

  const pinSeenAt = {};        // 결제수단 → 자판을 처음 본 때
  const pinWarned = {};        // 결제수단 → 비밀번호가 비어 있다고 이미 말했는가

  async function enterPin(kind) {
    const cfg = settings.pins[kind];
    const pad = K[kind];

    const first = await pad.read();
    if (!first) {
      delete pinSeenAt[kind];   // 자판이 아직 안 떴다(또는 닫혔다). 다음 바퀴에 다시 본다.
      return;
    }
    const digits = String((await send({ type: "getPin", kind })) || "").replace(/\D/g, "");
    if (!digits) {
      if (!pinWarned[kind]) {
        pinWarned[kind] = true;
        say(`[${cfg.name}] 자판이 떴는데 저장된 비밀번호가 없습니다 — 팝업에서 저장해 주세요 ` +
          `("브라우저를 꺼도 기억" 을 안 켰으면 크롬을 다시 켤 때 지워집니다).`, "error");
      }
      return;
    }
    // 막 뜬 자판은 잠깐 둔다. 그려지는 도중이면 숫자 키가 덜 보일 수 있어 2초까지는 기다린다.
    pinSeenAt[kind] ??= Date.now();
    const age = Date.now() - pinSeenAt[kind];
    if (!first.ok) {
      if (age < 2000) return;
      pinTried[kind] = true;
      say(`[${cfg.name}] 비밀번호 자판을 못 읽었습니다 — 직접 넣어 주세요. ${first.why}`, "warn");
      return;
    }
    if (age < PIN_TIMING[kind].settle) return;

    pinTried[kind] = true;
    if (K.pinRejected()) {
      say(`[${cfg.name}] 틀렸다는 말(또는 5회 잘못)이 이미 떠 있어 넣지 않습니다 — 확인해 주세요.`, "error");
      return;
    }
    if (pad.dots()) {
      say(`[${cfg.name}] 이미 입력이 시작돼 있어 건드리지 않습니다.`, "warn");
      return;
    }
    say(`[${cfg.name}] 비밀번호 자판을 찾았습니다. ${digits.length}자리를 넣습니다.`);
    return enterPinReal(kind, cfg, pad, digits);
  }

  // ── 바퀴 ─────────────────────────────────────────────

  let again = false;          // 도는 중에 화면이 바뀌었으면 끝나자마자 한 바퀴 더
  async function tick() {
    if (busy) {
      again = true;
      return;
    }
    busy = true;
    again = false;
    try {
      if (!settings) await loadSettings();
      if (!settings || !settings.enabled) return;
      // 진짜 클릭으로 누를 일이 있는 페이지면 지금 켜 둔다 — 누를 때 띠 때문에 기다리지 않게.
      // L.PAY 는 롯데온 어느 페이지에서나 자판이 뜰 수 있어서(주소가 lotteon.com 전부) 미리 켜지 않는다.
      if (!realReady && window === window.top) {
        const npay = settings.pins && settings.pins.npay;
        const flow = (settings.flows || []).find((f) =>
          f.enabled && f.trusted && matches(f) &&
          // 네이버 상품 페이지는 누를 상품(옵션 없음)일 때만 — 안 누를 페이지에 "디버깅 중" 띠를 띄우지 않게
          (f.kind !== "naverBuy" || (naverProductId() && naverHasOptions(f) !== true)));
        if (flow) prepareReal(flow.name);
        else if (npay && npay.enabled && onPinPage(npay)) prepareReal(npay.name);
      }
      for (const kind of PIN_KINDS) {
        const cfg = settings.pins && settings.pins[kind];
        if (cfg && cfg.enabled && !pinTried[kind] && onPinPage(cfg)) await enterPin(kind);
      }
      await runFlows();
    } catch (e) {
      say(`오류: ${e && e.message}`, "error");
    } finally {
      busy = false;
      if (again) setTimeout(tick, 0);
    }
  }

  // 버튼이 생기는 **그 순간** 돈다. 0.2초마다 보는 것만으로는 버튼이 뜨고 최대 0.2초를 흘린다.
  // 화면이 한꺼번에 여러 번 바뀌어도 한 바퀴로 모은다 (busy·again).
  // 네이버 주문서의 결제 버튼은 금액 숫자가 도는 애니메이션이라 화면이 쉬지 않고 바뀐다 — 그대로 두면
  // 초당 수백 바퀴를 돈다. 바뀐 뒤 첫 바퀴는 바로, 그다음은 최소 MIN_GAP_MS 간격으로 모은다.
  const MIN_GAP_MS = 30;
  let queued = false;
  let lastTick = 0;
  new MutationObserver(() => {
    if (queued) return;
    queued = true;
    const wait = Math.max(0, lastTick + MIN_GAP_MS - Date.now());
    setTimeout(() => {
      queued = false;
      lastTick = Date.now();
      tick();
    }, wait);
  }).observe(document.documentElement, { childList: true, subtree: true, attributes: true,
    attributeFilter: ["class", "style", "disabled", "aria-disabled"] });

  setInterval(tick, TICK_MS);
  tick();
})();
