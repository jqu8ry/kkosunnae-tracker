import { DAY_MS, monitoringActive, replayUrl, seoulWeekStart } from "./config.js";

const weekdays = "월화수목금토일";
const dateFormat = new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", month: "numeric", day: "numeric", weekday: "short" });
const timeFormat = new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const labels = { live: "● LIVE", replay: "다시보기", waiting: "준비 중", unknown: "상태 미확인", unavailable: "시청 불가", checking: "확인 중" };

function tilt(day) {
  let hash = Math.imul(day ^ (day >>> 16), 0x45d9f3b);
  hash = Math.imul(hash ^ (hash >>> 16), 0x45d9f3b);
  return ((hash ^ (hash >>> 16)) >>> 0) % 91 - 45;
}

function broadcastKey(item) {
  return item.liveId ? "live-" + item.liveId : item.archiveKey || "video-" + item.videoNo;
}

export function formatWeekdayDate(timestamp) {
  const parts = Object.fromEntries(dateFormat.formatToParts(timestamp).map(({ type, value }) => [type, value]));
  return `${parts.month}.${parts.day}.(${parts.weekday})`;
}

export function datedListTitle(timestamp, label, count) {
  if (!Number.isFinite(timestamp)) return `${label} ${count}개`;
  return `${formatWeekdayDate(timestamp)} ${label} ${count}개`;
}

function broadcastListTitle(date, items) {
  return items.length > 1 ? datedListTitle(date, "방송", items.length) :
    datedListTitle(date, "다시보기", items[0]?.replayParts?.length || items.length);
}

export function replayPartRows(parts, start, navigate, checks) {
  return parts.map((part, index) => {
    const status = checks.get(part.videoNo)?.status;
    const row = document.createElement("button");
    row.type = "button";
    row.className = "replay-choice";
    row.dataset.item = "video-" + part.videoNo;
    const title = document.createElement("span");
    title.textContent = (part.partNumber ? part.partNumber + "부 · " : "") + (part.title || "방송");
    const clock = document.createElement("span");
    if (parts.length === 1) {
      clock.textContent = timeFormat.format(start);
    } else if (index === 0 || part.openedAt !== parts[index - 1].openedAt) {
      // Some recordings repeat the broadcast start for every file.
      const day = ms => Math.floor((ms + 9 * 3600000) / DAY_MS);
      const offset = day(part.openedAt) - day(start);
      clock.textContent = (offset === 1 ? "다음 날 " : offset > 1 ? offset + "일 뒤 " : "") + timeFormat.format(part.openedAt);
    }
    row.disabled = status !== "public";
    if (row.disabled) title.textContent += status === "unavailable" ? " · 시청 불가" : " · 확인 중";
    row.append(title, clock);
    row.onclick = () => navigate(part);
    return row;
  });
}

function hasChoices(items) {
  return items.length > 1 || (items[0]?.state === "replay" && items[0]?.replayParts?.length > 1);
}

