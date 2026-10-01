/**
 * 디스코드 모니터링 (링크를 "열지" 않고 "기록만" 한다).
 *
 * background.js 의 서비스 워커 안에서 돈다. Discord Gateway(WebSocket)에 봇 토큰으로 붙어
 * MESSAGE_CREATE 이벤트를 받고, 정한 조건(채널·키워드·웹훅 여부)에 맞는 알림을 잡아
 * session 저장소에 최대 MONITOR_MAX 건까지 쌓아 둔다. 팝업에서 이 목록을 실시간으로 보여 준다.
 *
 * 이전의 discord-open 과 다른 점:
 *   - 링크를 새 창/새 탭으로 열지 않는다. 잡아서 목록에 남기는 것까지만 한다.
 *   - 그래서 newWindow / reopenSeconds / openTab 같은 "열기" 관련 설정이 필요 없다.
 *   - 사람이 직접 확인하고 판단할 수 있게, 잡힌 알림마다 채널·보낸이·본문·링크를 그대로 보관한다.
 *
 * 서비스 워커는 30초 동안 할 일이 없으면 잠든다. 웹소켓에 오가는 것이 있으면 깨어 있으므로,
 * 심장박동을 디스코드가 달라는 간격(약 41초)보다 짧게 20초마다 보낸다. 그래도 잠들 수 있어서,
 * 1분 알람이 깨워 끊겼으면 다시 붙인다 (background.js 의 keepalive 알람이 ensure() 를 부른다).
 */
import { DEFAULT_SETTINGS } from "./defaults.js";

const GATEWAY = "wss://gateway.discord.gg/?v=10&encoding=json";
// GUILDS(1<<0) | MESSAGE_CONTENT(1<<9) | GUILD_MESSAGES(1<<15)
const INTENTS = (1 << 0) | (1 << 9) | (1 << 15);
const FATAL = {
  4004: "봇 토큰이 틀렸습니다.",
  4013: "인텐트 값이 잘못되었습니다.",
  4014: "MESSAGE CONTENT INTENT 가 꺼져 있습니다. 개발자 포털 → Bot 에서 켜 주세요.",
};

const MONITOR_MAX = 200;

// ── 링크·본문 파싱 ───────────────────────────────────────

