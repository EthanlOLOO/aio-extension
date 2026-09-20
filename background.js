/**
 * 백그라운드 (서비스 워커).
 *
 *   - 설정을 들고 있고, 흐름이 몇 번째 단계까지 갔는지 쥐고 있다
 *   - 결제수단별 비밀번호를 내준다 (기본은 브라우저를 끄면 지워지는 session 저장소)
 *   - 페이지가 자바스크립트 클릭을 무시할 때 chrome.debugger 로 진짜 클릭을 낸다
 *   - 디스코드 봇으로 알림을 받아 링크를 새 창으로 연다 (node/src/discord-open 과 같은 일)
 */
import { DEFAULT_SETTINGS } from "./defaults.js";

// ── 설정 ───────────────────────────────────────────────

// 페이지 스크립트가 0.2초마다(그리고 화면이 바뀔 때마다) 묻는다. 그때마다 저장소를 읽고
// upgrade 를 돌리지 않게 들고 있다가, 설정이 바뀌면 버린다 (아래 storage.onChanged).
let settingsCache = null;

async function getSettings() {
  if (settingsCache) return settingsCache;
  const { settings } = await chrome.storage.local.get("settings");
  if (!settings) {
    await chrome.storage.local.set({ settings: DEFAULT_SETTINGS });
    return structuredClone(DEFAULT_SETTINGS);
  }
  return (settingsCache = upgrade(settings));
}

/** 예전 판의 기본 단계. 저장된 단계가 이것과 똑같으면 사람이 고치지 않은 것이다. */
const OLD_STEPS = {
  // 0.2.0 — 페이지 준비 기다리기·다시 누르기가 없던 때
  "lotte-buy": [
    JSON.stringify([{ text: ["바로 구매하기", "바로구매"] }]),
    // 0.2.1 — 로딩 완료까지 기다리고 0.8초 더 셌다. 버튼은 0.9초에 뜨는데 로딩 완료는 2.8초라 늦었다
    JSON.stringify([{ text: ["바로 구매하기", "바로구매"], readyMs: 800, retry: { afterMs: 2500, max: 3 } }]),
  ],
};

/**
 * 저장된 설정을 지금 모양으로 맞춘다. 사람이 고친 칸은 건드리지 않는다.
 *   - 새로 생긴 칸은 기본값으로 채운다
 *   - 새로 생긴 기본 흐름(예: 롯데온 바로 구매하기)은 꺼진 채로 끼워 넣는다
 *   - site 가 없는 흐름은 기본값의 site 를 빌린다 (사이트별로 묶어 보여 주려고)
 *   - 0.1 의 pin 한 칸(네이버페이 전용)은 pins.npay 로 옮긴다
 */
function upgrade(saved) {
  const D = DEFAULT_SETTINGS;
  const pins = {};
  for (const [kind, def] of Object.entries(D.pins)) pins[kind] = { ...def, ...(saved.pins || {})[kind] };
  if (saved.pin && !saved.pins) {
    pins.npay = { ...pins.npay, enabled: !!saved.pin.enabled, match: saved.pin.match || pins.npay.match };
  }
  const byId = new Map(D.flows.map((f) => [f.id, f]));
  const flows = (saved.flows || []).map(({ cooldownSeconds, cooldownScope, ...f }) => {
    // 쿨다운은 0.2.3 에서 뺐다. 옛 판이 저장해 둔 cooldownSeconds·cooldownScope 는 버린다.
    const def = byId.get(f.id);
    if (!def) return { site: "etc", ...f };
    // 기본 흐름에 새로 생긴 칸(readyMs·soldOutText 등)은 채운다. 사람이 고친 칸은 그대로 둔다.
    const out = { ...structuredClone(def), ...f };
    // 단계를 손대지 않은 채 옛 기본값 그대로면 새 기본값으로 올린다.
    if ((OLD_STEPS[f.id] || []).includes(JSON.stringify(f.steps))) out.steps = structuredClone(def.steps);
    return out;
  });
  const have = new Set(flows.map((f) => f.id));
  for (const f of D.flows) if (!have.has(f.id)) flows.push(structuredClone(f));
  const out = {
    ...D, ...saved,
    flows, pins,
    trustedClick: saved.trustedClick || (saved.pin && saved.pin.trusted) || D.trustedClick,
    discord: { ...D.discord, ...saved.discord },
  };
  delete out.pin;
  return out;
}

