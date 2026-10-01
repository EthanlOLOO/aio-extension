/**
 * 디스코드 링크 오프너 (0.5) — monitoring(0.4) 을 없애고 돌아왔다.
 *
 * 동작: Discord Gateway(WebSocket)에 봇 토큰으로 붙어 MESSAGE_CREATE 를 받는다.
 *   1) 웹훅이 보낸 알림만 (msg.webhook_id 가 있는 것만) — 사람이 보낸 일반 메시지는 건드리지 않는다
 *   2) 정한 채널 안에 있어야 한다 (채널을 비우면 봇이 보는 모든 채널)
 *   3) 본문·embed 전체에서 포함 키워드를 찾고, 제외 키워드가 하나라도 있으면 건너뛴다
 *   4) **링크가 담긴 알림** → 그 링크를 자동으로 연다 (모든 링크를 다 열지 않고 첫 링크만)
 *      **@everyone 멘션이 담긴 알림** → 링크가 있으면 그 링크를, 없으면 설정한 "대신 열 주소"를 연다
 *      (@everyone 은 mentioned_roles 에 everyone 롤 id = 메시지 id 가 들어 온다)
 *
 * 같은 주소 다시 열기까지(reopenSeconds): 이만큼 지나지 않은 같은 URL 은 다시 열지 않는다.
 *   품절 재공지처럼 같은 링크가 반복 올 때 창 폭주를 막는다. 0 이면 매번 연다.
 * 새 창(newWindow) vs 새 탭: true 면 chrome.windows.create, false 면 지금 창에 새 탭.
 *
 * 서비스 워커는 30초 동안 할 일이 없으면 잠든다. 심장박동을 디스코드가 달라는 간격보다
 * 짧게 20초마다 보내 버티고, 그래도 끊기면 1분 keepalive 알람(background.js)이 ensure() 로 깨운다.
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

// ── 옛 판 설정 옮기기 ───────────────────────────────────
//
// 0.3 discord(오프너) → 0.4 monitor(기록만) → 0.5 discord(오프너) 을 거쳐 온 사람 모두 살린다.
// 토큰·채널·키워드는 그대로 두고, 모니터링 전용 칸(webhookOnly·linkOnly)은 버린다.
// 오프너는 태생부터 "웹훅 알림만 여는" 것이므로 webhookOnly:true 와 같은 동작이라 옵션도 없다.

export function upgradeDiscord(saved) {
  const D = DEFAULT_SETTINGS.discord;
  const old = saved.discord || saved.monitor || {};
  const out = { ...D, ...old };
  delete out.webhookOnly;  // 오프너는 무조건 웹훅만 받는다. 예전 "사람消息도 잡던" 모니터링 옵션은 폐기.
  delete out.linkOnly;     // 링크/@everyone 여부로 열지 결정한다. 별도 스위치는 없다.
  return out;
}

// ── 본문 읽는 도구 ──────────────────────────────────────

const URL_RE = /https?:\/\/[^\s<>()"'`\]]+/g;
const urlsIn = (t) => (t && t.match(URL_RE) || []).map((u) => u.replace(/[.,;:!?]+$/, ""));

/** 메시지에 든 모든 http(s) 링크를 순서대로 (embed url 포함). */
export function linksOf(msg) {
  const found = [];
  for (const e of msg.embeds || []) if (e.url) found.push(e.url);
  found.push(...urlsIn(msg.content));
  for (const e of msg.embeds || []) {
    found.push(...urlsIn(e.description));
    for (const f of e.fields || []) found.push(...urlsIn(f.value));
  }
  return [...new Set(found)];   // 중복 제거, 순서 유지
}

/** 키워드·@everyone 검사에 쓸 본문 전체(제목·설명·필드 포함)를 작은 글자로. */
function textOf(msg) {
  const parts = [msg.content || ""];
  for (const e of msg.embeds || []) {
    parts.push(e.title || "", e.description || "", (e.footer && e.footer.text) || "");
    for (const f of e.fields || []) parts.push(f.name || "", f.value || "");
  }
  return parts.join("\n").toLowerCase();
}

/** @everyone 멘션이 실제로 살아있는 멘션인가. */
function hasEveryone(msg) {
  // content 에는 <@everyone> 형태로 오기도 하고, mentioned_roles 에 everyone 롤 id(=guild id) 가 온다.
  if (/<@everyone>|@\s*everyone/i.test(String(msg.content || ""))) return true;
  const roles = msg.mentioned_roles || msg.mentionRoles || [];
  return roles.includes(msg.guild_id);   // everyone 롤의 id 는 서버 id 와 같다
}

/** 목록·기록에 보여 줄 한 줄 요약. */
function summaryOf(msg) {
  const e = msg.embeds && msg.embeds[0];
  const raw = (e && (e.title || e.description)) || msg.content || "";
  return String(raw).replace(/\s+/g, " ").trim().slice(0, 160);
}

// ── 오프너 본체 ─────────────────────────────────────────

