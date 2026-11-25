const endpoint = "https://seol-tracker-api.jqu8ry.workers.dev/v2/roulette";
const interval = 30_000;
const displayNames = new Map([["욕망의 룰렛 (상시 오픈)", "욕망의 룰렛(상시)"], ["룰렛", "이벤트 룰렛"]]);
const get = id => document.getElementById("roulette-" + id);
const dialog = get("dialog"), picker = get("picker"), status = get("status");
const clock = new Intl.DateTimeFormat("ko-KR", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const verifiedDate = new Intl.DateTimeFormat("ko-KR", { year:"numeric", month:"long", day:"numeric", timeZone:"Asia/Seoul" });
// Verified against the public channel viewer. Never match a replacement wheel by name or price.
const lastParticipation = new Map([
  ["655fc180-d46f-11f1-97d0-f1910460d610", { keyword:"으흐흐", enabled:true, date:"2026-11-21" }],
  ["da12e78a-ff6c-11f0-9978-107b4494841b", { keyword:"룰렛", enabled:false, date:"2026-11-21" }],
]);
let snapshot = null, checkedAt, timer, request;
let copyTimer, copySequence = 0, refreshLabelTimer;
function refreshButton(state = "") {
  clearTimeout(refreshLabelTimer);
  const button = get("refresh");
  button.dataset.state = state;
  button.textContent = state === "done" ? "✓ 갱신 완료" : state === "busy" ? "갱신 중" : "지금 갱신";
}

function resetCopy(animate = false) {
  clearTimeout(copyTimer);
  copySequence++;
  get("copy-feedback").textContent = "";
  get("copy").firstElementChild.textContent = "복사";
  get("copy").setAttribute("aria-label","참여 키워드 복사");
  get("copy").classList.toggle("copy-motion", animate);
  get("copy").classList.remove("is-copied");
}

function stop() {
  clearTimeout(timer);
  request?.abort();
  request = null;
  get("loading").hidden = true;
  get("area").setAttribute("aria-busy", "false");
  get("refresh").disabled = !dialog.open || document.hidden;
  get("refresh").removeAttribute("aria-disabled");
}

function readData(json) {
  if (!Array.isArray(json?.roulettes) || !Number.isFinite(json.checkedAt)) throw new Error("Invalid roulette list");
  return json.roulettes.map(row => {
    if (typeof row.uuid !== "string" || typeof row.name !== "string" ||
        !Number.isFinite(row.price) || !Array.isArray(row.items)) throw new Error("Invalid roulette");
    const items = row.items.map(item => {
      if (typeof item.name !== "string" || !Number.isFinite(item.chance)) throw new Error("Invalid odds");
      return { name: item.name, chance: item.chance };
    });
    const verified = typeof row.keyword === "string";
    if (verified) lastParticipation.set(row.uuid, {keyword:row.keyword, enabled:row.enabled, date:json.checkedAt});
    const settings = lastParticipation.get(row.uuid);
    return { id: row.uuid, name: row.name, price: row.price, items,
      keyword: settings?.keyword, enabled: typeof row.enabled === "boolean" ? row.enabled : undefined,
      lastChecked: !verified && settings ? verifiedDate.format(new Date(settings.date)) : "",
      wasOff: !verified && settings?.enabled === false };
  }).sort((a,b) => a.price-b.price || a.id.localeCompare(b.id));
}

function renderTable() {
  const row = snapshot?.find(item => item.id === picker.querySelector(":checked")?.value);
  const body = get("items");
  body.replaceChildren();
  get("participation").hidden = !row;
  if (!row) return;
  get("keyword").textContent = row.keyword ?? "확인할 수 없어요";
  if (row.keyword === "") get("keyword").textContent = "필요 없어요";

  const note = get("inactive");
  const off = row.enabled === false;
  get("copy").disabled = off || (row.enabled !== true && row.wasOff);
  note.classList.toggle("roulette-off", off || get("copy").disabled);
  get("copy").hidden = !row.keyword || get("copy").disabled;
  note.textContent = off ? "룰렛 꺼짐 · 참여 불가" : "마지막 확인 당시 꺼짐";
  note.hidden = !get("copy").disabled;
  const verified = get("verified");
  verified.hidden = !row.lastChecked;
  verified.textContent = row.lastChecked ? row.lastChecked + " 키워드 확인" : "";
  for (const item of row.items) {
    const tr = body.insertRow();
    for (const value of [item.name, item.chance + "%"]) {
      tr.insertCell().textContent = value;
    }
  }
}

function renderList(rows) {
  const id = picker.querySelector(":checked")?.value;
  const previous = snapshot?.find(row => row.id === id);
  const focused = document.activeElement;
  const restorePickerFocus = picker.contains(focused);
  const copy = get("copy");
  snapshot = rows;
  const selected = rows.find(row => row.id === id) ?? rows[0];
  const keywordChanged = Boolean(previous && selected?.id === id && previous.keyword !== selected.keyword);
  picker.replaceChildren(...rows.map(row => {
    const label = document.createElement("label");
    const input = document.createElement("input");
    input.type = "radio";
    input.name = "roulette-choice";
    input.value = row.id;
    input.checked = row === selected;
    const name = document.createElement("span");
    name.textContent = displayNames.get(row.name) ?? row.name;
    const price = document.createElement("small");
    price.textContent = `1회 ${row.price.toLocaleString("ko-KR")} 치즈`;
    label.append(input, name, price);
    return label;
  }));
  picker.hidden = !rows.length;
  get("scroll").hidden = !rows.length;
  renderTable();
  if (previous?.id !== selected?.id || keywordChanged || copy.hidden || copy.disabled) resetCopy();
  const restoreFromCopy = focused === copy &&
    (!selected || selected.id !== id || keywordChanged || copy.hidden || copy.disabled);
  if (restorePickerFocus || restoreFromCopy) {
    (picker.querySelector(":checked") ?? dialog.querySelector("button[autofocus]")).focus();
  }
  return keywordChanged;
}

async function refresh(manual = false) {
  stop();
  refreshButton();
  if (!dialog.open || document.hidden) return;
  const current = new AbortController();
  request = current;
  const started = performance.now();
  let success = false;
  if (manual) refreshButton("busy");
  get("refresh").setAttribute("aria-disabled", "true");
  try {
    get("loading").hidden = false;
    get("area").setAttribute("aria-busy", "true");
    status.textContent = "";
    const response = await fetch(endpoint, {
      credentials: "omit", cache: "no-store", redirect: "error", referrerPolicy: "no-referrer",
      signal: AbortSignal.any([current.signal, AbortSignal.timeout(10_000)]),
    });
    if (!response.ok) throw new Error("Lookup failed");
    const data = await response.json();
    if (current.signal.aborted) return;
    const rows = readData(data);
    const changed = JSON.stringify(snapshot) !== JSON.stringify(rows);
    const updated = snapshot !== null && changed;
    const keywordChanged = changed && renderList(rows);
    checkedAt = clock.format(data.checkedAt);
    const notice = keywordChanged ? "참여 키워드가 바뀌었어요. " : updated ? "변경된 확률표를 반영했어요. " : "";
    status.textContent = rows.length ? notice + "마지막 확인 " + checkedAt :
      "현재 공개된 룰렛이 없어요.";
    success = true;
  } catch {
    if (current.signal.aborted) return;
    status.textContent = checkedAt ? `최신 확률을 확인하지 못했어요. ${checkedAt}에 확인한 표예요.` :
      "확률표를 불러오지 못했어요. 뚜봇 원본에서도 확인할 수 있어요.";
  } finally {
    if (manual && success && request === current) {
      await new Promise(resolve => setTimeout(resolve, Math.max(0, 500 - (performance.now() - started))));
    }
    if (request === current) {
      stop();
      if (manual && success) {
        refreshButton("done");
        refreshLabelTimer = setTimeout(() => refreshButton(), 1500);
      } else refreshButton();
      if (dialog.open && !document.hidden) timer = setTimeout(refresh, interval);
    }
  }
}

function openDialog() {
  if (!dialog.open) dialog.showModal();
  void refresh();
}
document.getElementById("open-roulette").addEventListener("click", openDialog);
get("refresh").addEventListener("click", () => {
  if (request || !dialog.open || document.hidden) return;
  void refresh(true);
});
picker.addEventListener("change", () => { resetCopy(); renderTable(); get("scroll").scrollTop = 0; });
get("copy").addEventListener("click", async () => {
  const row = snapshot?.find(item => item.id === picker.querySelector(":checked")?.value);
  if (!row?.keyword || get("copy").disabled) return;
  clearTimeout(copyTimer);
  const sequence = ++copySequence;
  try {
    await navigator.clipboard.writeText(row.keyword);
    if (sequence !== copySequence) return;
    get("copy").classList.add("copy-motion", "is-copied");
    get("copy-feedback").textContent = "참여 키워드 복사 완료";
    copyTimer = setTimeout(() => resetCopy(true), 1500);
  } catch {
    if (sequence !== copySequence) return;
    resetCopy();
    get("copy").firstElementChild.textContent = "복사 실패";
    get("copy").setAttribute("aria-label","복사 실패 · 키워드를 선택해 직접 복사해 주세요.");
    get("copy-feedback").textContent = "복사하지 못했어요. 키워드를 선택해 직접 복사해 주세요.";
    copyTimer = setTimeout(() => resetCopy(true),1500);
  }
});
dialog.addEventListener("close", () => {
  if (!dialog.open) { stop(); refreshButton(); resetCopy(); }
});
window.addEventListener("pagehide", stop);
document.addEventListener("visibilitychange", () => { if (dialog.open) void refresh(); });