// ── 기록 ───────────────────────────────────────────────

const LOG_MAX = 200;
let logBuf = null;

// 처음 읽기를 약속 하나로 묶는다. 거의 동시에 온 기록 둘이 각자 저장소를 읽으면, 늦게 읽은 쪽이
// 먼저 쌓인 기록을 덮어써 하나가 사라진다 (2026-09-19 에 "옵션 상품이라 안 누른다" 가 그렇게 빠졌다).
let logLoad = null;

async function addLog(level, text, where = "") {
  if (!logBuf) {
    logLoad ??= chrome.storage.session.get("log").then((got) => { logBuf ??= got.log || []; });
    await logLoad;
  }
  logBuf.push({ at: Date.now(), level, text, where });
  if (logBuf.length > LOG_MAX) logBuf.splice(0, logBuf.length - LOG_MAX);
  await chrome.storage.session.set({ log: logBuf });
  console[level === "error" ? "error" : level === "warn" ? "warn" : "log"](`[${where}] ${text}`);
  if (level === "error") chrome.action.setBadgeText({ text: "!" });
}

// ── 흐름 단계 ───────────────────────────────────────────
//
// { index, touchedAt, ranIn } 를 흐름마다 session 저장소에 둔다. 워커가 잠들었다 깨도 이어 간다.
//
// **쿨다운(기다리는 시간)은 없다** (2026-09-19 에 뺐다). 대신 한 번 끝낸 흐름은 **그 흐름을 누른
// 페이지에서만** 다시 시작하지 않는다(ranIn). 주문서의 "결제하기" 는 누른 뒤에도 화면에 그대로 남아
// 있어서, 이게 없으면 0.2초마다 또 누른다. 새로 연 페이지·새로고침한 페이지는 새 시도라 바로 누른다.
// 중간에서 멈춘 흐름은 staleSeconds 가 지나면 처음으로 되돌린다.

const RAN_KEEP = 50;  // 기억해 둘 페이지 수. 오래된 것부터 잊는다

async function flowStates() {
  return (await chrome.storage.session.get("flows")).flows || {};
}

function fresh(state, flow) {
  const s = state || { index: 0, touchedAt: 0, ranIn: [] };
  if (s.index > 0 && Date.now() - s.touchedAt > (flow.staleSeconds ?? 120) * 1000) {
    return { index: 0, touchedAt: 0, ranIn: s.ranIn || [] };
  }
  return s;
}

// 두 프레임이 같은 단계를 동시에 잡으려 할 수 있다. 차례로 처리한다.
let lock = Promise.resolve();
function serial(fn) {
  const run = lock.then(fn, fn);
  lock = run.catch(() => undefined);
  return run;
}

/** 이 페이지에서 이미 이 흐름을 누른 적이 있어 처음부터 다시 시작하면 안 되는가. */
function ranHere(s, doc) {
  return s.index === 0 && (s.ranIn || []).includes(doc);
}

/** 메시지를 보낸 문서를 가리키는 열쇠. 새로고침하면 바뀐다. */
function docOf(sender) {
  return sender.documentId || `${sender.tab && sender.tab.id}|${sender.url}`;
}

async function flowState(id, doc) {
  const settings = await getSettings();
  const flow = settings.flows.find((f) => f.id === id);
  if (!flow) return null;
  const s = fresh((await flowStates())[id], flow);
  return { index: s.index, touchedAt: s.touchedAt, cooling: ranHere(s, doc) };
}