// background.js 의 getSettings/addLog 를 wireDiscord() 로 주입받아 쓴다 (순환 import 방지).
let getSettingsLocal = async () => ({ enabled: false, discord: DEFAULT_SETTINGS.discord });
let logAdd = () => {};

export function wireDiscord({ getSettings, addLog }) {
  getSettingsLocal = getSettings;
  logAdd = addLog;
}

export const discord = {
  ws: null,
  beat: null,
  acked: true,
  seq: null,
  sessionId: null,
  resumeUrl: null,
  state: "off",
  detail: "",
  opened: 0,        // 이번 세션에 연 횟수 (팝업/설정에 보여 주기만, 저장하지는 않음)
  lastOpen: new Map(), // url → 마지막으로 연 시각 (reopenSeconds 판단)

  status() {
    return { state: this.state, detail: this.detail, opened: this.opened };
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

  /** 켜져 있어야 하는데 연결이 없으면 붙는다. 시작·알람·설정 변경 때 부른다. */
  async ensure() {
    const settings = await getSettingsLocal();
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
          else this.send(2, { token, intents: INTENTS, properties: { os: "windows", browser: "aio-extension", device: "aio-opener" } });
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
        logAdd("error", this.detail, "디스코드");
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
        logAdd("warn", "디스코드가 대답이 없어 다시 붙습니다", "디스코드");
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
      logAdd("ok", `디스코드에 붙었습니다 (${this.detail})`, "디스코드");
    } else if (type === "RESUMED") {
      this.state = "on";
      logAdd("info", "디스코드에 다시 붙었습니다", "디스코드");
    } else if (type === "MESSAGE_CREATE") {
      this.onMessage(d);
    }
  },

  /**
   * 알림을 받아 조건에 맞으면 링크를 연다.
   * 결정표:
   *   웹훅 아님                    → 건다
   *   채널 필터 통과 못 함          → 건다
   *   포함 키워드 통과 못 함        → 건다
   *   제외 키워드 걸림              → 건다
   *   링크 있음                     → 첫 링크를 연다 (openLink 꺼져 있으면 @everyone 확인만)
   *   링크 없고 @everyone + 주소 있음→ everyoneToUrl 을 연다
   *   그 외                        → 건다
   */
  async onMessage(msg) {
    const settings = await getSettingsLocal();
    const cfg = settings.discord;
    if (!settings.enabled || !cfg.enabled) return;

    if (!msg.webhook_id) return;   // 웹훅 알림만 연다 (사람이 친 메시지는 자동 열기 대상이 아니다)

    const channels = (cfg.channels || []).map(String).filter(Boolean);
    if (channels.length && !channels.includes(msg.channel_id)) return;

    const text = textOf(msg);
    const keywords = (cfg.keywords || []).map((k) => k.toLowerCase()).filter(Boolean);
    const skips = (cfg.skipKeywords || []).map((k) => k.toLowerCase()).filter(Boolean);
    if (keywords.length && !keywords.some((k) => text.includes(k))) return;
    if (skips.some((k) => text.includes(k))) return;

    const links = linksOf(msg);
    const everyone = hasEveryone(msg);
    const why = links.length ? "링크" : everyone ? "@everyone" : "";
    if (!why) return;   // 링크도 @everyone 도 아닌 웹훅 알림은 아무것도 하지 않는다

    if (!cfg.openLink && links.length) {
      logAdd("info", `히트: ${summaryOf(msg).slice(0, 40)} — 링크 열기가 꺼져 있어 넘깁니다`, "디스코드");
      return;
    }
    const url = links.length ? links[0] : String(cfg.everyoneToUrl || "").trim();
    if (!url) {
      logAdd("info", `@everyone 알림인데 대신 열 주소가 없어 넘깁니다: ${summaryOf(msg).slice(0, 40)}`, "디스코드");
      return;
    }
    const ok = await this.openLink(url, cfg);
    if (ok) {
      this.opened++;
      logAdd("ok", `${why} 감지 → 열었습니다 (${url.slice(0, 80)})`, "디스코드");
    } else {
      logAdd("info", `${why} 감지했으나 ${cfg.reopenSeconds}초 안의 같은 주소라 다시 열지 않았습니다 (${url.slice(0, 80)})`, "디스코드");
    }
  },

  /** 같은 주소 재열기 간격을 지켜서 연다. 열었으면 true, 간격 때문에 넘겼으면 false. */
  async openLink(url, cfg) {
    const now = Date.now();
    const gap = Math.max(0, Number(cfg.reopenSeconds) || 0) * 1000;
    const last = this.lastOpen.get(url) || 0;
    if (gap && now - last < gap) return false;
    // 기억이 끝없이 자라지 않게 오래된 것부터 정리
    if (this.lastOpen.size > 100) {
      for (const [u, t] of this.lastOpen) { if (now - t > 10 * 60 * 1000) this.lastOpen.delete(u); }
    }
    this.lastOpen.set(url, now);
    if (cfg.newWindow) await chrome.windows.create({ url, focused: true });
    else await chrome.tabs.create({ url, active: true });
    return true;
  },
};
