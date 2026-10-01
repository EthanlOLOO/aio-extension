import { DEFAULT_SETTINGS } from "./defaults.js";

const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);
const list = (s) => s.split(",").map((x) => x.trim()).filter(Boolean);

let settings = await send({ type: "getSettings" });

function fillForm() {
  const d = settings.discord;
  $("token").value = d.token;
  $("channels").value = d.channels.join(", ");
  $("keywords").value = d.keywords.join(", ");
  $("skip").value = d.skipKeywords.join(", ");
  $("everyoneToUrl").value = d.everyoneToUrl || "";
  $("openLink").checked = d.openLink;
  $("newWindow").checked = d.newWindow;
  $("reopenSeconds").value = d.reopenSeconds;
  $("npayMatch").value = settings.pins.npay.match.join(", ");
  $("lpayMatch").value = settings.pins.lpay.match.join(", ");
  $("trusted").value = settings.trustedClick;
  $("flows").value = JSON.stringify(settings.flows, null, 2);
}

async function showDiscord() {
  const st = await send({ type: "discordStatus" });
  const label = { on: "연결됨", connecting: "연결 중…", retry: "다시 연결하는 중", fatal: "멈춤", off: "꺼짐" }[st.state] || st.state;
  $("dstate").textContent = `${label}${st.detail ? " — " + st.detail : ""} · 연 것 ${st.opened || 0}건`;
}

$("save").onclick = async () => {
  let flows;
  try {
    flows = JSON.parse($("flows").value);
    if (!Array.isArray(flows)) throw new Error("맨 바깥이 [ ] 목록이어야 합니다");
    const ids = new Set();
    for (const f of flows) {
      if (!f.id || !f.name || !Array.isArray(f.match) || !Array.isArray(f.steps)) {
        throw new Error("흐름마다 id · name · match[] · steps[] 가 있어야 합니다");
      }
      if (ids.has(f.id)) throw new Error(`id 가 겹칩니다: ${f.id}`);
      ids.add(f.id);
    }
  } catch (e) {
    $("saved").textContent = `흐름 JSON 오류 — ${e.message}`;
    $("saved").className = "note err";
    return;
  }
  const oldToken = settings.discord.token;
  settings.discord = {
    ...settings.discord,
    token: $("token").value.trim(),
    channels: list($("channels").value),
    keywords: list($("keywords").value),
    skipKeywords: list($("skip").value),
    everyoneToUrl: $("everyoneToUrl").value.trim(),
    openLink: $("openLink").checked,
    newWindow: $("newWindow").checked,
    reopenSeconds: Math.max(0, Number($("reopenSeconds").value) || 0),
  };
  settings.pins.npay.match = list($("npayMatch").value);
  settings.pins.lpay.match = list($("lpayMatch").value);
  settings.trustedClick = $("trusted").value;
  settings.flows = flows;
  await chrome.storage.local.set({ settings });
  if (oldToken !== settings.discord.token) await send({ type: "discordRestart" });
  $("saved").textContent = `저장했습니다 ${new Date().toTimeString().slice(0, 8)}`;
  $("saved").className = "note on";
  setTimeout(showDiscord, 1500);
};

$("defaults").onclick = () => {
  if (!confirm("흐름을 기본값으로 되돌릴까요? (저장을 눌러야 적용됩니다)")) return;
  $("flows").value = JSON.stringify(DEFAULT_SETTINGS.flows, null, 2);
};
$("resetFlows").onclick = async () => {
  await send({ type: "resetFlows" });
  $("saved").textContent = "진행 상태를 처음으로 돌렸습니다";
};
$("reconnect").onclick = async () => { await send({ type: "discordRestart" }); setTimeout(showDiscord, 1500); };
$("testOpen").onclick = async () => {
  const got = await send({ type: "testOpen" });
  $("saved").textContent = got && got.ok !== false
    ? "시험용 창을 열었습니다 (설정한 대로 새 창/새 탭)"
    : `열기 실패: ${JSON.stringify(got)}`;
  $("saved").className = "note on";
};

fillForm();
showDiscord();