function claimStep(id, index, doc) {
  return serial(async () => {
    const settings = await getSettings();
    const flow = settings.flows.find((f) => f.id === id);
    if (!flow || !settings.enabled || !flow.enabled) return false;
    const all = await flowStates();
    const s = fresh(all[id], flow);
    if (s.index !== index) return false;
    if (ranHere(s, doc)) return false;
    const last = index + 1 >= flow.steps.length;
    const ranIn = [...(s.ranIn || []).filter((d) => d !== doc), doc].slice(-RAN_KEEP);
    // 되돌릴 수 있게(unclaimStep) 잡은 단계와 그 전 기록을 같이 적어 둔다.
    all[id] = { index: last ? 0 : index + 1, touchedAt: Date.now(), ranIn,
                claimed: index, claimedIn: doc, prevRanIn: s.ranIn || [], last };
    await chrome.storage.session.set({ flows: all });
    if (last) addLog("ok", `[${flow.name}] 흐름을 끝까지 눌렀습니다`, "흐름");
    return true;
  });
}

/**
 * 방금 잡은 단계를 돌려놓는다 — 눌렀는데 먹지 않아 다시 누르려는 것 (content.js watchRetry).
 * 그 뒤 다른 단계로 넘어갔으면 돌려놓지 않는다.
 */
function unclaimStep(id, index) {
  return serial(async () => {
    const all = await flowStates();
    const s = all[id];
    if (!s || s.claimed !== index) return false;
    const expected = s.last ? 0 : index + 1;  // 마지막 단계였으면 0 으로 돌아가 있다
    if (s.index !== expected) return false;
    all[id] = { index, touchedAt: Date.now(), ranIn: s.prevRanIn || [] };
    await chrome.storage.session.set({ flows: all });
    return true;
  });
}

async function resetFlows() {
  await chrome.storage.session.set({ flows: {} });
}

// ── 비밀번호 ────────────────────────────────────────────
//
// 기억 안 함(기본): chrome.storage.session — 메모리에만 있고 브라우저를 끄면 사라진다.
// 기억함: chrome.storage.local — 디스크에 **평문으로** 남는다. 이 PC 를 쓰는 사람은 읽을 수 있다.

// 결제수단마다 따로 둔다 (pin_npay · pin_lpay). 0.1 의 "pin" 은 네이버페이 것이다.
const pinKey = (kind) => `pin_${kind}`;

async function getPin(kind) {
  const key = pinKey(kind);
  const s = (await chrome.storage.session.get(key))[key];
  if (s) return s;
  const l = (await chrome.storage.local.get(key))[key];
  if (l) return l;
  if (kind === "npay") {
    return (await chrome.storage.session.get("pin")).pin || (await chrome.storage.local.get("pin")).pin || "";
  }
  return "";
}

async function setPin(kind, pin, remember) {
  const key = pinKey(kind);
  await chrome.storage.session.remove(key);
  await chrome.storage.local.remove(key);
  if (kind === "npay") {
    await chrome.storage.session.remove("pin");
    await chrome.storage.local.remove("pin");
  }
  if (!pin) return;
  if (remember) await chrome.storage.local.set({ [key]: pin });
  else await chrome.storage.session.set({ [key]: pin });
}

/** 저장돼 있는가, 브라우저를 꺼도 남는가. 값은 돌려주지 않는다. */
async function pinInfo(kind) {
  const key = pinKey(kind);
  const remembered = !!(await chrome.storage.local.get(key))[key] ||
    (kind === "npay" && !!(await chrome.storage.local.get("pin")).pin);
  return { has: !!(await getPin(kind)), remembered };
}

// ── 진짜 클릭 ───────────────────────────────────────────
//
// 붙어 있는 동안 크롬 위에 "디버깅 중" 띠가 뜬다. 다 쓰면 몇 초 뒤 뗀다.

const attached = new Map(); // tabId → 떼기 타이머