function groupByDay(start, now, { broadcasts, entries, settings, report, replayChecks }) {
  function replayState(videoNo) {
    return { public: "replay", unavailable: "unavailable", unknown: "unknown" }[replayChecks.get(videoNo)?.status] ?? "checking";
  }
  const days = Array.from({ length: 7 }, () => []);
  const known = new Map(broadcasts.filter(item => item.liveId).map(item => [item.liveId, { ...item }]));
  const archives = new Map();
  for (const item of broadcasts) if (!item.liveId && item.videoNo) archives.set(item.videoNo, item);
  for (const entry of entries) {
    if (entry.kind === "archive" && entry.replayVideoNo && !archives.has(entry.replayVideoNo)) {
      archives.set(entry.replayVideoNo, { videoNo: entry.replayVideoNo, archiveKey: entry.id, openedAt: entry.replayOpenedAt ?? entry.openedAt ?? entry.at, replayParts: entry.replayParts, title: entry.replayTitle || entry.title });
    }
    if (entry.kind !== "live" && entry.kind !== "missed") continue;
    const id = Number(entry.id.split("-")[1]);
    if (!Number.isSafeInteger(id) || id <= 0) continue;
    const item = known.get(id) ?? { liveId: id };
    item.replayTitle ||= entry.replayTitle;
    item.replayParts ||= entry.replayParts;
    item.replayOpenedAt ||= entry.replayOpenedAt;
    item.title ||= entry.title;
    item.openedAt ||= entry.openedAt;
    item.videoNo ||= entry.replayVideoNo;
    item.ended ||= entry.kind === "missed";
    known.set(id, item);
  }
  if (report.status === "live" && report.observedLiveId && report.currentOpenedAt && !known.get(report.observedLiveId)?.openedAt) {
    known.set(report.observedLiveId, { ...known.get(report.observedLiveId), liveId: report.observedLiveId, openedAt: report.currentOpenedAt });
  }
  const used = new Set();
  function add(item) {
    if (item.state !== "live") item = { ...item, openedAt: item.replayOpenedAt ?? item.openedAt, title: item.replayTitle || item.title };
    if (!Number.isFinite(item.openedAt) || item.openedAt > now) return;
    const index = Math.floor((item.openedAt - start) / DAY_MS);
    if (days[index]) days[index].push(item);
  }
  for (const item of known.values()) {
    const same = item.liveId === report.observedLiveId;
    const live = same && report.status === "live" && monitoringActive(settings);
    const candidates = item.videoNo ? [] : [...archives.values()].filter(video => !used.has(video.videoNo) && video.openedAt === item.openedAt && (!video.replayParts?.[0]?.sourceLiveId || video.replayParts[0].sourceLiveId === item.liveId));
    const archived = archives.get(item.videoNo) ?? (candidates.length === 1 ? candidates[0] : null);
    if (archived) used.add(archived.videoNo);
    const videoNo = archived?.videoNo ?? item.videoNo;
    const ended = item.ended || item.liveId === report.closedLiveId || report.status === "offline" || (report.observedLiveId && !same);
    const state = live ? "live" : replayUrl(videoNo) ? replayState(videoNo) : ended ? "waiting" : "unknown";
    add({ ...item, openedAt: item.openedAt || archived?.openedAt, title: item.title || archived?.title, videoNo, state });
  }
  for (const video of archives.values()) if (!used.has(video.videoNo)) add({ ...video, state: replayState(video.videoNo) });
  for (const day of days) day.sort((a,b) => b.openedAt - a.openedAt);
  return days;
}

