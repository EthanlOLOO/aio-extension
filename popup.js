import { SITES } from "./defaults.js";

const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);
function el(tag, props = {}, ...kids) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...kids);
  return node;
}

let settings;

async function save() {
  await chrome.storage.local.set({ settings });
  renderMaster();
}

function renderMaster() {
  $("enabled").checked = settings.enabled;
  $("dryRun").checked = settings.dryRun;
  $("discordEnabled").checked = settings.discord.enabled;
  $("master-note").textContent = settings.enabled
    ? (settings.dryRun ? "켜짐 — 연습 모드" : "켜짐 — 켜 둔 기능이 실제로 누릅니다")
    : "꺼짐 — 아무것도 하지 않습니다";
  $("master-note").className = "note" + (settings.enabled ? (settings.dryRun ? " warn" : " on") : "");
}

function check(label, on, change) {
  const cb = el("input", { type: "checkbox", checked: on, onchange: () => change(cb.checked) });
  return el("label", { className: "row" }, cb, " " + label);
}

/** 결제수단 하나의 비밀번호 칸: 자동 입력 켜기 · 저장 · 기억 여부. */
function pinBlock(kind, cfg) {
  const state = el("p", { className: "note sub" });
  const input = el("input", {
    type: "password", inputMode: "numeric", maxLength: 6, placeholder: "숫자 6자리", autocomplete: "off",
  });
  const remember = el("input", { type: "checkbox" });

  const refresh = async () => {
    const info = await send({ type: "pinInfo", kind });
    remember.checked = info.remembered;
    state.textContent = info.has
      ? `비밀번호 저장됨 (${info.remembered ? "브라우저를 꺼도 남음" : "브라우저를 끄면 지워짐"})`
      : "저장된 비밀번호가 없습니다";
  };
  const saveBtn = el("button", {
    textContent: "저장",
    onclick: async () => {
      const pin = input.value.replace(/\D/g, "");
      if (pin && pin.length !== 6 && !confirm(`${pin.length}자리입니다. 보통 6자리예요. 그래도 저장할까요?`)) return;
      await send({ type: "setPin", kind, pin, remember: remember.checked });
      input.value = "";
      refresh();
    },
  });
  const clearBtn = el("button", {
    textContent: "지우기", className: "link",
    onclick: async () => { await send({ type: "setPin", kind, pin: "" }); refresh(); },
  });
  remember.onchange = async () => { await send({ type: "rememberPin", kind, remember: remember.checked }); refresh(); };

  refresh();
  return el("div", { className: "pin" },
    check(`${cfg.name} 비밀번호 자동 입력`, cfg.enabled, (v) => { cfg.enabled = v; save(); }),
    el("div", { className: "row sub" }, input, saveBtn, clearBtn),
    el("label", { className: "row small sub" }, remember, " 브라우저를 꺼도 기억 (디스크에 평문)"),
    state,
  );
}

/** 품절이면 몇 초마다 새로고침할지. 0 이면 안 한다. */
function reloadRow(flow) {
  const input = el("input", {
    type: "number", min: 0, max: 600, value: flow.reloadSeconds || 0, className: "num",
    onchange: () => { flow.reloadSeconds = Math.max(0, Number(input.value) || 0); save(); },
  });
  return el("label", { className: "row small sub" }, "품절이면 ", input, "초마다 새로고침 (0 = 안 함)");
}

function renderSites() {
  const box = $("sites");
  box.textContent = "";
  const known = new Set(SITES.map((s) => s.id));
  const groups = [...SITES, { id: "etc", name: "기타" }];
  for (const site of groups) {
    const flows = settings.flows.filter((f) => (known.has(f.site) ? f.site : "etc") === site.id);
    const pins = Object.entries(settings.pins).filter(([, p]) => p.site === site.id);
    if (!flows.length && !pins.length) continue;
    const card = el("div", { className: "site" }, el("h3", { textContent: site.name }));
    for (const flow of flows) {
      card.append(check(flow.name, flow.enabled, (v) => { flow.enabled = v; save(); }));
      if ("reloadSeconds" in flow) card.append(reloadRow(flow));
    }
    for (const [kind, cfg] of pins) card.append(pinBlock(kind, cfg));
    box.append(card);
  }
}

async function renderDiscord() {
  const st = await send({ type: "discordStatus" });
  const label = { on: "연결됨", connecting: "연결 중…", retry: "다시 연결하는 중", fatal: "멈춤", off: "꺼짐" }[st.state] || st.state;
  $("discordState").textContent = `${label}${st.detail ? " — " + st.detail : ""}`;
  $("discordState").className = "note" + (st.state === "on" ? " on" : st.state === "fatal" ? " err" : "");
}

async function renderLog() {
  const { log = [] } = await chrome.storage.session.get("log");
  const ol = $("log");
  ol.textContent = "";
  for (const e of log.slice(-40).reverse()) {
    const t = el("time", { textContent: new Date(e.at).toTimeString().slice(0, 8) });
    ol.append(el("li", { className: e.level }, t, `${e.where ? e.where + " · " : ""}${e.text}`));
  }
  if (!log.length) ol.append(el("li", { className: "note", textContent: "아직 없습니다" }));
}

$("enabled").onchange = (e) => { settings.enabled = e.target.checked; save(); };
$("dryRun").onchange = (e) => { settings.dryRun = e.target.checked; save(); };
$("discordEnabled").onchange = async (e) => {
  settings.discord.enabled = e.target.checked;
  await save();
  setTimeout(renderDiscord, 1500);
};
$("clearLog").onclick = async () => { await send({ type: "clearLog" }); renderLog(); };
chrome.storage.onChanged.addListener((c, area) => { if (area === "session" && c.log) renderLog(); });

settings = await send({ type: "getSettings" });
renderMaster();
renderSites();
renderDiscord();
renderLog();