/**
 * 탭에 디버거를 붙여 둔다. 붙이는 순간 크롬 위에 "디버깅 중" 띠가 생기면서 **페이지가 아래로 밀린다.**
 * 그래서 비밀번호처럼 좌표로 여러 번 누를 일은 먼저 붙여 두고, 띠가 자리 잡은 뒤에 좌표를 잰다.
 * holdMs 동안 안 쓰면 뗀다.
 */
async function ensureAttached(tabId, holdMs = 8000) {
  const target = { tabId };
  const fresh = !attached.has(tabId);
  if (fresh) await chrome.debugger.attach(target, "1.3");
  else clearTimeout(attached.get(tabId));
  attached.set(tabId, setTimeout(() => {
    attached.delete(tabId);
    chrome.debugger.detach(target).catch(() => undefined);
  }, holdMs));
  return fresh;
}

/** 셀레니움 element.click() 과 같은 진짜 마우스 클릭 (ChromeDriver 도 이 CDP 명령을 쓴다). */
async function trustedClick(tabId, x, y) {
  const target = { tabId };
  await ensureAttached(tabId);
  const at = { x, y, button: "left", clickCount: 1, pointerType: "mouse" };
  await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" });
  await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", { type: "mousePressed", buttons: 1, ...at });
  await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", { type: "mouseReleased", buttons: 0, ...at });
}

/**
 * 창을 키운다 (lotte-test widenWindow 와 같다). 자판 모달은 화면 가운데 고정이라 창이 작으면
 * 아래 줄 키('0'·'확인')가 화면 밖으로 잘려 눌러도 안 먹는다 — 2026-08-25 에 '0' 이 그랬다.
 * 자판 키가 잘렸을 때만 부른다.
 */
async function widenWindow(tabId, screenW, screenH) {
  const tab = await chrome.tabs.get(tabId);
  const win = await chrome.windows.get(tab.windowId);
  if (win.state !== "normal") return false;
  const width = Math.max(win.width, Math.min(1280, screenW || 1280));
  const height = Math.max(win.height, Math.min(900, screenH || 900));
  if (width === win.width && height === win.height) return false;
  await chrome.windows.update(win.id, { width, height });
  return true;
}

chrome.debugger.onDetach.addListener((src) => {
  if (src.tabId != null) {
    clearTimeout(attached.get(src.tabId));
    attached.delete(src.tabId);
  }
});

// ── 메시지 ─────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  const tabId = sender.tab && sender.tab.id;
  const work = (async () => {
    switch (msg.type) {
      case "getSettings": return getSettings();
      case "flowState": return flowState(msg.id, docOf(sender));
      case "claimStep": return claimStep(msg.id, msg.index, docOf(sender));
      case "unclaimStep": return unclaimStep(msg.id, msg.index);
      case "resetFlows": return resetFlows();
      case "getPin":
        // 비밀번호는 페이지 스크립트(content.js)에만 내준다. 팝업은 pinInfo 로 있는지만 본다.
        if (!sender.tab) return "";
        return getPin(msg.kind);
      case "setPin": return setPin(msg.kind, msg.pin, msg.remember);
      case "pinInfo": return pinInfo(msg.kind);
      case "rememberPin": {
        // 저장된 값을 그대로 둔 채 자리만 옮긴다 (session ↔ local).
        const pin = await getPin(msg.kind);
        if (pin) await setPin(msg.kind, pin, msg.remember);
        return pinInfo(msg.kind);
      }
      case "pinDone": return null;
      case "log": return addLog(msg.level, msg.text, msg.where);
      case "clearLog":
        logBuf = [];
        chrome.action.setBadgeText({ text: "" });
        return chrome.storage.session.set({ log: [] });
      case "debuggerAttach":
        if (tabId == null) return { ok: false };
        try {
          return { ok: true, fresh: await ensureAttached(tabId, msg.holdMs ?? 20000) };
        } catch (e) {
          addLog("warn", `진짜 클릭을 켜지 못했습니다: ${e.message}`, "debugger");
          return { ok: false };
        }
      case "widenWindow":
        if (tabId == null) return false;
        return widenWindow(tabId, msg.screenW, msg.screenH).catch(() => false);
      case "trustedClick":
        if (tabId == null) return { ok: false };
        try {
          await trustedClick(tabId, msg.x, msg.y);
          return { ok: true };
        } catch (e) {
          addLog("error", `진짜 클릭 실패: ${e.message}`, "debugger");
          return { ok: false };
        }
      case "checkUpdate": return checkUpdate(msg.force);
      case "openTab": return chrome.tabs.create({ url: msg.url });
      case "discordStatus": return discord.status();
      case "discordRestart": return discord.restart();
      case "testOpen": return openLink(msg.url, "시험");
    }
    return null;
  })();
  work.then(reply, (e) => reply({ error: String(e && e.message) }));
  return true;
});