export function createWeeklyCard(el, navigate, applyReplayChecks) {
  let cached = {}, clips = {}, refreshTimer, selected = -1, signature, context, active = false;
  const pending = new Set();
  const weeks = new Map();
  let previous = false;
  for (const [id, showPrevious] of [["week-previous", true], ["week-current", false]]) {
    el[id].addEventListener("click", () => {
      if (previous === showPrevious) return;
      previous = showPrevious;
      update(active, context);
      const days = el["week-days"];
      days.getAnimations().forEach(animation => animation.cancel());
      if (!matchMedia("(prefers-reduced-motion: reduce)").matches) {
        days.animate([{opacity:0.45, transform:`translateX(${previous ? -4 : 4}px)`}, {opacity:1, transform:"none"}], {duration:180, easing:"ease-out"});
      }
      el["week-heading"].focus();
    });
  }
  let groups = [], opening = false, choicesSignature;
  let choiceType = "broadcast";
  const dialog = el["week-dialog"];
  function closeChoices() {
    const cell = el["week-days"].querySelector(`[data-day="${selected}"]`);
    const trigger = cell?.querySelector(`[data-kind="${choiceType}"]`);
    selected = -1;
    trigger?.setAttribute("aria-expanded", "false");
    renderChoices();
    (trigger ?? el["week-heading"]).focus({ preventScroll: true });
  }
  el["week-close"].onclick = closeChoices;
  dialog.addEventListener("cancel", event => { event.preventDefault(); closeChoices(); });
  dialog.addEventListener("keydown", event => {
    if (event.key === "Escape") { event.preventDefault(); closeChoices(); }
  });
  function toggleChoices(day, type, event) {
    selected = selected === day && choiceType === type ? -1 : day;
    choiceType = type;
    for (const trigger of el["week-days"].querySelectorAll("[aria-expanded]")) {
      trigger.setAttribute("aria-expanded", String(Number(trigger.closest(".week-day").dataset.day) === selected && trigger.dataset.kind === type));
    }
    renderChoices();
    if (selected === day) el["week-choices"].querySelector("a, button:enabled")?.focus();
  }
  function message(text) {
    el["week-status"].textContent = text;
    el["week-status"].hidden = !text;
  }
  async function open(item) {
    if (opening) return;
    opening = true;
    try {
      const result = await navigate(item.state === "live" ? { type: "open-live", liveId: item.liveId } :
        { type: "open-week-replay", videoNo: item.videoNo });
      if (result?.ok && dialog.open) closeChoices();
      const text = result?.ok ? "" : result?.message || "탭을 열지 못했어요. 잠시 후 다시 눌러 주세요.";
      if (dialog.open) el["week-list-status"].textContent = text;
      message(text);
    } catch { message("탭을 열지 못했어요. 잠시 후 다시 눌러 주세요."); }
    finally { opening = false; }
  }
  function renderChoices() {
    const choices = el["week-choices"];
    const showClips = selected >= 0 && choiceType === "clips";
    const items = showClips ? clips.days?.[selected] ?? [] : groups[selected] ?? [];
    const key = JSON.stringify([choiceType, selected, items]);
    if (key === choicesSignature) return;
    choicesSignature = key;
    const focused = choices.contains(document.activeElement) ? document.activeElement.dataset.item : null;
    choices.replaceChildren();
    choices.hidden = selected < 0;
    if (selected < 0) {
      if (dialog.open) dialog.close();
      return;
    }
    const date = Number(el["week-days"].dataset.start) + selected * DAY_MS;
    el["week-list-title"].textContent = showClips
      ? datedListTitle(date, "클립", clips.counts?.[selected] ?? items.length)
      : broadcastListTitle(date, items);
    el["week-list-status"].textContent = "";
    if (!dialog.open) dialog.showModal();
    if (showClips && !items.length) el["week-list-status"].textContent = "클립 목록을 불러오지 못했어요. 잠시 후 다시 확인해 주세요.";
    for (const item of items) {
      if (showClips) {
        const link = document.createElement("a");
        link.href = "https://chzzk.naver.com/clips/" + encodeURIComponent(item.id);
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.addEventListener("click", () => setTimeout(() => { if (dialog.open) closeChoices(); }, 0));
        link.textContent = `${timeFormat.format(item.time)} · ${item.title}`;
        link.dataset.item = "clip-" + item.id;
        choices.append(link);
        if (focused === link.dataset.item) link.focus({ preventScroll: true });
        continue;
      }
      if (item.state === "replay" && item.replayParts?.length) {
        let parent = choices;
        if (items.length > 1 && item.replayParts.length > 1) {
          parent = document.createElement("div");
          parent.className = "week-parts-group";
          parent.setAttribute("role", "group");
          parent.setAttribute("aria-label", timeFormat.format(item.openedAt) + " 방송의 분할 다시보기");
          choices.append(parent);
        }
        for (const row of replayPartRows(item.replayParts, item.openedAt, part => open({ ...part, state: "replay" }), context.replayChecks)) {
          if (item.replayParts.length === 1) row.dataset.item = broadcastKey(item);
          parent.append(row);
          if (focused === row.dataset.item && !row.disabled) row.focus({ preventScroll: true });
        }
        continue;
      }
      const canOpen = item.state === "live" || item.state === "replay";
      const row = document.createElement(canOpen ? "button" : "span");
      const caption = `${timeFormat.format(item.openedAt)} · ${item.title || "방송"}`;
      row.textContent = item.state === "replay" ? caption : `${caption} · ${labels[item.state]}`;
      if (item.state === "replay") row.setAttribute("aria-label", `${caption} 다시보기 열기`);
      if (canOpen) {
        row.type = "button";
        row.dataset.item = broadcastKey(item);
        row.onclick = () => open(item);
      }
      choices.append(row);
      if (focused && row.dataset.item === focused) row.focus({ preventScroll: true });
    }
  }
  function draw(now, start) {
    const days = groupByDay(start, now, context);
    const today = Math.floor((now - start) / DAY_MS);
    const counts = clips.start === start ? clips.counts : null;
    const checkingClips = clips.start !== start || !(clips.nextCheck > now);
    const confirmedDay = !checkingClips && !clips.incomplete && Number.isFinite(clips.checkedAt)
      ? Math.min(today, Math.floor((clips.checkedAt - start) / DAY_MS)) : -1;
    const emptyDayLabel = cached.incomplete || clips.incomplete ? "확인 못함" :
      cached.start !== start || clips.start !== start ? "확인 중" : "기록 없음";
    const key = JSON.stringify([start, today, days, cached.incomplete, cached.start, clips.start, counts, clips.days, clips.incomplete, checkingClips, confirmedDay]);
    if (key === signature) return;
    const inChoices = el["week-choices"].contains(document.activeElement);
    const focusedDay = inChoices ? selected : document.activeElement.closest(".week-day")?.dataset.day;
    const focusedKind = inChoices ? choiceType : document.activeElement.dataset.kind;
    const focusedItem = document.activeElement.dataset.item;
    const oldBroadcast = focusedKind === "broadcast" && focusedItem
      ? groups[focusedDay]?.find(item => broadcastKey(item) === focusedItem) : null;
    const previousStart = el["week-days"].dataset.start;
    if (previousStart !== String(start)) selected = -1;
    signature = key;
    groups = days;
    el["week-heading"].textContent = previous ? "지난주 방송 발자국" : "이번 주 방송 발자국";
    el["week-previous"].setAttribute("aria-pressed", String(previous));
    el["week-current"].setAttribute("aria-pressed", String(!previous));
    el["week-range"].textContent = `${formatWeekdayDate(start)} - ${formatWeekdayDate(start + 6 * DAY_MS)}`;
    el["week-days"].dataset.start = start;
    const nodes = days.map((items, index) => {
      const state = ["live","replay","waiting","unavailable","unknown","checking"].find(type => items.some(item => item.state === type));
      const multiple = hasChoices(items);
      const action = multiple || state === "live" || state === "replay";
      const count = counts?.[index] ?? 0;
      const cell = document.createElement("div");
      cell.className = "week-day";
      cell.dataset.day = index;
      cell.dataset.state = state || "empty";
      if (index === today) cell.setAttribute("aria-current", "date");
      const name = document.createElement("span"), paw = document.createElement("span"), label = document.createElement("small");
      name.textContent = weekdays[index];
      name.className = "week-weekday";
      paw.setAttribute("aria-hidden", "true");
      if (state) {
        paw.className = "week-paw";
        if (state === "replay") paw.style.setProperty("--angle", tilt(Math.round(start / DAY_MS) + index) + "deg");
      } else if (!count) paw.textContent = index <= today ? "—" : "·";
      label.textContent = state ? labels[state] : index > today || count ? "" : emptyDayLabel;
      const broadcast = document.createElement(action ? "button" : "div");
      broadcast.className = "week-broadcast";
      broadcast.dataset.kind = "broadcast";
      broadcast.append(paw, label);
      cell.append(name, broadcast);
      if (count) {
        const singleClip = count === 1 && clips.days?.[index]?.length === 1 ? clips.days[index][0] : null;
        const badge = document.createElement(singleClip ? "a" : "button");
        badge.className = "week-clip-count";
        if (singleClip) {
          badge.href = "https://chzzk.naver.com/clips/" + encodeURIComponent(singleClip.id);
          badge.target = "_blank";
          badge.rel = "noopener noreferrer";
        } else badge.type = "button";
        badge.dataset.kind = "clips";
        const clipLabel = `${weekdays[index]}요일에 만든 클립 ${count}개 보기`;
        badge.setAttribute("aria-label", clipLabel);
        badge.title = datedListTitle(start + index * DAY_MS, "클립", count);
        if (!singleClip) {
          badge.setAttribute("aria-controls", "week-dialog");
          badge.setAttribute("aria-haspopup", "dialog");
          badge.setAttribute("aria-expanded", String(selected === index && choiceType === "clips"));
          badge.onclick = event => toggleChoices(index, "clips", event);
        }
        const film = document.createElement("span");
        film.className = "week-film";
        film.dataset.tier = count < 3 ? "mint" : count < 6 ? "teal" : "gold";
        film.setAttribute("aria-hidden", "true");
        badge.append(film, `×${count}`);
        cell.append(badge);
      } else if (index <= confirmedDay && counts?.[index] === 0) {
        const zero = document.createElement("span");
        zero.className = "week-clip-zero";
        zero.setAttribute("role", "img");
        zero.setAttribute("aria-label", weekdays[index] + "요일에 만든 클립 0개");
        zero.title = datedListTitle(start + index * DAY_MS, "클립", 0);
        const film = document.createElement("span");
        film.className = "week-film";
        film.setAttribute("aria-hidden", "true");
        zero.append(film, "×0");
        cell.append(zero);
      }
      if (action) {
        broadcast.type = "button";
        if (!multiple) broadcast.dataset.item = broadcastKey(items[0]);
        const description = multiple ? (items.length > 1 ? "방송 목록" : (items[0].title || "방송") + " 분할 다시보기") :
          [items[0].title, timeFormat.format(items[0].openedAt), labels[state]].filter(Boolean).join(" · ");
        broadcast.title = multiple || state === "replay" ? broadcastListTitle(start + index * DAY_MS, items) : description;
        broadcast.setAttribute("aria-label", weekdays[index] + "요일 " + description + " 열기");
        if (multiple) {
          broadcast.setAttribute("aria-controls", "week-dialog");
          broadcast.setAttribute("aria-haspopup", "dialog");
          broadcast.setAttribute("aria-expanded", String(selected === index && choiceType === "broadcast"));
        }
        broadcast.onclick = event => {
          if (!multiple) return open(items[0]);
          toggleChoices(index, "broadcast", event);
        };
      }
      return cell;
    });
    el["week-days"].replaceChildren(...nodes);
    if (choiceType === "clips" ? !counts?.[selected] : !days[selected] || !hasChoices(days[selected])) selected = -1;
    renderChoices();
    if (focusedDay !== undefined && !el["week-choices"].contains(document.activeElement)) {
      const cell = nodes[focusedDay];
      let target = cell?.querySelector(focusedKind === "clips" ? ".week-clip-count" : "button.week-broadcast");
      if (previousStart !== String(start)) {
        target = null;
      } else if (inChoices && focusedItem?.startsWith("video-") && !el["week-choices"].querySelector(`button:enabled[data-item="${focusedItem}"]`)) {
        target = null;
      } else if (oldBroadcast) {
        const remaining = days[focusedDay]?.find(item =>
          (item.state === "live" || item.state === "replay") &&
          ((broadcastKey(item) === broadcastKey(oldBroadcast)) ||
           (oldBroadcast.videoNo && item.videoNo === oldBroadcast.videoNo)));
        if (!remaining) target = null;
        else if (inChoices && selected === Number(focusedDay)) {
          target = el["week-choices"].querySelector(`button[data-item="${broadcastKey(remaining)}"]`);
        }
      } else if (focusedKind === "clips" && !target) {
        target = days[focusedDay]?.some(item => item.state === "replay")
          ? cell.querySelector("button.week-broadcast") : el["week-heading"];
      }
      if (dialog.open && !el["week-choices"].contains(target)) closeChoices();
      (target ?? el["week-heading"]).focus();
    }
    el["week-note"].hidden = !days.some(items => items.some(item => item.state === "waiting"));
    const clipStatus = el["week-clip-status"];
    clipStatus.textContent = checkingClips ? "클립을 확인하고 있어요." :
      clips.incomplete ? (counts ? "클립을 갱신하지 못해 마지막으로 확인한 수를 표시해요." : "클립 수를 확인하지 못했어요. 잠시 후 다시 확인해요.") : "";
    clipStatus.hidden = !clipStatus.textContent;
    message(cached.start !== start ? "다시보기를 확인하고 있어요." :
      cached.incomplete ? "일부 다시보기를 확인하지 못했어요. 잠시 후 다시 확인해요." : "");
  }
  function update(visible, state) {
    active = visible;
    context = state;
    clearTimeout(refreshTimer);
    if (!visible) { selected = -1; signature = undefined; renderChoices(); return; }
    const now = Date.now(), current = seoulWeekStart(now);
    const start = current - (previous ? 7 * DAY_MS : 0);
    for (const date of weeks.keys()) if (date < current - 7 * DAY_MS) weeks.delete(date);
    if (!weeks.has(start)) weeks.set(start, {});
    const week = weeks.get(start);
    cached = week["week-replays"] ?? {};
    clips = week["week-clips"] ?? {};
    draw(now, start);
    let next = current + 7 * DAY_MS;
    for (const [type, data] of [["week-replays", cached], ["week-clips", clips]]) {
      const key = type + start;
      if (pending.has(key)) continue;
      const savedIds = type === "week-replays" ? [...state.entries.map(item => item.replayVideoNo), ...state.broadcasts.map(item => item.videoNo)].filter(id => replayUrl(id)) : [];
      if (data.start === start && data.nextCheck > now && savedIds.every(id => Object.hasOwn(data.availability ?? {}, id))) {
        next = Math.min(next, data.nextCheck);
        continue;
      }
      pending.add(key);
      chrome.runtime.sendMessage({ type, previous }).then(result => {
        if (!Number.isFinite(result?.nextCheck) || result.start !== start) throw new Error();
        if (type === "week-replays") applyReplayChecks(result.availability ?? {}, result.checkedAt, result.times);
        week[type] = result;
      }).catch(() => {
        const fallback = { start, incomplete: true, nextCheck: Date.now() + 60_000 };
        week[type] = type === "week-replays" ? { ...fallback, videos: data.videos ?? [], availability: Object.fromEntries(savedIds.map(id => [id, "unknown"])) } :
          { ...fallback, counts: data.counts ?? null, days: data.days ?? null };
      }).finally(() => { pending.delete(key); update(active, context); });
    }
    refreshTimer = setTimeout(() => update(active, context), next - now + 20);
  }
  return update;
}