const URL_RE = /https?:\/\/[^\s<>()"'`\]]+/g;
const urlsIn = (t) => (t && t.match(URL_RE) || []).map((u) => u.replace(/[.,;:!?]+$/, ""));

/** 메시지에 든 모든 http(s) 링크를 순서대로 모은다 (embed url 포함). */
function linksOf(msg) {
  const found = [];
  for (const e of msg.embeds || []) if (e.url) found.push(e.url);
  found.push(...urlsIn(msg.content));
  for (const e of msg.embeds || []) {
    found.push(...urlsIn(e.description));
    for (const f of e.fields || []) found.push(...urlsIn(f.value));
  }
  // 중복 제거, 순서 유지
  return [...new Set(found)];
}

/** 키워드 검사에 쓸 본문 전체(제목·설명·필드 포함)를 작은 글자로. */
function textOf(msg) {
  const parts = [msg.content || ""];
  for (const e of msg.embeds || []) {
    parts.push(e.title || "", e.description || "", (e.footer && e.footer.text) || "");
    for (const f of e.fields || []) parts.push(f.name || "", f.value || "");
  }
  return parts.join("\n").toLowerCase();
}

/** 목록에 보여 줄 한 줄 요약. */
function summaryOf(msg) {
  const e = msg.embeds && msg.embeds[0];
  const raw = (e && (e.title || e.description)) || msg.content || "";
  return String(raw).replace(/\s+/g, " ").trim().slice(0, 160);
}

// ── 잡힌 알림 보관 ───────────────────────────────────────

async function loadEvents() {
  return (await chrome.storage.session.get("monEvents")).monEvents || [];
}

/** 가장 최근이 뒤쪽에 쌓인다. pop-up 은 reverse 해서 앞쪽부터 보여 준다. */
async function pushEvent(ev) {
  const list = await loadEvents();
  list.push(ev);
  if (list.length > MONITOR_MAX) list.splice(0, list.length - MONITOR_MAX);
  await chrome.storage.session.set({ monEvents: list });
}

export async function clearEvents() {
  await chrome.storage.session.set({ monEvents: [] });
}

// ── 모니터링 본체 ────────────────────────────────────────

export const monitor = {
  ws: null,
  beat: null,
  acked: true,
  seq: null,
  sessionId: null,
  resumeUrl: null,
  state: "off",
  detail: "",
  caught: 0,

  status() {
    return { state: this.state, detail: this.detail, caught: this.caught };
  },

  async restart() {
    this.close(1000);
    this.sessionId = null;
    this.resumeUrl = null;
    this.seq = null;
    await chrome.storage.session.remove("monGw");
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
    const settings = await getSettingsLocal();
    const cfg = settings.monitor;
    if (!settings.enabled || !cfg.enabled || !cfg.token) {
      this.close(1000);
      this.state = "off";
      this.detail = !cfg.token ? "봇 토큰이 없습니다" : "꺼져 있습니다";
      return;
    }
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) return;
    if (this.state === "fatal") return;

    const saved = (await chrome.storage.session.get("monGw")).monGw;
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
          else this.send(2, { token, intents: INTENTS, properties: { os: "windows", browser: "aio-extension", device: "aio-monitor" } });
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
        chrome.storage.session.set({ monGw: { sessionId: this.sessionId, resumeUrl: this.resumeUrl, seq: this.seq } });
      }
    };
    ws.onclose = (ev) => {
      if (ws !== this.ws) return;
      this.ws = null;
      clearInterval(this.beat);
      if (FATAL[ev.code]) {
        this.state = "fatal";
        this.detail = FATAL[ev.code];
        logAdd("error", this.detail, "모니터링");
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
        logAdd("warn", "디스코드가 대답이 없어 다시 붙습니다", "모니터링");
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
      logAdd("ok", `디스코드에 붙었습니다 (${this.detail})`, "모니터링");
    } else if (type === "RESUMED") {
      this.state = "on";
      logAdd("info", "디스코드에 다시 붙었습니다", "모니터링");
    } else if (type === "MESSAGE_CREATE") {
      this.onMessage(d);
    }
  },

  /** 알림을 받아 조건에 맞으면 목록에 쌓는다. 링크를 열지는 않는다. */
  async onMessage(msg) {
    const settings = await getSettingsLocal();
    const cfg = settings.monitor;
    if (!settings.enabled || !cfg.enabled) return;

    const channels = (cfg.channels || []).map(String).filter(Boolean);
    if (channels.length && !channels.includes(msg.channel_id)) return;
    if (cfg.webhookOnly && !msg.webhook_id) return;

    const text = textOf(msg);
    const keywords = (cfg.keywords || []).map((k) => k.toLowerCase()).filter(Boolean);
    const skips = (cfg.skipKeywords || []).map((k) => k.toLowerCase()).filter(Boolean);
    if (keywords.length && !keywords.some((k) => text.includes(k))) return;
    if (skips.some((k) => text.includes(k))) return;

    const links = linksOf(msg);
    if (cfg.linkOnly && !links.length) {
      if (!msg.content && !(msg.embeds || []).length) {
        logAdd("warn", "메시지가 비어서 왔습니다. MESSAGE CONTENT INTENT 를 확인해 주세요.", "모니터링");
      }
      return;
    }

    const author = msg.author || {};
    const ev = {
      at: Date.now(),
      channelId: msg.channel_id,
      author: author.username || "알 수 없음",
      bot: !!author.bot,
      webhook: !!msg.webhook_id,
      summary: summaryOf(msg),
      links,
      content: String(msg.content || "").slice(0, 2000),
    };
    await pushEvent(ev);
    this.caught++;
    logAdd("ok", `알림 감지: ${ev.summary.slice(0, 40) || "(본문 없음)"}`, "모니터링");
  },
};

// ── background.js 로부터 주입받는 헬퍼 연결 ──────────────
//
// 설정 읽기와 기록 쓰기는 background.js 에 이미 있다. 순환 import 를 피하려고,
// background.js 가 wireMonitor() 로 이 두 함수를 물어다 준다.

let getSettingsLocal = async () => ({ enabled: false, monitor: DEFAULT_SETTINGS.monitor });
let logAdd = () => {};

/** background.js 가 시작할 때 한 번 부른다. */
export function wireMonitor({ getSettings, addLog }) {
  getSettingsLocal = getSettings;
  logAdd = addLog;
}