// ── 새 버전 알림 ────────────────────────────────────────
//
// 수동 설치(개발자 모드)라 크롬이 알아서 업데이트하지 않는다. 친구들이 옛 버전을 계속 쓰지 않게
// 깃허브 릴리스를 가끔 확인해서 팝업에 알려 준다. 여섯 시간에 한 번만 묻는다 (남의 서버다).

const REPO = "EthanlOLOO/aio-extension";
const UPDATE_EVERY_MS = 6 * 60 * 60 * 1000;

/** "0.3.10" > "0.3.9" 를 제대로 보게 숫자로 견준다. → a 가 b 보다 새것인가 */
function newerThan(a, b) {
  const x = String(a).split("."), y = String(b).split(".");
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (Number(x[i]) || 0) - (Number(y[i]) || 0);
    if (d) return d > 0;
  }
  return false;
}

async function checkUpdate(force = false) {
  const here = chrome.runtime.getManifest().version;
  const saved = (await chrome.storage.local.get("update")).update;
  if (!force && saved && Date.now() - saved.at < UPDATE_EVERY_MS) {
    return { ...saved, here, newer: newerThan(saved.latest, here) };
  }
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`${res.status}`);
    const body = await res.json();
    const latest = String(body.tag_name || "").replace(/^v/, "");
    const update = { at: Date.now(), latest, url: body.html_url || `https://github.com/${REPO}/releases` };
    await chrome.storage.local.set({ update });
    return { ...update, here, newer: newerThan(latest, here) };
  } catch (e) {
    return { here, latest: saved && saved.latest, url: `https://github.com/${REPO}/releases`,
             newer: !!(saved && newerThan(saved.latest, here)), error: String(e.message || e) };
  }
}

// ── 링크 열기 ───────────────────────────────────────────

async function openLink(url, why) {
  const settings = await getSettings();
  if (settings.discord.newWindow) {
    const win = await chrome.windows.create({ url, focused: true, state: "normal" });
    await chrome.windows.update(win.id, { focused: true, drawAttention: true });
  } else {
    const [win] = await chrome.windows.getAll({ windowTypes: ["normal"] });
    const tab = await chrome.tabs.create({ url, active: true, windowId: win && win.id });
    await chrome.windows.update(tab.windowId, { focused: true, drawAttention: true });
  }
  addLog("ok", `열었습니다: ${url}  ← ${why}`, "디스코드");
}

// ── 디스코드 ───────────────────────────────────────────
//
// node/src/discord-open/gateway.ts 를 옮겼다. 다른 점:
//   서비스 워커는 30초 동안 할 일이 없으면 잠든다. 웹소켓에 오가는 것이 있으면 깨어 있으므로,
//   심장박동을 디스코드가 달라는 간격(약 41초)보다 짧게 20초마다 보낸다.
//   그래도 잠들 수 있어서, 1분 알람이 깨워 끊겼으면 다시 붙인다.

const GATEWAY = "wss://gateway.discord.gg/?v=10&encoding=json";
const INTENTS = (1 << 0) | (1 << 9) | (1 << 15);
const FATAL = {
  4004: "봇 토큰이 틀렸습니다.",
  4013: "인텐트 값이 잘못되었습니다.",
  4014: "MESSAGE CONTENT INTENT 가 꺼져 있습니다. 개발자 포털 → Bot 에서 켜 주세요.",
};

const URL_RE = /https?:\/\/[^\s<>()"'`\]]+/g;
const urlsIn = (t) => (t && t.match(URL_RE) || []).map((u) => u.replace(/[.,;:!?]+$/, ""));
const notDiscord = (u) => {
  try {
    return !/(^|\.)(discord\.com|discordapp\.com|discordapp\.net|discord\.gg)$/i.test(new URL(u).hostname);
  } catch {
    return false;
  }
};

function linkOf(msg) {
  const found = [];
  for (const e of msg.embeds || []) if (e.url) found.push(e.url);
  found.push(...urlsIn(msg.content));
  for (const e of msg.embeds || []) {
    found.push(...urlsIn(e.description));
    for (const f of e.fields || []) found.push(...urlsIn(f.value));
  }
  return found.find(notDiscord) || null;
}

function textOf(msg) {
  const parts = [msg.content || ""];
  for (const e of msg.embeds || []) {
    parts.push(e.title || "", e.description || "", (e.footer && e.footer.text) || "");
    for (const f of e.fields || []) parts.push(f.name || "", f.value || "");
  }
  return parts.join("\n").toLowerCase();
}

const discord = {
  ws: null,
  beat: null,
  acked: true,
  seq: null,
  sessionId: null,
  resumeUrl: null,
  state: "off",
  detail: "",
  opened: new Map(),

  status() {
    return { state: this.state, detail: this.detail };
  },

  async restart() {
    this.close(1000);
    this.sessionId = null;
    this.resumeUrl = null;
    this.seq = null;
    await chrome.storage.session.remove("gw");
    await this.ensure();
    return this.status();
  },

  close(code) {
    clearInterval(this.beat);
    this.beat = null;
    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      try { ws.close(code); } catch { /* 이미 닫힘 */ }
    }
  },

  /** 켜져 있어야 하는데 연결이 없으면 붙는다. 알람·시작·설정 변경 때 부른다. */
  async ensure() {
    const settings = await getSettings();
    const cfg = settings.discord;
    if (!settings.enabled || !cfg.enabled || !cfg.token) {
      this.close(1000);
      this.state = "off";
      this.detail = !cfg.token ? "봇 토큰이 없습니다" : "꺼져 있습니다";
      return;
    }
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) return;
    if (this.state === "fatal") return;

    const saved = (await chrome.storage.session.get("gw")).gw;
    if (saved && !this.sessionId) Object.assign(this, saved);
    const resuming = !!(this.sessionId && this.resumeUrl);
    const ws = new WebSocket(resuming ? `${this.resumeUrl}/?v=10&encoding=json` : GATEWAY);
    this.ws = ws;
    this.state = "connecting";
    this.detail = "";
    const token = cfg.token.trim().replace(/^Bot\s+/i, "");

    ws.onmessage = (ev) => {
      let p;
      try { p = JSON.parse(ev.data); } catch { return; }
      if (p.s != null) this.seq = p.s;
      switch (p.op) {
        case 10:
          this.startBeat(Math.min(p.d.heartbeat_interval, 20000));
          if (resuming) this.send(6, { token, session_id: this.sessionId, seq: this.seq });
          else this.send(2, { token, intents: INTENTS, properties: { os: "windows", browser: "aio-extension", device: "aio-extension" } });
          break;
        case 11: this.acked = true; break;
        case 1: this.send(1, this.seq); break;
        case 7: this.close(4000); setTimeout(() => this.ensure(), 500); break;
        case 9:
          if (!p.d) { this.sessionId = null; this.resumeUrl = null; this.seq = null; }
          this.close(4000);
          setTimeout(() => this.ensure(), 1000 + Math.random() * 4000);
          break;
        case 0: this.dispatch(p.t, p.d); break;
      }
      if (this.sessionId) {
        chrome.storage.session.set({ gw: { sessionId: this.sessionId, resumeUrl: this.resumeUrl, seq: this.seq } });
      }
    };
    ws.onclose = (ev) => {
      if (ws !== this.ws) return;
      this.ws = null;
      clearInterval(this.beat);
      if (FATAL[ev.code]) {
        this.state = "fatal";
        this.detail = FATAL[ev.code];
        addLog("error", FATAL[ev.code], "디스코드");
        return;
      }
      if (ev.code === 4007 || ev.code === 4009) { this.sessionId = null; this.resumeUrl = null; }
      this.state = "retry";
      this.detail = `끊김 (${ev.code})`;
      setTimeout(() => this.ensure(), 5000);
    };
  },

  send(op, d) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ op, d }));
  },

  startBeat(interval) {
    clearInterval(this.beat);
    this.acked = true;
    this.beat = setInterval(() => {
      if (!this.acked) {
        addLog("warn", "디스코드가 대답이 없어 다시 붙습니다", "디스코드");
        this.close(4000);
        this.ensure();
        return;
      }
      this.acked = false;
      this.send(1, this.seq);
    }, interval);
  },

  dispatch(type, d) {
    if (type === "READY") {
      this.sessionId = d.session_id;
      this.resumeUrl = d.resume_gateway_url;
      this.state = "on";
      this.detail = `봇 ${d.user.username} · 서버 ${d.guilds.length}곳`;
      if (!d.guilds.length) {
        this.detail += ` — 초대: https://discord.com/oauth2/authorize?client_id=${d.user.id}&scope=bot&permissions=66560`;
      }
      addLog("ok", `디스코드에 붙었습니다 (${this.detail})`, "디스코드");
    } else if (type === "RESUMED") {
      this.state = "on";
      addLog("info", "디스코드에 다시 붙었습니다", "디스코드");
    } else if (type === "MESSAGE_CREATE") {
      this.onMessage(d);
    }
  },

  async onMessage(msg) {
    const { discord: cfg, enabled } = await getSettings();
    if (!enabled || !cfg.enabled) return;
    const channels = (cfg.channels || []).map(String).filter(Boolean);
    if (channels.length && !channels.includes(msg.channel_id)) return;
    if (cfg.webhookOnly && !msg.webhook_id) return;

    const text = textOf(msg);
    const title = ((msg.embeds && msg.embeds[0] && msg.embeds[0].title) || msg.content || "").slice(0, 60);
    const keywords = (cfg.keywords || []).map((k) => k.toLowerCase()).filter(Boolean);
    const skips = (cfg.skipKeywords || []).map((k) => k.toLowerCase()).filter(Boolean);
    if (keywords.length && !keywords.some((k) => text.includes(k))) return;
    if (skips.some((k) => text.includes(k))) return;

    const url = linkOf(msg);
    if (!url) {
      if (!msg.content && !(msg.embeds || []).length) {
        addLog("warn", "메시지가 비어서 왔습니다. MESSAGE CONTENT INTENT 를 확인해 주세요.", "디스코드");
      }
      return;
    }
    const last = this.opened.get(url);
    if (last && Date.now() - last < (cfg.reopenSeconds ?? 60) * 1000) return;
    this.opened.set(url, Date.now());
    openLink(url, title);
  },
};

chrome.alarms.create("keepalive", { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(() => discord.ensure());
chrome.runtime.onStartup.addListener(() => discord.ensure());
chrome.runtime.onInstalled.addListener(async () => {
  await getSettings();
  discord.ensure();
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.settings) {
    settingsCache = null;
    if (discord.state === "fatal") discord.state = "off";
    discord.ensure();
  }
});
discord.ensure();
