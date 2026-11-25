import {
  ACTIVITY_LIMIT,
  BROADCAST_MODES,
  CHANNEL_ID,
  CHECK_ALARMS,
  COMMUNITY_ACCESS,
  COMMUNITY_API_URL,
  COMMUNITY_INTERVALS,
  COMMUNITY_URL,
  DEFAULT_SETTINGS,
  DAY_MS,
  DISCORD_CHANNELS,
  discordTime,
  COMMUNITY_RETRY_ALARM,
  discordPostUrl,
  INTERVALS,
  LIVE_DETAIL_URL,
  LIVE_URL,
  NOTIFICATION_ACCESS,
  REPLAY_LIST_API_URL,
  REPLAY_LIST_URL,
  VIDEO_DETAIL_API_URL,
  RESUME_ALARM,
  RECOVERY_ALARM,
  PAUSE_MAX_MINUTES,
  compareActivity,
  replayUrl,
  monitoringActive,
  noticeEnabled,
  normalizeSettings,
  seoulWeekStart,
} from "./config.js";

const { live: LIVE_ALARM, community: COMMUNITY_ALARM } = CHECK_ALARMS;
const NOTIFICATION_RETRY_ALARM = "retry-notifications";
const DISCORD_SOURCES = Object.keys(DISCORD_CHANNELS);
const NEWS_SOURCES = ["community", ...DISCORD_SOURCES];
const REQUEST_TIMEOUT_MS = 8_000;
const MAX_BACKOFF_MS = 15 * 60_000;
const NOTIFICATION_RETRY_MS = 30_000;
const NOTIFICATION_LIFETIME_MS = 24 * 60 * 60_000;
const REPLAY_LOOKUP_TIMEOUT_MS = 5_000;
const REPLAY_PAGE_SIZE = 20;
const REPLAY_PAGE_LIMIT = 3;
const REPLAY_DETAIL_CONCURRENCY = 4;
const TAB_NAVIGATION_TIMEOUT_MS = 3_000;
const REPLAY_LIST_TABS_KEY = "replayListTabIds";
const TEST_NOTIFICATION_ID = "test-notification";
const LIVE_TAB_RETRY_ID = "live-tab-retry";
const MISSED_TAB_RETRY_PREFIX = "missed-tab-retry-";
const notificationText = {
  missed: ["놓친 유설Seol 방송", "누르면 다시보기를 찾아요. 없으면 영상 목록을 열어요."],
  replayRetry: ["다시보기 탭을 불러오는 중입니다", "로딩이나 탭 이동이 끝나면 이 알림을 눌러 다시 시도해 주세요."],
  post: ["유설Seol 새 커뮤니티 글", "알림을 클릭하면 게시글이 열립니다."],
};

// Fetch each source independently. Serialize tab actions separately from settings
// and reports so Chrome navigation can wait without holding up checks.
let queue = Promise.resolve();
let tabQueue = Promise.resolve();
let queuedTabTasks = 0;
const pendingChecks = new Map();
const pendingMissedOpens = new Map();
let notificationRetry;
let pendingLiveOpening;
const pendingNavigations = new Map();
let popupBroadcasts = new AbortController();

function cancelPopupBroadcasts() {
  popupBroadcasts.abort();
  popupBroadcasts = new AbortController();
}

function broadcastStartText(live, activity, openedTab) {
  const record = activity.find(item => item.id === `live-${live.liveId}`);
  const title = live.title?.trim() || record?.title || "제목 미제공";
  const openedAt = Number.isSafeInteger(live.openedAt) ? live.openedAt : record?.openedAt;
  const time = Number.isSafeInteger(openedAt) && openedAt > 0
    ? new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(openedAt) + " 시작 (한국시간)"
    : "시작 시각 미제공";
  const action = openedTab === true ? "방송을 백그라운드 탭에 열었어요." :
    openedTab === false ? "이미 열린 방송 탭이 있어요." : "누르면 방송을 봐요. 종료 후에는 다시보기를 찾아요.";
  return [`유설Seol 방송 시작 · ${title}`, `${time}\n${action}`];
}

function shareNavigation(key, task) {
  if (pendingNavigations.has(key)) return pendingNavigations.get(key);
  const action = Promise.resolve().then(task);
  pendingNavigations.set(key, action);
  const finish = () => { if (pendingNavigations.get(key) === action) pendingNavigations.delete(key); };
  void action.then(finish, finish);
  return action;
}

function enqueue(task) {
  const result = queue.then(task);
  queue = result.catch((error) => console.error("유설Seol 꼬순내 추적기:", error));
  return result;
}

function enqueueTab(task) {
  queuedTabTasks++;
  const result = tabQueue.then(task).finally(() => { queuedTabTasks--; });
  tabQueue = result.catch(() => {});
  return result;
}

async function syncAlarm(name, enabled, intervalSeconds) {
  const alarm = await chrome.alarms.get(name);
  if (!enabled) {
    if (alarm) await chrome.alarms.clear(name);
    return;
  }

  const periodInMinutes = intervalSeconds / 60;
  if (alarm?.periodInMinutes !== periodInMinutes) {
    await chrome.alarms.create(name, { periodInMinutes });
  }
}

async function syncAlarms(settings) {
  const active = monitoringActive(settings);
  const communityEnabled = active && await chrome.permissions.contains(COMMUNITY_ACCESS);
  const updates = await Promise.allSettled([
    syncAlarm(LIVE_ALARM, active, settings.intervalSeconds),
    syncAlarm(COMMUNITY_ALARM, communityEnabled, settings.communityIntervalSeconds),
  ]);
  // A failed parallel update must settle before its caller restores old alarms.
  const failed = updates.find((result) => result.status === "rejected");
  if (failed) throw failed.reason;
  if (!communityEnabled) await chrome.alarms.clear(COMMUNITY_RETRY_ALARM);
  const resume = await chrome.alarms.get(RESUME_ALARM);
  if (settings.enabled && settings.pausedUntil) {
    if (!resume || Math.abs(resume.scheduledTime - settings.pausedUntil) > 1) {
      await chrome.alarms.create(RESUME_ALARM, { when: settings.pausedUntil });
    }
  } else if (resume) await chrome.alarms.clear(RESUME_ALARM);
}

async function getState() {
  const state = await chrome.storage.local.get({
    settings: {},
    report: {},
    communityReport: {},
    announcementsReport: {},
    schoolReport: {},
    pendingNotifications: {},
    notificationRetrySchedule: null,
    activity: [],
    weekBroadcasts: [],
    historySeeded: {},
  });
  return { ...state, settings: normalizeSettings(state.settings) };
}

class StatusError extends Error {
  constructor(message, retryAfterMs = 0, connectionError = false) {
    super(message);
    this.retryAfterMs = retryAfterMs;
    this.connectionError = connectionError;
  }
}

function retryAfterMs(header) {
  if (!header) return 0;
  if (/^\d+$/.test(header)) {
    const delay = Number(header) * 1_000;
    return delay + Date.now() <= 8.64e15 ? delay : 0;
  }
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : 0;
}

async function fetchJson(url, label, checkSignal) {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const signal = AbortSignal.any([checkSignal, timeout]);
  try {
    const response = await fetch(url, {
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
      signal,
    });
    if (!response.ok) {
      const message = response.status === 429 ? `${label} 요청 횟수가 제한됐습니다.` :
        `${label} 조회에 실패했습니다 (HTTP ${response.status}).`;
      const error = new StatusError(message, retryAfterMs(response.headers.get("Retry-After")));
      error.httpStatus = response.status;
      throw error;
    }

    return await response.json();
  } catch (error) {
    checkSignal.throwIfAborted();
    if (error instanceof StatusError) throw error;
    if (timeout.aborted) throw new StatusError(`${label} 응답 시간이 초과됐습니다.`, 0, true);
    if (error instanceof SyntaxError) throw new StatusError(`${label} 응답을 읽을 수 없습니다.`);
    throw new StatusError(`${label}에 연결할 수 없습니다. 네트워크와 사이트 접근 권한을 확인해 주세요.`, 0, true);
  }
}

function liveTimestamp(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) return NaN;
  return Date.parse(value.replace(" ", "T") + "+09:00");
}

async function fetchLiveStatus(signal) {
  const body = await fetchJson(LIVE_DETAIL_URL, "치지직", signal);
  const live = body?.content;
  if (body?.code !== 200 || live?.channel?.channelId !== CHANNEL_ID) {
    throw new StatusError("치지직 응답에서 대상 채널을 확인할 수 없습니다.");
  }
  const liveId = Number.isSafeInteger(live.liveId) && live.liveId > 0 ? live.liveId : null;
  const title = typeof live.liveTitle === "string" ? live.liveTitle.trim().slice(0, 160) : "";
  if (live.status === "CLOSE") {
    return {
      status: "offline",
      liveId,
      title,
      openedAt: liveTimestamp(live.openDate),
      closedAt: liveTimestamp(live.closeDate),
    };
  }
  if (live.status === "OPEN" && liveId) return { status: "live", liveId, title, openedAt: liveTimestamp(live.openDate) };
  throw new StatusError("치지직 방송 상태 또는 방송 ID를 읽을 수 없습니다.");
}

function failureReport(previous, error, intervalSeconds) {
  const checkedAt = Date.now();
  const failureCount = Math.min((previous.failureCount ?? 0) + 1, 10);
  const baseDelay = error.connectionError ? Math.min(30_000, intervalSeconds * 1_000) : intervalSeconds * 1_000;
  const backoff = Math.min(MAX_BACKOFF_MS, baseDelay * 2 ** (failureCount - 1));
  return {
    ...previous,
    checkedAt,
    error: error.message,
    failureCount,
    retryAt: checkedAt + Math.max(backoff, error.retryAfterMs ?? 0),
  };
}

async function notify(id, title, message) {
  try {
    return await chrome.notifications?.create(id, {
      type: "basic",
      iconUrl: chrome.runtime.getURL("notification.png"),
      title,
      message,
    });
  } catch (error) {
    console.warn("Chrome 알림을 표시할 수 없습니다:", error);
  }
}

function recordActivity(activity, entries) {
  const incoming = entries.filter(entry => !entry.historical).map(entry => {
    const previous = activity.find(row => row.id === entry.id);
    if (!previous || previous.historical || entry.kind === "failure") return entry;
    const merged = { ...previous, ...entry, at: previous.at };
    // A second sighting cannot supply the first discovery time of a legacy Discord post.
    if (previous.discoveredAt == null) delete merged.discoveredAt;
    else merged.discoveredAt = previous.discoveredAt;
    return merged;
  });
  const ids = new Set(incoming.map(entry => entry.id));
  const rows = [...incoming, ...activity.filter(entry => !ids.has(entry.id))];
  // Backfilled history can fill empty slots, but never replace an existing row.
  const known = new Set(rows.map(entry => entry.id));
  for (const entry of entries.filter(item => item.historical).sort(compareActivity)) {
    if (rows.length >= ACTIVITY_LIMIT) break;
    if (!known.has(entry.id)) {
      rows.push(entry);
      known.add(entry.id);
    }
  }
  return rows.sort(compareActivity).slice(0, ACTIVITY_LIMIT);
}

function isBroadcastStart(entry) {
  return entry.kind === "live" || entry.kind === "liveOnly";
}

function notificationCreatedAt(id, entry, activity) {
  return entry.createdAt ?? activity.find((item) => item.id === id)?.at ??
    activity.find((item) => item.id === `failure-${id}`)?.at ?? entry.retryAt;
}

async function syncNotificationRetryAlarm(state) {
  const entries = Object.entries(state.pendingNotifications);
  const retries = [];
  const now = Date.now();
  let dueAt = Infinity;
  if (entries.length && monitoringActive(state.settings) && await chrome.permissions.contains(NOTIFICATION_ACCESS)) {
    const communityAllowed = entries.some(([, entry]) => ["post", "discord"].includes(entry.kind)) &&
      await chrome.permissions.contains(COMMUNITY_ACCESS);
    for (const [id, entry] of entries) {
      if (!noticeEnabled(state.settings, entry.kind)) continue;
      if (["post", "discord"].includes(entry.kind) && !communityAllowed) continue;
      const expiresAt = notificationCreatedAt(id, entry, state.activity) + NOTIFICATION_LIFETIME_MS;
      const retryAt = isBroadcastStart(entry) ? Math.max(entry.retryAt, state.report.retryAt ?? 0) : entry.retryAt;
      const deadline = Math.min(retryAt, expiresAt);
      if (Number.isFinite(deadline)) dueAt = Math.min(dueAt, deadline);
      if (expiresAt > now && retryAt < expiresAt) retries.push({ retryAt, expiresAt });
    }
  }

  const previous = state.notificationRetrySchedule;
  let alarm = await chrome.alarms.get(NOTIFICATION_RETRY_ALARM);
  if (!Number.isFinite(dueAt)) {
    if (alarm) await chrome.alarms.clear(NOTIFICATION_RETRY_ALARM);
    if (previous) await chrome.storage.local.set({ notificationRetrySchedule: null });
    return;
  }
  if (!alarm || previous?.dueAt !== dueAt) {
    await chrome.alarms.create(NOTIFICATION_RETRY_ALARM, { when: Math.max(dueAt, Date.now() + 1) });
    alarm = await chrome.alarms.get(NOTIFICATION_RETRY_ALARM);
  }
  const scheduledTime = alarm?.scheduledTime ?? dueAt;
  // The alarm can also wake the worker solely to remove expired notices.
  let nextRetryAt = Infinity;
  for (const { retryAt, expiresAt } of retries) {
    const plannedAt = Math.max(retryAt, scheduledTime);
    if (plannedAt < expiresAt) nextRetryAt = Math.min(nextRetryAt, plannedAt);
  }
  const retryAt = Number.isFinite(nextRetryAt) ? nextRetryAt : null;
  if (previous?.dueAt !== dueAt || previous.scheduledTime !== scheduledTime || previous.retryAt !== retryAt) {
    await chrome.storage.local.set({ notificationRetrySchedule: { dueAt, scheduledTime, retryAt } });
  }
}

async function deliverNotifications(source, pending, activity, live, signal, settings) {
  for (const [id, entry] of Object.entries(pending)) {
    if (signal.aborted) return activity;
    const noticeSource = entry.kind === "discord" ? entry.source : entry.kind === "post" ? "community" : "live";
    if (source !== noticeSource) continue;

    const now = Date.now();
    const failureId = `failure-${id}`;
    if (!noticeEnabled(settings, entry.kind)) {
      delete pending[id];
      activity = activity.map((item) => item.id === failureId ? { ...item, outcome: "cancelled", endReason: "type-disabled" } : item);
      await chrome.storage.local.set({ pendingNotifications: pending, activity });
      continue;
    }
    const isStart = isBroadcastStart(entry);
    const createdAt = notificationCreatedAt(id, entry, activity);
    const expired = now - createdAt >= NOTIFICATION_LIFETIME_MS;
    if (expired || (isStart && live && (live.status !== "live" || !id.endsWith(`-${live.liveId}`)))) {
      delete pending[id];
      const endReason = expired ? "deadline" : "broadcast-ended";
      activity = activity.map((item) => item.id === failureId ? { ...item, outcome: "expired", endReason } : item);
      await chrome.storage.local.set({ pendingNotifications: pending, activity });
      continue;
    }
    // Never announce a start if this check couldn't verify the broadcast is still live.
    if (entry.retryAt > now || (isStart && !live) || !chrome.notifications) continue;
    if (NEWS_SOURCES.includes(source) && !await chrome.permissions.contains(COMMUNITY_ACCESS)) return activity;

    const allowed = await chrome.notifications.getPermissionLevel().then(
      (level) => level === "granted", () => null,
    );
    if (signal.aborted) return activity;
    const noticeId = entry.kind === "missed" && Number.isSafeInteger(entry.openedAt) ? `${id}-${entry.openedAt}` : id;
    const text = entry.kind === "discord"
      ? [`유설 디스코드 · ${DISCORD_CHANNELS[source].name}`, entry.count > 1
        ? `새 글 ${entry.count}건 · 누르면 읽을 글을 선택할 수 있어요.` : "새 글이 올라왔어요. 누르면 디스코드에서 원문을 열어요."]
      : isStart ? broadcastStartText(live, activity, entry.openedTab) : notificationText[entry.kind];
    const sent = allowed && await notify(noticeId, ...text);

    if (sent) {
      delete pending[id];
      activity = activity.map((item) => item.id === failureId ? { ...item, outcome: "sent" } : item);
    } else {
      const delay = Math.min(MAX_BACKOFF_MS, NOTIFICATION_RETRY_MS * 2 ** Math.min(10, entry.failures));
      pending[id] = {
        ...entry,
        createdAt,
        failures: entry.failures + 1,
        retryAt: Date.now() + delay,
      };
      activity = recordActivity(activity, [{
        id: failureId, kind: "failure", at: Date.now(), noticeKind: entry.kind,
        outcome: allowed === false ? "blocked" : "retry",
      }]);
    }
    // Record each outcome before attempting the next alert.
    await chrome.storage.local.set({ pendingNotifications: pending, activity });
  }
  return activity;
}

async function retryNotifications() {
  if (notificationRetry) return;
  notificationRetry = new AbortController();
  const { signal } = notificationRetry;
  try {
    const verifyLive = await enqueue(async () => {
      const { settings, report, pendingNotifications, activity } = await getState();
      if (!monitoringActive(settings) || !await chrome.permissions.contains(NOTIFICATION_ACCESS) || signal.aborted) return false;

      // Already detected posts and ended broadcasts only need to be delivered again.
      let updated = await deliverNotifications("live", pendingNotifications, activity, undefined, signal, settings);
      if (await chrome.permissions.contains(COMMUNITY_ACCESS)) {
        updated = await deliverNotifications("community", pendingNotifications, updated, undefined, signal, settings);
        for (const source of DISCORD_SOURCES) updated = await deliverNotifications(source, pendingNotifications, updated, undefined, signal, settings);
      }
      const now = Date.now();
      return !signal.aborted && now >= (report.retryAt ?? 0) &&
        Object.values(pendingNotifications).some((entry) => isBroadcastStart(entry) && entry.retryAt <= now);
    });
    if (verifyLive && !signal.aborted) await requestSource("live");
  } finally {
    notificationRetry = undefined;
    await enqueue(async () => syncNotificationRetryAlarm(await getState()));
  }
}

async function testNotification() {
  const permissionHelp = { ok: false, message: "팝업 상단에서 ‘알림 허용’을 눌러 주세요." };
  if (!await chrome.permissions.contains(NOTIFICATION_ACCESS) || !chrome.notifications) {
    return permissionHelp;
  }
  let level;
  try {
    level = await chrome.notifications.getPermissionLevel();
  } catch {
    if (!await chrome.permissions.contains(NOTIFICATION_ACCESS)) return permissionHelp;
    return { ok: false, message: "알림 상태를 확인하지 못했습니다. 잠시 후 다시 시도해 주세요." };
  }
  if (level === "denied") {
    return { ok: false, message: "Chrome에서 이 확장 프로그램의 알림을 허용해 주세요." };
  }
  const id = await notify(
    TEST_NOTIFICATION_ID + "-" + crypto.randomUUID(),
    "유설Seol 꼬순내 추적기 테스트 알림",
    `${new Date().toLocaleTimeString("ko-KR", {hour12:false})} 발송 · 클릭하면 유설Seol 라이브 탭을 엽니다.`,
  );
  if (!id && !await chrome.permissions.contains(NOTIFICATION_ACCESS)) return permissionHelp;
  return id ? { ok: true } : { ok: false, message: "테스트 알림을 만들 수 없습니다. 다시 시도해 주세요." };
}

function isChannelReplay(video) {
  return video?.videoType === "REPLAY" && video.channel?.channelId === CHANNEL_ID &&
    Number.isSafeInteger(video.videoNo) && video.videoNo > 0;
}

async function* replayCandidates(openedAt, signal, pageLimit = REPLAY_PAGE_LIMIT) {
  for (let page = 0; page < pageLimit; page++) {
    const url = `${REPLAY_LIST_API_URL}&page=${page}&size=${REPLAY_PAGE_SIZE}`;
    const { code, content } = await fetchJson(url, "다시보기 목록", signal);
    if (code !== 200 || !Array.isArray(content?.data)) {
      throw new StatusError("다시보기 목록 응답을 읽을 수 없습니다.");
    }
    for (const video of content.data) {
      if (isChannelReplay(video) && !(Number.isFinite(video.publishDateAt) && video.publishDateAt < openedAt)) {
        yield video.videoNo;
      }
    }
    const oldest = content.data.at(-1)?.publishDateAt;
    if (!content.data.length || page + 1 >= content.totalPages ||
        (Number.isFinite(oldest) && oldest < openedAt)) return;
  }
}

async function checkReplay(videoNo, signal) {
  try {
    const { code, content } = await fetchJson(`${VIDEO_DETAIL_API_URL}/${videoNo}`, "다시보기", signal);
    if (code === 404 || code === 410) return { status: "unavailable" };
    if (code !== 200 || content?.videoNo !== videoNo) return { status: "unknown" };
    if (content.exposure === false || content.blindType) return { status: "unavailable" };
    if (content.exposure !== true || !isChannelReplay(content)) return { status: "unknown" };
    return { status: "public", video: content };
  } catch (error) {
    return { status: [404, 410].includes(error.httpStatus) ? "unavailable" : "unknown" };
  }
}

function replayLiveId(video) {
  let id = video.liveId;
  if (!id && video.liveRewindPlaybackJson) {
    try { id = JSON.parse(video.liveRewindPlaybackJson)?.meta?.liveId; } catch {}
  }
  return Number.isSafeInteger(Number(id)) && Number(id) > 0 ? Number(id) : null;
}

async function rememberWeekReplays(videos, availability, previousVideos) {
  const { activity, weekBroadcasts } = await chrome.storage.local.get({ activity: [], weekBroadcasts: [] });
  const earliest = seoulWeekStart() - 7 * DAY_MS;
  const catalog = new Map();
  const slotHistory = new Map();
  const starts = new Map();
  for (const row of [...weekBroadcasts, ...activity]) {
    const id = row.liveId || Number(/^(?:live|missed)-(\d+)$/.exec(row.id)?.[1]);
    if (id && row.openedAt) starts.set(id, Math.min(starts.get(id) ?? Infinity, row.openedAt));
    if (row.replayPartSlots?.length) {
      const source = row.replayPartSlots[0].sourceLiveId;
      if (row.replayPartSlots.length > (slotHistory.get(source)?.length ?? 0)) {
        slotHistory.set(source, row.replayPartSlots);
      }
    }
    for (const part of row.replayParts ?? []) catalog.set(part.videoNo, { ...part });
  }
  for (const part of [...previousVideos, ...videos]) {
    catalog.set(part.videoNo, { ...part, sourceLiveId: part.sourceLiveId || catalog.get(part.videoNo)?.sourceLiveId || null });
  }
  const groups = new Map(), byVideo = new Map();
  for (const part of catalog.values()) {
    const key = part.sourceLiveId ? "live-" + part.sourceLiveId : "video-" + part.videoNo;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(part);
    byVideo.set(part.videoNo, groups.get(key));
  }
  for (const parts of groups.values()) {
    parts.sort((a,b) => a.openedAt - b.openedAt || a.videoNo - b.videoNo);
    const source = parts[0].sourceLiveId;
    if (!source) continue;
    const slots = [...(slotHistory.get(source) ?? [])];
    if (!slots.length && (parts.length < 2 || starts.get(source) < parts[0].openedAt)) continue;
    for (const part of parts) {
      let index = slots.findIndex(slot => slot.videoNo === part.videoNo);
      if (index < 0) {
        // A replacement ID can inherit a slot only when the time identifies it uniquely.
        const sameTime = slots.filter(slot => slot.openedAt === part.openedAt);
        const samePublic = parts.filter(p => p.openedAt === part.openedAt && availability[p.videoNo] === "public");
        if (sameTime.length === 1 && availability[sameTime[0].videoNo] === "unavailable" &&
            samePublic.length === 1 && samePublic[0] === part) {
          index = slots.indexOf(sameTime[0]);
        } else if (!slots.length || part.openedAt > slots.at(-1).openedAt ||
            (part.openedAt === slots.at(-1).openedAt && samePublic.length > 1)) {
          index = slots.length;
        } else continue;
        slots[index] = { sourceLiveId: source, videoNo: part.videoNo, openedAt: part.openedAt };
      }
    }
    if (slots.length > 1) {
      slotHistory.set(source, slots);
      for (const part of parts) {
        const index = slots.findIndex(slot => slot.videoNo === part.videoNo);
        if (index >= 0) part.partNumber = index + 1;
        else delete part.partNumber;
      }
    }
  }

  function resolve(row, id, field, originalStart) {
    const saved = byVideo.get(row[field]);
    const compatible = parts => !id || !parts[0].sourceLiveId || parts[0].sourceLiveId === id;
    let parts = groups.get("live-" + id);
    if (!parts && saved && compatible(saved) && saved.some(p => availability[p.videoNo] !== "unavailable")) parts = saved;
    if (!parts && originalStart) {
      const matches = [...groups.values()].filter(group => compatible(group) && group.some(p =>
        p.openedAt === originalStart && availability[p.videoNo] === "public"));
      if (matches.length === 1) parts = matches[0];
    }
    if (!parts && saved && compatible(saved)) parts = saved;
    if (!parts) {
      if (!saved || compatible(saved)) return row;
      return { ...row, [field]: null, replayParts: [], replayPartSlots: [], replayTitle: null, replayOpenedAt: null };
    }
    const active = parts.filter(p => availability[p.videoNo] !== "unavailable");
    const lead = active.find(p => availability[p.videoNo] === "public") ?? active[0] ?? parts[0];
    // Retain the first verified start even when the first part later disappears.
    const replayOpenedAt = Math.min(parts[0].openedAt, row.replayOpenedAt || Infinity,
      id && originalStart ? originalStart : Infinity);
    return { ...row, [field]: lead.videoNo, replayOpenedAt, replayTitle: lead.title,
      replayPartSlots: slotHistory.get(lead.sourceLiveId) ?? [],
      replayParts: active.length ? active : [lead], ...(availability[lead.videoNo] === "public" && field === "replayVideoNo" ? { replayFallback: null } : {}) };
  }
  const broadcasts = weekBroadcasts.filter(row => (row.replayOpenedAt ?? row.openedAt) >= earliest)
    .map(row => resolve(row, row.liveId, "videoNo", row.openedAt));
  const entries = activity.map(entry => {
    if (!["live","missed","archive"].includes(entry.kind)) return entry;
    const id = entry.kind === "archive" ? null : Number(entry.id.split("-")[1]);
    const tracked = id && broadcasts.find(row => row.liveId === id);
    const row = !entry.replayVideoNo && tracked?.videoNo ? { ...entry, replayVideoNo: tracked.videoNo } : entry;
    return resolve(row, id, "replayVideoNo", entry.openedAt ?? tracked?.openedAt ?? (entry.kind === "archive" ? entry.at : null));
  });
  const covered = new Set(broadcasts.map(row => row.videoNo).filter(Boolean));
  function remember(row) {
    const at = row.replayOpenedAt ?? row.openedAt;
    if (!replayUrl(row.videoNo) || covered.has(row.videoNo) || !(at >= earliest && at <= Date.now())) return;
    broadcasts.push(row);
    covered.add(row.videoNo);
  }
  for (const entry of entries) if (entry.kind === "archive") remember({
    openedAt: entry.openedAt ?? entry.at, videoNo: entry.replayVideoNo, title: entry.title,
    replayOpenedAt: entry.replayOpenedAt, replayParts: entry.replayParts, replayTitle: entry.replayTitle, archiveKey: entry.id, ended: true });
  for (const parts of groups.values()) {
    const first = parts[0];
    remember(resolve({ videoNo: first.videoNo, openedAt: first.openedAt, title: first.title, archiveKey: "archive-" + first.videoNo, ended: true }, null, "videoNo", first.openedAt));
  }
  const changes = {};
  if (JSON.stringify(entries) !== JSON.stringify(activity)) changes.activity = entries;
  if (JSON.stringify(broadcasts) !== JSON.stringify(weekBroadcasts)) changes.weekBroadcasts = broadcasts;
  if (Object.keys(changes).length) await chrome.storage.local.set(changes);
}

async function readWeekReplays(start, cacheKey) {
  const otherKey = cacheKey === "weekReplayCache" ? "weekReplayCachePrevious" : "weekReplayCache";
  const { [cacheKey]: cached, [otherKey]: other } = await chrome.storage.session.get([cacheKey, otherKey]);
  const checkedAt = Date.now();
  let cacheDeadline = cached?.nextCheck ?? 0;
  for (const [id, time] of Object.entries(cached?.times ?? {})) {
    if (other?.availability?.[id] === "unknown" && other.times?.[id] > time) {
      cacheDeadline = Math.min(cacheDeadline, other.nextCheck);
    }
  }
  const warm = cached?.catalogVersion === 2 && cached.start === start && cached.times && checkedAt < cacheDeadline;
  const availability = warm ? { ...cached.availability } : {};
  const times = warm ? { ...cached.times } : {};
  let incomplete = warm ? cached.incomplete : false;
  // Both weeks check saved video IDs. Reopening the popup must use the latest
  // observation without skipping discovery of a new ID in the requested week.
  if (warm && other?.times) {
    for (const id of Object.keys(availability)) {
      if (!(other.times[id] > times[id] || (other.times[id] === times[id] && other.availability[id] === "unavailable"))) continue;
      availability[id] = other.availability[id];
      times[id] = other.times[id];
      incomplete ||= availability[id] === "unknown";
    }
  }
  const signal = AbortSignal.timeout(15_000);
  // Saved IDs may belong to older activity or have disappeared from the listing.
  const { activity, weekBroadcasts } = await getState();
  const historyFloor = seoulWeekStart() - 7 * DAY_MS;
  const unresolved = activity.filter(row => ["live","archive","missed"].includes(row.kind) && !row.replayTitle)
    .map(row => row.openedAt ?? row.at).filter(at => Number.isFinite(at) && at >= historyFloor);
  const lookupStart = Math.min(start, ...unresolved);
  const savedIds = new Set([...activity.map(item => item.replayVideoNo), ...weekBroadcasts.map(item => item.videoNo), ...[...activity, ...weekBroadcasts].flatMap(item => (item.replayParts ?? []).map(part => part.videoNo))].filter(id => replayUrl(id)));
  for (const row of [...activity, ...weekBroadcasts]) {
    for (const slot of row.replayPartSlots ?? []) savedIds.add(slot.videoNo);
  }
  // Another week's lookup can already have replaced an archived video's number.
  const previousVideos = cached?.start === start ? (cached.videos ?? []).filter(video => !cached.times || savedIds.has(video.videoNo)) : [];
  for (const video of previousVideos) savedIds.add(video.videoNo);
  const videos = warm ? previousVideos.filter(video => availability[video.videoNo] !== "unavailable") : [];
  const observed = [...videos];
  if (warm && [...savedIds].every(id => Object.hasOwn(availability, id))) {
    return { ...cached, videos, availability, times, incomplete, nextCheck: cacheDeadline };
  }
  async function* videoIds() {
    if (warm) {
      for (const id of savedIds) if (!Object.hasOwn(availability, id)) yield id;
      return;
    }
    const seen = new Set();
    try {
      for await (const id of replayCandidates(lookupStart, signal, Infinity)) {
        if (!seen.has(id)) { seen.add(id); yield id; }
      }
    } catch { incomplete = true; }
    for (const id of savedIds) if (!seen.has(id)) yield id;
  }
  const candidates = videoIds();
  async function collect() {
    for (;;) {
      const { done, value: videoNo } = await candidates.next();
      if (done) return;
      const { status, video } = await checkReplay(videoNo, signal);
      availability[videoNo] = status;
      times[videoNo] = checkedAt;
      if (status === "unknown") incomplete = true;
      if (video) {
        const openedAt = liveTimestamp(video.liveOpenDate);
        if (Number.isFinite(openedAt) && openedAt > 0 && openedAt <= Date.now()) {
          const record = { openedAt, videoNo, sourceLiveId: replayLiveId(video), title: String(video.videoTitle ?? "").slice(0, 160) };
          observed.push(record);
          if (openedAt >= start && openedAt < start + 7 * DAY_MS) videos.push(record);
        }
      }
    }
  }
  const workers = await Promise.allSettled(Array.from({ length: REPLAY_DETAIL_CONCURRENCY }, collect));
  incomplete ||= workers.some(result => result.status === "rejected");
  if (incomplete && cached?.start === start) {
    for (const old of previousVideos) if (availability[old.videoNo] !== "unavailable" && !videos.some(video => video.videoNo === old.videoNo)) {
      videos.push(old);
      availability[old.videoNo] ??= "unknown";
    }
  }
  await enqueue(() => rememberWeekReplays(observed, availability, previousVideos));
  const nextCheck = Math.min(warm ? cacheDeadline : Infinity, Date.now() + (incomplete ? 60_000 : 300_000));
  const result = { catalogVersion: 2, start, videos, availability, times, checkedAt: warm ? cached.checkedAt : checkedAt, incomplete, nextCheck };
  await chrome.storage.session.set({ [cacheKey]: result });
  return result;
}

async function readWeekClips(start, cacheKey) {
  const { [cacheKey]: cached } = await chrome.storage.session.get(cacheKey);
  const previous = cached?.start === start ? cached : null;
  const checkedAt = Date.now();
  if (previous && Object.hasOwn(previous, "days") && (previous.incomplete || Number.isFinite(previous.checkedAt)) && previous.nextCheck > checkedAt) return previous;
  const days = Array.from({ length: 7 }, () => []);
  const ids = new Set();
  const cursors = new Set();
  const signal = AbortSignal.timeout(20_000);
  const url = new URL(`https://api.chzzk.naver.com/service/v1/channels/${CHANNEL_ID}/clips?orderType=RECENT&filterType=ALL&size=30`);
  let result;
  try {
    for (;;) {
      const { code, content } = await fetchJson(url.href, "클립 목록", signal);
      if (code !== 200 || !Array.isArray(content?.data) || !Object.hasOwn(content.page ?? {}, "next")) throw new Error();
      let beforeWeek = false;
      for (const clip of content.data) {
        const time = liveTimestamp(clip.createdDate);
        if (!Number.isFinite(time) || !clip.clipUID) throw new Error();
        if (time < start) { beforeWeek = true; continue; }
        const day = Math.floor((time - start) / DAY_MS);
        if (day >= 7 || time > Date.now() || ids.has(clip.clipUID)) continue;
        ids.add(clip.clipUID);
        days[day].push({ id: clip.clipUID, title: clip.clipTitle || "제목 없는 클립", time });
      }
      if (beforeWeek || content.page.next === null) break;
      const cursor = content.page.next?.clipUID;
      if (!cursor || cursors.has(cursor) || !content.data.length) throw new Error();
      cursors.add(cursor);
      url.searchParams.set("clipUID", cursor);
    }
    for (const day of days) day.sort((a, b) => b.time - a.time);
    result = { start, days, counts: days.map(day => day.length), checkedAt, nextCheck: Date.now() + 300_000 };
  } catch {
    result = { start, days: previous?.days ?? null, counts: previous?.counts ?? null, incomplete: true, nextCheck: Date.now() + 60_000 };
  }
  await chrome.storage.session.set({ [cacheKey]: result });
  return result;
}

const weeklyRequests = new Map();
let weekReplayRead = Promise.resolve();
function requestWeek(type, previous) {
  const start = seoulWeekStart() - (previous ? 7 * DAY_MS : 0);
  const replay = type === "week-replays";
  const cacheKey = (replay ? "weekReplayCache" : "weekClipCache") + (previous ? "Previous" : "");
  const key = type + start;
  if (!weeklyRequests.has(key)) {
    const result = replay ? weekReplayRead.then(() => readWeekReplays(start, cacheKey)) : readWeekClips(start, cacheKey);
    if (replay) weekReplayRead = result.catch(() => {});
    weeklyRequests.set(key, result.finally(() => weeklyRequests.delete(key)));
  }
  return weeklyRequests.get(key);
}

async function findReplay(openedAt, signal, liveId) {
  const remaining = new AbortController();
  const lookupSignal = AbortSignal.any([signal, remaining.signal]);
  const candidates = replayCandidates(openedAt, lookupSignal);
  let lookupFailed = false;

  async function search() {
    // Each lookup requests the next candidate independently, including across pages.
    while (!lookupSignal.aborted) {
      const { done, value: videoNo } = await candidates.next().catch(() => {
        lookupFailed = true;
        return { done: true };
      });
      if (done) break;
      const response = await fetchJson(`${VIDEO_DETAIL_API_URL}/${videoNo}`, "다시보기", lookupSignal).catch(() => null);
      const video = response?.content;
      if (response?.code !== 200 || video?.videoNo !== videoNo) {
        lookupFailed = true;
        continue;
      }
      // Channel summaries can disagree with the detailed exposure status.
      if (!isChannelReplay(video) || video.exposure !== true || video.blindType) continue;
      const start = liveTimestamp(video.liveOpenDate);
      const sourceId = replayLiveId(video);
      if (start === openedAt && (!sourceId || sourceId === liveId)) return videoNo;
      if (!Number.isFinite(start)) lookupFailed = true;
    }
    throw new Error("일치하는 공개 다시보기가 없습니다.");
  }

  try {
    const videoNo = await Promise.any(Array.from({ length: REPLAY_DETAIL_CONCURRENCY }, search));
    return { videoNo, fallback: null };
  } catch {
    return { fallback: lookupFailed || signal.aborted ? "lookup-failed" : "not-found" };
  } finally {
    remaining.abort();
  }
}

function openMissedBroadcast(liveId, openedAt, fromNotification = false, background = false, signal, windowId) {
  const key = `${liveId}-${openedAt ?? ""}-${background}-${!!signal}-${windowId}`;
  const current = pendingMissedOpens.get(key);
  if (current && !current.signal?.aborted) {
    current.fromNotification ||= fromNotification;
    return current.result;
  }
  const opening = { fromNotification, background, signal, windowId };
  opening.result = resolveMissedBroadcast(liveId, openedAt, signal)
    .then((result) => openMissedDestination(liveId, result, opening))
    .finally(() => { if (pendingMissedOpens.get(key) === opening) pendingMissedOpens.delete(key); });
  pendingMissedOpens.set(key, opening);
  return opening.result;
}

async function resolveMissedBroadcast(liveId, openedAt, navigationSignal) {
  let result = { fallback: "broadcast-unknown" };
  const timeout = AbortSignal.timeout(REPLAY_LOOKUP_TIMEOUT_MS);
  const signal = navigationSignal ? AbortSignal.any([timeout, navigationSignal]) : timeout;
  try {
    if (openedAt === undefined) {
      // Older notifications contain only the live ID.
      const live = await fetchLiveStatus(signal);
      if (live.status === "offline" && live.liveId === liveId) openedAt = live.openedAt;
    }
    if (Number.isSafeInteger(openedAt) && openedAt > 0) {
      result = await findReplay(openedAt, signal, liveId);
    }
  } catch {
    result = { fallback: "lookup-failed" };
  }
  return { ...result, openedAt };
}

async function clearMissedTabRetry(liveId) {
  const prefix = `${MISSED_TAB_RETRY_PREFIX}${liveId}`;
  const matches = id => id === prefix || id.startsWith(`${prefix}-`);
  await enqueue(async () => {
    const { pendingNotifications, activity } = await getState();
    const resolved = Object.keys(pendingNotifications).filter(matches);
    if (!resolved.length) return;
    for (const id of resolved) delete pendingNotifications[id];
    const ids = new Set(resolved.map(id => `failure-${id}`));
    await chrome.storage.local.set({ pendingNotifications, activity: activity.map(entry =>
      ids.has(entry.id) ? { ...entry, outcome: "opened" } : entry) });
    await syncNotificationRetryAlarm(await getState());
  });
  if (!chrome.notifications) return;
  try {
    const active = await chrome.notifications.getAll();
    const retries = Object.keys(active).filter(matches);
    await Promise.all(retries.map((id) => chrome.notifications.clear(id)));
  } catch (error) {
    console.warn("다시보기 재시도 알림 정리 실패:", error);
  }
}

async function openMissedDestination(liveId, result, opening) {
  let navigation;
  opening.signal?.throwIfAborted();
  const confirmedVideoNo = result.videoNo ?? null;
  const url = replayUrl(confirmedVideoNo) ?? REPLAY_LIST_URL;
  const matches = item => (item.kind === "live" || item.kind === "missed") && item.id === `${item.kind}-${liveId}`;
  // Confirmation belongs to the lookup, even if the destination tab is still loading.
  const fallbackRecords = await enqueue(async () => {
    const { activity } = await getState();
    if (!confirmedVideoNo) return new Map(activity.filter(matches).map(item => [item.id, item.replayVideoNo ?? null]));
    const changed = item => matches(item) && (item.replayVideoNo !== confirmedVideoNo || item.replayFallback);
    if (activity.some(changed)) {
      await chrome.storage.local.set({ activity: activity.map(item => changed(item) ?
        { ...item, replayVideoNo: confirmedVideoNo, replayFallback: null } : item) });
    }
  });
  // Serialize the tab lookup and open together across the popup and notification handlers.
  try {
    // A read-only check can report a loading replay while an unrelated tab action
    // is pending. The final lookup and any mutations still run together in order.
    if (queuedTabTasks) {
      const owned = url === REPLAY_LIST_URL ? await rememberedReplayLists() : undefined;
      await findDestinationTab(new URL(url), opening.signal, owned);
    }
    navigation = await enqueueTab(async () => {
      const tab = await focusOrOpenTab(url, opening.signal, undefined, opening.background, opening.windowId);
      await clearMissedTabRetry(liveId);
      return tab;
    });
  } catch (error) {
    if (opening.fromNotification && error instanceof TabNavigationPendingError) {
      const suffix = Number.isSafeInteger(result.openedAt) && result.openedAt >= 0 ? `-${result.openedAt}` : "";
      const id = `${MISSED_TAB_RETRY_PREFIX}${liveId}${suffix}`;
      if (!await notify(id, ...notificationText.replayRetry)) {
        await enqueue(async () => {
          const { pendingNotifications, activity } = await getState();
          const now = Date.now();
          pendingNotifications[id] ??= { kind: "replayRetry", createdAt: now, failures: 1, retryAt: now + NOTIFICATION_RETRY_MS };
          const failure = { id: `failure-${id}`, kind: "failure", noticeKind: "replayRetry", at: now, outcome: "retry" };
          await chrome.storage.local.set({ pendingNotifications, activity: recordActivity(activity, [failure]) });
          await syncNotificationRetryAlarm(await getState());
        });
      }
    }
    throw error;
  }
  if (!confirmedVideoNo) await enqueue(async () => {
    const { activity } = await getState();
    const changed = item => fallbackRecords.has(item.id) && (item.replayVideoNo ?? null) === fallbackRecords.get(item.id) &&
      (item.replayFallback ?? null) !== result.fallback;
    if (activity.some(changed)) {
      await chrome.storage.local.set({
        activity: activity.map(item => changed(item) ? { ...item, replayFallback: result.fallback } : item),
      });
    }
  });
  return { ...navigation, destination: result.videoNo ? "replay" : "list" };
}

let openingGroup = Promise.resolve();
const discordGroupIdPattern = /^discord-group-(?:announcements|school)-[1-9]\d{16,19}$/;

async function openGroupPicker(id) {
  const popup = "popup.html#" + id;
  const win = await chrome.windows.getLastFocused({ windowTypes: ["normal"] }).catch(() => null);
  if (win) {
    if (win.state === "minimized") await chrome.windows.update(win.id, { state: "normal" });
    await chrome.windows.update(win.id, { focused: true });
    const key = "pendingNewsGroup:" + win.id;
    await chrome.storage.session.set({ [key]: id });
    try {
      const contexts = await chrome.runtime.getContexts({ contextTypes: ["POPUP"], windowIds: [win.id] });
      if (!contexts.length) await chrome.action.openPopup({ windowId: win.id });
      // Windows can dismiss a toolbar popup as the native notification releases focus.
      // Fall back to the same chooser if its UI never acknowledges this request.
      for (let attempt = 0; attempt < 20; attempt++) {
        if (!(await chrome.storage.session.get(key))[key]) return;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    } catch {
      // Chrome versions without toolbar popup support also use the compact window.
    } finally {
      await chrome.storage.session.remove(key);
    }
  }
  await chrome.windows.create({ url: chrome.runtime.getURL(popup), type: "popup", width: 496, height: 600, focused: true });
}

function openNotificationDestination(id) {
  const discord = /^discord-(announcements|school)-(\d+)$/.exec(id);
  if (discordGroupIdPattern.test(id)) {
    openingGroup = openingGroup.then(() => openGroupPicker(id)).catch(console.warn);
    return;
  }
  const url = discord && discordPostUrl(discord[1], discord[2]);
  if (url) {
    void chrome.tabs.create({ url, active: true }).then(async tab => {
      const window = await chrome.windows.get(tab.windowId);
      if (window.state === "minimized") await chrome.windows.update(tab.windowId, { state: "normal" });
      await chrome.windows.update(tab.windowId, { focused: true });
    }).catch(console.warn);
    return;
  }
  const post = /^post-(?:tab-retry-)?(\d+)$/.exec(id);
  const missed = /^missed-(?:tab-retry-)?(\d+)(?:-(\d+))?$/.exec(id);
  if (post) {
    void focusPostTab(post[1], true).catch(console.warn);
  } else if (missed) {
    const [, liveId, openedAt] = missed;
    void openMissedFromNotice(Number(liveId), openedAt === undefined ? undefined : Number(openedAt)).catch((error) => {
      if (!(error instanceof TabNavigationPendingError)) console.warn(error);
    });
  } else if (/^live-(?:only-|tab-retry-)?\d+$/.test(id)) {
    void openBroadcast(Number(id.split("-").at(-1)), true).catch(console.warn);
  } else if (id === TEST_NOTIFICATION_ID || id.startsWith(TEST_NOTIFICATION_ID + "-") || id === LIVE_TAB_RETRY_ID) {
    void openChannelNotice().catch(console.warn);
  }
}

const missedReturnKey = windowId => "missedActivityReturn:" + windowId;

async function openMissedFromNotice(liveId, openedAt) {
  const origin = await chrome.windows.getLastFocused({ windowTypes: ["normal"] }).catch(() => null);
  const result = await openMissedBroadcast(liveId, openedAt, true, false, undefined, origin?.id);
  const windowId = origin && await chrome.windows.get(origin.id).catch(() => null) ? origin.id : result.windowId;
  if (Number.isInteger(windowId)) {
    await enqueue(() => chrome.storage.session.set({ [missedReturnKey(windowId)]: true }));
  }
}

chrome.windows.onRemoved.addListener(windowId => {
  void enqueue(() => chrome.storage.session.remove(missedReturnKey(windowId)));
});

async function openMissedActivity(id, windowId) {
  const match = /^(missed|live)-(\d+)$/.exec(id);
  const { activity } = await getState();
  const entry = match && activity.find((item) => item.id === id && item.kind === match[1]);
  if (!entry) return { ok: false };
  return openMissedBroadcast(Number(match[2]), entry.openedAt, false, false, undefined, windowId);
}

function listenForNotificationClicks() {
  const clicks = chrome.notifications?.onClicked;
  if (clicks && !clicks.hasListener(openNotificationDestination)) {
    clicks.addListener(openNotificationDestination);
  }
}

class TabNavigationPendingError extends Error {
  constructor() {
    super("탭의 로딩이나 이동이 끝나면 다시 시도해 주세요.");
  }
}

function tabDestinationMatch(tab, destination, replayListTabs) {
  // A pending navigation supersedes the old page. Never redirect the user's tab.
  const value = tab?.pendingUrl || tab?.url;
  if (!value || !URL.canParse(value)) return null;
  const current = new URL(value);
  if (current.origin !== destination.origin ||
    current.pathname.replace(/\/$/, "") !== destination.pathname.replace(/\/$/, "")) return null;
  const filter = current.searchParams.get("videoType");
  if (destination.searchParams.get("videoType") !== "REPLAY" || filter === "REPLAY") return "exact";
  return !filter && replayListTabs?.has(tab.id) ? "owned-list" : null;
}

function tabHasUncertainDestination(tab) {
  // With host permissions only, an outside-site pending URL can be hidden.
  // The same shape also occurs while a committed page is still loading.
  return tab?.status === "loading" && !tab.pendingUrl;
}

async function findDestinationTab(destination, signal, replayListTabs, waitForLoad = true, windowId) {
  // Host permissions expose CHZZK URLs without requiring the broad tabs permission.
  const deadline = Date.now() + (waitForLoad ? TAB_NAVIGATION_TIMEOUT_MS : 0);
  const candidatesSeen = new Set(replayListTabs);
  while (true) {
    signal?.throwIfAborted();
    const tabs = await chrome.tabs.query({});
    if (Number.isInteger(windowId)) {
      tabs.sort((a, b) => Number(b.windowId === windowId) - Number(a.windowId === windowId));
    }
    if (replayListTabs?.size) {
      const openIds = new Set(tabs.map(({ id }) => id));
      for (const id of replayListTabs) if (!openIds.has(id)) replayListTabs.delete(id);
    }
    let fallback = null;
    let uncertain = false;
    let exactLoading = false;
    for (const candidate of tabs) {
      if (tabDestinationMatch(candidate, destination, replayListTabs)) candidatesSeen.add(candidate.id);
      else if (!(candidatesSeen.has(candidate.id) && candidate.status === "loading" && !candidate.url && !candidate.pendingUrl)) continue;
      const current = await chrome.tabs.get(candidate.id).catch(() => null);
      signal?.throwIfAborted();
      const match = tabDestinationMatch(current, destination, replayListTabs);
      if (!match) {
        if (current?.status === "loading" && !current.url && !current.pendingUrl) uncertain = true;
        else candidatesSeen.delete(candidate.id);
        continue;
      }
      if (tabHasUncertainDestination(current)) {
        uncertain = true;
        exactLoading ||= match === "exact";
      } else if (match === "exact") {
        return current;
      } else {
        fallback ??= current;
      }
    }
    if (fallback && (!exactLoading || Date.now() >= deadline)) return fallback;
    if (!uncertain) return null;
    // Do not duplicate a slow reload or mark an unknown navigation as handled.
    // Automatic detection retries on its next check if navigation stays unclear.
    if (Date.now() >= deadline) throw new TabNavigationPendingError();
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function rememberedReplayLists() {
  const state = await chrome.storage.session.get(REPLAY_LIST_TABS_KEY).catch(() => ({}));
  const ids = state[REPLAY_LIST_TABS_KEY];
  return new Set(Array.isArray(ids) ? ids.filter(Number.isInteger) : []);
}

async function focusOrOpenTab(url, signal, validate, background = false, windowId) {
  const destination = new URL(url);
  const replayList = url === REPLAY_LIST_URL;
  // A tab ID is valid only in this Chrome session. Keep ownership through
  // service worker restarts without persisting an ID across browser restarts.
  const replayListTabs = replayList ? await rememberedReplayLists() : undefined;
  const rememberedCount = replayListTabs?.size;
  if (validate) {
    // Allow a pending navigation to settle, then check the broadcast. Never use
    // a tab selected before the network response to create or activate a tab.
    try {
      await findDestinationTab(destination, signal, replayListTabs, true, windowId);
    } catch (error) {
      if (!(error instanceof TabNavigationPendingError)) throw error;
    }
    await validate();
  }
  let tab = null;
  let openedTab = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    tab = await findDestinationTab(destination, signal, replayListTabs, !validate, windowId);
    signal?.throwIfAborted();
    if (!tab) break;
    if (background) break;
    try {
      const selectedMatch = tabDestinationMatch(tab, destination, replayListTabs);
      const focused = await chrome.tabs.update(tab.id, { active: true });
      const focusedMatch = tabDestinationMatch(focused, destination, replayListTabs);
      // Recheck the candidates if a filtered list became a fallback during activation.
      const filterWasReset = selectedMatch === "exact" && focusedMatch === "owned-list";
      if (focusedMatch && !filterWasReset && !tabHasUncertainDestination(focused)) {
        tab = focused;
        break;
      }
      if (attempt === 1) throw new TabNavigationPendingError();
      tab = null;
    } catch (error) {
      if (await chrome.tabs.get(tab.id).catch(() => null)) throw error;
      tab = null;
    }
  }
  if (!tab) {
    signal?.throwIfAborted();
    const options = { url, active: !background };
    if (Number.isInteger(windowId)) {
      const origin = await chrome.windows.get(windowId).catch(() => null);
      if (origin) options.windowId = origin.id;
    }
    signal?.throwIfAborted();
    try {
      tab = await chrome.tabs.create(options);
    } catch (error) {
      if (options.windowId === undefined || await chrome.windows.get(windowId).catch(() => null)) throw error;
      signal?.throwIfAborted();
      delete options.windowId;
      tab = await chrome.tabs.create(options);
    }
    openedTab = true;
    if (Number.isInteger(tab.id)) replayListTabs?.add(tab.id);
  }
  if (replayListTabs && (openedTab || rememberedCount !== replayListTabs.size)) {
    await chrome.storage.session.set({ [REPLAY_LIST_TABS_KEY]: [...replayListTabs] }).catch(console.warn);
  }
  // Explicit navigation must reveal the window even when a new tab was needed.
  // Automatic background opening does not use this helper.
  if (!background && !signal?.aborted) await chrome.windows.update(tab.windowId, { focused: true });
  return { ok: true, openedTab, windowId: tab.windowId };
}

async function revealLiveTab(signal, validate, windowId) {
  const result = await focusOrOpenTab(LIVE_URL, signal, validate, false, windowId);
  if (!signal?.aborted) await chrome.notifications?.clear(LIVE_TAB_RETRY_ID).catch(console.warn);
  return result;
}

class BroadcastChangedError extends Error {}

async function openBroadcast(liveId, fromNotification, background = false, windowId) {
  if (fromNotification) {
    windowId = (await chrome.windows.getLastFocused({ windowTypes: ["normal"] }).catch(() => null))?.id;
  }
  const signal = fromNotification ? undefined : popupBroadcasts.signal;
  const { activity, report, settings, weekBroadcasts } = await getState();
  const entry = activity.find(row => row.id === `live-${liveId}`);
  const retryId = `${LIVE_TAB_RETRY_ID}-${liveId}`;
  if (!fromNotification && (!monitoringActive(settings) || signal.aborted)) {
    return { ok: false, message: "추적이 중단되어 방송을 열지 않았어요." };
  }

  let openedAt = entry?.openedAt ?? weekBroadcasts.find(item => item.liveId === liveId)?.openedAt;
  const replay = async () => {
    try {
      return await openMissedBroadcast(liveId, openedAt, fromNotification, background, signal, windowId);
    } catch (error) {
      if (!fromNotification && error instanceof TabNavigationPendingError) {
        return { ok: false, message: "다시보기 탭을 불러오는 중입니다. 잠시 후 다시 시도해 주세요." };
      }
      throw error;
    }
  };
  if (fromNotification && (report.closedLiveId === liveId || (report.status === "offline" && report.observedLiveId === liveId))) return replay();

  return shareNavigation(`broadcast-${liveId}-${fromNotification}-${background}-${windowId}`, async () => {
    const verify = async () => {
      signal?.throwIfAborted();
      const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
      const live = await fetchLiveStatus(signal ? AbortSignal.any([signal, timeout]) : timeout);
      signal?.throwIfAborted();
      if (live.status !== "live" || live.liveId !== liveId) {
        if (live.liveId === liveId && Number.isSafeInteger(live.openedAt)) openedAt = live.openedAt;
        if (report.status === "live" && report.observedLiveId === liveId) {
          void requestSource("live", false).catch(console.warn);
        }
        throw new BroadcastChangedError();
      }
    };
    try {
      const result = await enqueueTab(async () => {
        signal?.throwIfAborted();
        return background ? focusOrOpenTab(LIVE_URL, signal, verify, true, windowId) : revealLiveTab(signal, verify, windowId);
      });
      await chrome.notifications?.clear(retryId).catch(console.warn);
      return result;
    } catch (error) {
      if (signal?.aborted) return { ok: false, message: "추적이 중단되어 방송을 열지 않았어요." };
      if (error instanceof BroadcastChangedError) return replay();
      const loading = error instanceof TabNavigationPendingError;
      if (!fromNotification) {
        if (loading) throw error;
        return { ok: false, message: "방송 상태를 확인하지 못했어요. 잠시 후 다시 시도해 주세요." };
      }
      await notify(retryId, loading ? "라이브 탭을 불러오는 중입니다" : "방송 상태를 확인하지 못했어요",
        "잠시 후 이 알림을 눌러 같은 방송을 다시 확인해 주세요.");
    }
  });
}

function openChannelNotice() {
  return shareNavigation("live-notification", () => enqueueTab(async () => {
    try {
      return await revealLiveTab();
    } catch (error) {
      if (!(error instanceof TabNavigationPendingError)) throw error;
      await notify(LIVE_TAB_RETRY_ID, "라이브 탭을 불러오는 중입니다",
        "로딩이나 탭 이동이 끝나면 이 알림을 클릭해 다시 시도해 주세요.");
    }
  }));
}

async function focusPostTab(id, fromNotification = false) {
  if (typeof id !== "string" || !/^[1-9]\d{0,15}$/.test(id)) return { ok: false };
  const retryId = `post-tab-retry-${id}`;
  const key = fromNotification ? `post-notification-${id}` : `post-${id}`;
  return shareNavigation(key, () => enqueueTab(async () => {
    try {
      const result = await focusOrOpenTab(`${COMMUNITY_URL}/detail/${id}`);
      await chrome.notifications?.clear(retryId).catch(console.warn);
      return result;
    } catch (error) {
      if (!fromNotification || !(error instanceof TabNavigationPendingError)) throw error;
      await notify(retryId, "게시글 탭을 불러오는 중입니다",
        "로딩이나 탭 이동이 끝나면 이 알림을 눌러 같은 게시글로 이동해 주세요.");
    }
  }));
}

async function openIfMissing(openInBackground, signal) {
  if (!openInBackground) return (await revealLiveTab(signal)).openedTab;
  const tab = await findDestinationTab(new URL(LIVE_URL), signal);
  signal?.throwIfAborted();
  if (tab) return false;
  await chrome.tabs.create({ url: LIVE_URL, active: false });
  return true;
}

function handleLive(live, startedAt, settings, report) {
  const checkedAt = Date.now();
  const next = {
    status: live.status,
    checkedAt,
    lastKnownStatus: live.status,
    lastKnownAt: checkedAt,
    latestOpenedAt: Number.isSafeInteger(live.openedAt) ? live.openedAt : report.latestOpenedAt,
    currentOpenedAt: live.status === "live" && Number.isSafeInteger(live.openedAt) ? live.openedAt : null,
    lastSuccessAt: startedAt,
    handledLiveId: report.handledLiveId ?? null,
    observedLiveId: report.observedLiveId ?? report.handledLiveId ?? null,
    closedLiveId: (live.status === "offline" ? live.liveId : null) ?? report.closedLiveId ?? null,
  };
  let alert;
  let event;
  let shouldOpen = false;
  if (live.status === "live" && live.liveId !== next.observedLiveId) {
    next.observedLiveId = live.liveId;
    event = { id: `live-${live.liveId}`, kind: "live", at: checkedAt, title: live.title };
    if (Number.isSafeInteger(live.openedAt)) event.openedAt = live.openedAt;
  }
  if (live.status === "live" && live.liveId !== next.handledLiveId) {
    if (settings.broadcastMode === "notify") {
      if (chrome.notifications) {
        next.handledLiveId = live.liveId;
        alert = { id: `live-only-${live.liveId}`, kind: "liveOnly" };
      }
    } else shouldOpen = true;
  }
  if (
    live.status === "offline" && live.liveId && live.liveId !== next.handledLiveId &&
    live.liveId !== report.closedLiveId && Number.isFinite(report.lastSuccessAt) &&
    live.openedAt >= Math.floor(report.lastSuccessAt / 1_000) * 1_000 &&
    live.closedAt >= live.openedAt && live.closedAt <= checkedAt
  ) {
    alert = { id: `missed-${live.liveId}`, kind: "missed", openedAt: live.openedAt };
    event = { ...alert, at: checkedAt, title: live.title };
  }
  return { report: next, alert, event, shouldOpen };
}

function isLiveOpening() {
  return !!pendingLiveOpening && !pendingLiveOpening.controller.signal.aborted;
}

function publishLiveOpening() {
  void chrome.runtime.sendMessage({ type: "live-opening-changed", opening: isLiveOpening() }).catch(() => {});
}

function startLiveOpening(live, background) {
  const opening = { live, background, controller: new AbortController() };
  const { signal } = opening.controller;
  pendingLiveOpening = opening;
  publishLiveOpening();
  const result = enqueueTab(async () => {
    if (signal.aborted) return null;
    try {
      return { openedTab: await openIfMissing(background, signal) };
    } catch (error) {
      return { error };
    }
  }).then((tab) => tab ? enqueue(() => finishLiveOpening(opening, tab)) : "cancelled").catch((error) => {
    console.warn("자동 라이브 열기 결과 처리 실패:", error);
    return "failed";
  }).finally(() => {
    if (pendingLiveOpening === opening) {
      pendingLiveOpening = undefined;
      if (!signal.aborted) publishLiveOpening();
    }
  });
  // Settings can cancel a queued open while an unrelated tab is still loading.
  // A Chrome API call already submitted still settles and is recorded separately.
  const cancelled = new Promise((resolve) => {
    signal.addEventListener("abort", () => {
      if (pendingLiveOpening === opening) publishLiveOpening();
      resolve("cancelled");
    }, { once: true });
  });
  return Promise.race([result, cancelled]);
}

async function finishLiveOpening(opening, { openedTab, error }) {
  const { live, background, controller: { signal } } = opening;
  const state = await getState();
  const { report, activity, pendingNotifications, settings } = state;
  if (report.observedLiveId !== live.liveId) return "cancelled";
  if (signal.aborted || !monitoringActive(settings)) {
    // Remember a creation already submitted to Chrome without sending a stale alert.
    if (openedTab) await chrome.storage.local.set({ report: { ...report, handledLiveId: live.liveId } });
    return "cancelled";
  }
  if (report.handledLiveId === live.liveId) return "complete";
  if (error) {
    console.warn("라이브 탭 열기 실패:", error);
    if (report.status === "live") {
      const message = "방송 중입니다. 탭을 열거나 확인하지 못해 다음 조회 때 다시 시도합니다.";
      await chrome.storage.local.set({ report: { ...report, error: message } });
    }
    return "failed";
  }
  const changes = { report: { ...report, handledLiveId: live.liveId } };
  if (background && noticeEnabled(settings, "live") && chrome.notifications) {
    const id = `live-${live.liveId}`;
    const now = Date.now();
    pendingNotifications[id] ??= { kind: "live", openedTab, createdAt: now, retryAt: now, failures: 0 };
    changes.pendingNotifications = pendingNotifications;
  }
  await chrome.storage.local.set(changes);
  await deliverNotifications("live", pendingNotifications, activity, report.status === "live" ? live : undefined, signal, settings);
  await syncNotificationRetryAlarm(await getState());
  return signal.aborted ? "cancelled" : "complete";
}

function comparePosts(left, right) {
  return left.created.localeCompare(right.created) || left.id - right.id;
}

async function fetchCommunityPosts(signal) {
  const body = await fetchJson(COMMUNITY_API_URL, "커뮤니티", signal);
  const entries = body?.content?.comments?.data;
  if (body?.code !== 200 || !Array.isArray(entries)) {
    throw new StatusError("커뮤니티 글 목록을 읽을 수 없습니다.");
  }

  const posts = [];
  for (const entry of entries) {
    const { comment, user } = entry ?? {};
    if (comment?.objectType !== "CHANNEL_POST" || comment.objectId !== CHANNEL_ID ||
      comment.parentCommentId !== 0 || comment.secret || comment.deleted ||
      user?.userIdHash !== CHANNEL_ID) continue;

    if (!Number.isSafeInteger(comment.commentId) || comment.commentId <= 0 ||
      typeof comment.createdDate !== "string" || !/^\d{14}$/.test(comment.createdDate)) {
      throw new StatusError("커뮤니티 글 ID 또는 게시 시각을 읽을 수 없습니다.");
    }
    posts.push({ id: comment.commentId, created: comment.createdDate });
  }
  return posts.sort(comparePosts);
}

function handleCommunity(posts, previous) {
  const alerts = [];
  let latest = previous.latest ?? null;
  if (previous.initialized) {
    for (const post of posts) {
      if (!latest || comparePosts(post, latest) > 0) {
        alerts.push({ id: `post-${post.id}`, kind: "post", postCreated: post.created });
        latest = post;
      }
    }
  } else {
    latest = posts.at(-1) ?? null;
  }
  return { report: { initialized: true, latest, checkedAt: Date.now() }, alerts };
}

async function commitCheck(source, key, startedAt, data, error, signal) {
  const state = await getState();
  if (!monitoringActive(state.settings) || signal.aborted) return "cancelled";
  const discord = DISCORD_SOURCES.includes(source);
  if (NEWS_SOURCES.includes(source) && !await chrome.permissions.contains(COMMUNITY_ACCESS)) return "off";
  if (signal.aborted) return "cancelled";

  const previous = state[key];
  const live = source === "live" ? data : undefined;
  let report;
  let shouldOpen = false;
  let alerts = [];
  let events = [];
  const changes = {};
  if (error) {
    const interval = source === "live" ? state.settings.intervalSeconds : state.settings.communityIntervalSeconds;
    report = failureReport(previous, error, interval);
    if (source === "live") {
      report.lastKnownStatus = previous.lastKnownStatus ?? previous.status;
      report.lastKnownAt = previous.lastKnownAt ?? previous.lastSuccessAt;
      report.status = "unknown";
    }
  } else if (live) {
    if (pendingLiveOpening && (live.status !== "live" || pendingLiveOpening.live.liveId !== live.liveId)) {
      pendingLiveOpening.controller.abort();
    }
    const handled = handleLive(live, startedAt, state.settings, previous);
    ({ report, shouldOpen } = handled);
    if (handled.alert) alerts.push(handled.alert);
    if (handled.event) events.push(handled.event);
    if (!state.historySeeded.live && !previous.lastSuccessAt && live.status === "offline" && live.liveId && Number.isSafeInteger(live.openedAt)) {
      events.push({ id: `live-${live.liveId}`, kind: "live", historical: true, at: live.openedAt, openedAt: live.openedAt, title: live.title });
      changes.historySeeded = { ...state.historySeeded, live: true };
    }
  } else if (discord && data) {
    const ids = data.ids.filter(id => !previous.latestId || BigInt(id) > BigInt(previous.latestId));
    report = { initialized: true, latestId: ids.at(-1) ?? previous.latestId ?? null, cursor: data.cursor, checkedAt: Date.now() };
    const recorded = previous.initialized ? ids : !state.historySeeded[source] ? ids.slice(-1) : [];
    for (const id of recorded) {
      events.push({ id: `discord-${source}-${id}`, kind: "discord", source, postId: id, at: discordTime(id),
        ...(previous.initialized ? { discoveredAt: report.checkedAt } : { historical: true }) });
    }
    if (previous.initialized && ids.length) {
      const group = ids.length > 1;
      const id = `discord-${group ? "group-" : ""}${source}-${ids.at(-1)}`;
      alerts.push({ id, kind: "discord", source, count: ids.length });
      if (group) {
        const { discordGroups = {} } = await chrome.storage.local.get("discordGroups");
        const retained = Object.entries(discordGroups).filter(([, g]) => g.at > Date.now() - 30 * 86400000).sort((a,b) => b[1].at-a[1].at).slice(0,99);
        changes.discordGroups = { ...Object.fromEntries(retained), [id]: { source, ids: ids.slice().reverse(), at: Date.now() } };
      }
    }
  } else if (data) {
    ({ report, alerts } = handleCommunity(data, previous));
    events = alerts.map((alert) => ({ ...alert, at: report.checkedAt }));
    if (!previous.initialized && !state.historySeeded.community && report.latest) {
      const { id, created } = report.latest;
      const at = Date.parse(created.replace(/^(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)$/, "$1-$2-$3T$4:$5:$6+09:00"));
      if (Number.isFinite(at)) events.push({ id: "post-" + id, kind: "post", postCreated: created, at, historical: true });
    }
  }
  if (NEWS_SOURCES.includes(source) && data && !state.historySeeded[source]) changes.historySeeded = { ...state.historySeeded, [source]: true };
  if (report) changes[key] = report;
  if (live) {
    const weekStart = seoulWeekStart() - 7 * DAY_MS;
    const broadcasts = state.weekBroadcasts.filter(item => item.openedAt >= weekStart);
    if (live.liveId && live.openedAt >= weekStart && live.openedAt <= Date.now()) {
      const item = { liveId: live.liveId, openedAt: live.openedAt, title: live.title, ended: live.status === "offline" };
      const index = broadcasts.findIndex(row => row.liveId === live.liveId);
      if (index < 0) broadcasts.push(item);
      else broadcasts[index] = { ...broadcasts[index], ...item };
    }
    if (JSON.stringify(broadcasts) !== JSON.stringify(state.weekBroadcasts)) changes.weekBroadcasts = broadcasts;
  }
  if (events.length) changes.activity = recordActivity(state.activity, events);
  if (Number.isSafeInteger(live?.openedAt) && live.liveId) {
    const rows = changes.activity ?? state.activity;
    const needsTime = (item) => item.id === `live-${live.liveId}` && !Number.isSafeInteger(item.openedAt);
    if (rows.some(needsTime)) changes.activity = rows.map((item) => needsTime(item) ? { ...item, openedAt: live.openedAt } : item);
  }
  alerts = alerts.filter((alert) => noticeEnabled(state.settings, alert.kind));
  if (alerts.length && chrome.notifications) {
    const now = Date.now();
    for (const { id, ...details } of alerts) {
      state.pendingNotifications[id] ??= { ...details, createdAt: now, retryAt: now, failures: 0 };
    }
    changes.pendingNotifications = state.pendingNotifications;
  }
  if (!discord && error?.connectionError && !signal.aborted) {
    // A wake-up can precede network recovery. Retry soon, then keep the selected period.
    // Chrome may deliver a scheduled alarm a few milliseconds before Date.now reaches it.
    const when = report.retryAt + 1_000;
    if (source === "live") await chrome.alarms.create(LIVE_ALARM, { when, periodInMinutes: state.settings.intervalSeconds / 60 });
    else await chrome.alarms.create(COMMUNITY_RETRY_ALARM, { when });
  } else if (source === "community" && data) await chrome.alarms.clear(COMMUNITY_RETRY_ALARM);
  if (Object.keys(changes).length) await chrome.storage.local.set(changes);
  await deliverNotifications(source, state.pendingNotifications, changes.activity ?? state.activity, live, signal, state.settings);
  await syncNotificationRetryAlarm(await getState());
  if (signal.aborted) return "cancelled";
  if (shouldOpen && (!pendingLiveOpening || pendingLiveOpening.controller.signal.aborted)) {
    return { opening: startLiveOpening(live, state.settings.broadcastMode === "background") };
  }
  if (error || report?.error) return "failed";
  return report ? "complete" : "waiting";
}

async function checkSource(source, signal) {
  const discord = DISCORD_SOURCES.includes(source);
  const key = source === "live" ? "report" : source + "Report";
  const state = await enqueue(getState);
  if (signal.aborted) return "cancelled";
  if (!monitoringActive(state.settings)) return "off";
  if (NEWS_SOURCES.includes(source) && !await chrome.permissions.contains(COMMUNITY_ACCESS)) return "off";
  if (signal.aborted) return "cancelled";

  const startedAt = Date.now();
  let data;
  let error;
  if (!(startedAt < state[key].retryAt)) {
    try {
      if (discord) {
        data = await fetchDiscordPosts(source, state[key], signal);
      } else data = await (source === "live" ? fetchLiveStatus(signal) : fetchCommunityPosts(signal));
    } catch (failure) {
      error = failure;
    }
  }
  if (signal.aborted) return "cancelled";
  const result = await enqueue(() => commitCheck(source, key, startedAt, data, error, signal));
  if (source === "live" && data && !state.historySeeded.live && !signal.aborted) {
    await seedPreviousReplay(data, signal).catch(() => {});
  }
  return result;
}

async function fetchDiscordPosts(source, previous, signal) {
  const ids = new Set();
  let cursor = previous.cursor;
  for (let page = 0; page < 5; page++) {
    const query = cursor ? "?cursor=" + encodeURIComponent(cursor) : previous.initialized ? "?recent=1" : "";
    const data = await fetchJson("https://seol-tracker-api.jqu8ry.workers.dev/v2/discord/" + source + query, "디스코드 " + DISCORD_CHANNELS[source].name, signal);
    if (!Array.isArray(data?.ids) || data.ids.length > 100 || !/^[1-9]\d{16,19}\.[a-f0-9]{64}$/.test(data.cursor) ||
        typeof data.more !== "boolean" || data.ids.some(id => !discordPostUrl(source, id)) ||
        (data.more && (!data.ids.length || data.cursor === cursor))) throw new StatusError("디스코드 새 글 목록을 읽을 수 없어요.");
    for (const id of data.ids) ids.add(id);
    cursor = data.cursor;
    if (!data.more) break;
  }
  return { ids: [...ids].sort((a,b) => a.length-b.length || a.localeCompare(b)), cursor };
}

async function seedPreviousReplay(live, signal) {
  if ((await getState()).historySeeded.live) return;
  const { code, content } = await fetchJson(REPLAY_LIST_API_URL + "&page=0&size=5", "직전 방송", signal);
  if (code !== 200 || !Array.isArray(content?.data)) return;
  let entry;
  for (const row of content.data.filter(isChannelReplay)) {
    const reply = await fetchJson(VIDEO_DETAIL_API_URL + "/" + row.videoNo, "직전 방송", signal);
    const video = reply?.content;
    const openedAt = liveTimestamp(video?.liveOpenDate);
    if (reply.code !== 200 || !isChannelReplay(video) || video.videoNo !== row.videoNo || !video.exposure || video.blindType ||
        !Number.isSafeInteger(openedAt) || openedAt >= (live.status === "live" && live.openedAt || Date.now())) continue;
    entry = { kind: "archive", id: "archive-" + row.videoNo, at: openedAt, openedAt, historical: true, replayVideoNo: row.videoNo, title: String(video.videoTitle ?? "").slice(0,160) };
    break;
  }
  await enqueue(async () => {
    const state = await getState();
    if (signal.aborted || !monitoringActive(state.settings) || state.historySeeded.live) return;
    const changes = { historySeeded: { ...state.historySeeded, live: true } };
    if (entry && !state.activity.some(item=>item.openedAt===entry.openedAt || item.replayVideoNo===entry.replayVideoNo)) changes.activity=recordActivity(state.activity,[entry]);
    await chrome.storage.local.set(changes);
  });
}

function requestSource(source, waitForOpening = true) {
  let current = pendingChecks.get(source);
  if (!current || current.controller.signal.aborted) {
    const controller = new AbortController();
    const check = { controller };
    check.result = checkSource(source, controller.signal).finally(() => {
      if (pendingChecks.get(source) === check) pendingChecks.delete(source);
    });
    pendingChecks.set(source, check);
    current = check;
  }
  return current.result.then((result) => {
    if (typeof result === "string") return result;
    return waitForOpening ? result.opening : "complete";
  });
}

async function requestCheck(sources = ["live", "community", ...DISCORD_SOURCES], waitForOpening = true) {
  const entries = await Promise.all([...sources].map(async (source) => [source, await requestSource(source, waitForOpening)]));
  return { ok: true, checks: Object.fromEntries(entries) };
}

async function manualCheckGroup(sources, alarmName, intervalKey) {
  const { checks } = await requestCheck(sources, false);
  if (sources.every(source => checks[source] === "complete")) {
    await enqueue(async () => {
      const state = await getState();
      if (!monitoringActive(state.settings)) return;
      if (alarmName === COMMUNITY_ALARM && !await chrome.permissions.contains(COMMUNITY_ACCESS)) return;
      const reports = sources.map(source => source === "live" ? state.report : state[source + "Report"]);
      if (reports.some(report => report.error || !Number.isFinite(report.checkedAt))) return;
      const seconds = state.settings[intervalKey];
      const when = Math.max(...reports.map(report => report.checkedAt)) + seconds * 1000;
      await chrome.alarms.create(alarmName, { when, periodInMinutes: seconds / 60 });
      // An open popup in another window also needs the new deadline.
      void chrome.runtime.sendMessage({ type: "check-schedule-updated" }).catch(() => {});
    });
  }
  return checks;
}

function changeSettings(key, value) {
  const valid = (key === "enabled" && typeof value === "boolean") ||
    (["notifyLive", "notifyMissed"].includes(key) && typeof value === "boolean") ||
    (key === "intervalSeconds" && INTERVALS.includes(value)) ||
    (key === "communityIntervalSeconds" && COMMUNITY_INTERVALS.includes(value)) ||
    (key === "broadcastMode" && Object.hasOwn(BROADCAST_MODES, value));
  if (!valid) {
    return Promise.reject(new Error("확장 프로그램 설정이 올바르지 않습니다."));
  }
  const patch = { [key]: value };
  if (key === "enabled") patch.pausedUntil = null;
  return queueSettingsChange(patch);
}

function queueSettingsChange(patch, resetTheme = false) {
  const stop = patch.enabled === false;
  if (stop) cancelPopupBroadcasts();
  const changeNotices = "notifyLive" in patch || "notifyMissed" in patch;
  const interruptLive = changeNotices || "broadcastMode" in patch;
  if (stop || interruptLive) notificationRetry?.abort();
  const interruptedSources = new Set();
  if (pendingLiveOpening && (stop || interruptLive)) {
    interruptedSources.add("live");
    pendingLiveOpening.controller.abort();
  }
  for (const [source, check] of pendingChecks) {
    if (stop || (interruptLive && source === "live")) {
      interruptedSources.add(source);
      check.controller.abort();
    }
  }
  return enqueue(() => saveSettings(patch, resetTheme, interruptedSources));
}

async function saveSettings(patch, resetTheme, interruptedSources) {
  const { settings: previous, report, pendingNotifications, activity } = await getState();
  const settings = { ...previous, ...patch };
  const changes = { settings };
  if (!settings.enabled && previous.enabled) {
    for (const source of DISCORD_SOURCES) changes[source + "Report"] = {};
  }
  if (resetTheme) changes.popupTheme = "auto";
  const cancelled = new Set();
  for (const [id, notice] of Object.entries(pendingNotifications)) {
    if (!noticeEnabled(settings, notice.kind)) {
      delete pendingNotifications[id];
      cancelled.add(`failure-${id}`);
    }
  }
  if (cancelled.size) {
    changes.pendingNotifications = pendingNotifications;
    changes.activity = activity.map((entry) => cancelled.has(entry.id) ?
      { ...entry, outcome: "cancelled", endReason: "type-disabled" } : entry);
  }
  if (!settings.enabled && previous.enabled) changes.report = { ...report, status: "pending", lastSuccessAt: null };
  if (monitoringActive(settings) && !monitoringActive(previous)) changes.report = { ...report, status: "pending" };
  try {
    await syncAlarms(settings);
    await chrome.storage.local.set(changes);
  } catch (error) {
    // Storage still contains the previous settings. Restore their schedules
    // after all in-flight alarm mutations have finished, including partial failure.
    await syncAlarms(previous).catch((rollbackError) => console.warn("설정 예약 복구 실패:", rollbackError));
    throw error;
  }
  // The settings commit succeeded; retry-alarm maintenance must not report it
  // as a rejected settings change. Subsequent checks reconcile this schedule.
  await getState().then(syncNotificationRetryAlarm).catch((error) => console.warn("알림 예약 정리 실패:", error));
  if (!settings.enabled) await clearScheduleRecovery().catch(console.warn);
  if (monitoringActive(settings) && (!monitoringActive(previous) || interruptedSources.size)) {
    // Start after this settings update leaves the queue.
    void requestCheck(monitoringActive(previous) ? interruptedSources : undefined).catch(() => {});
  }
  return { ok: true, settings };
}

function pauseMonitoring(minutes) {
  if (!Number.isInteger(minutes) || minutes < 0 || minutes > PAUSE_MAX_MINUTES) {
    return Promise.resolve({ ok: false, message: "1분부터 6시간까지 선택해 주세요." });
  }
  if (minutes) {
    cancelPopupBroadcasts();
    notificationRetry?.abort();
    pendingLiveOpening?.controller.abort();
    for (const check of pendingChecks.values()) check.controller.abort();
  }
  return enqueue(async () => {
    const state = await getState();
    if (!state.settings.enabled) return { ok: false, message: "자동 추적을 먼저 켜 주세요." };
    const settings = { ...state.settings, pausedUntil: minutes ? Date.now() + minutes * 60_000 : null };
    const changes = { settings };
    if (minutes && !state.settings.pausedUntil) changes.report = { ...state.report, status: "pending", lastSuccessAt: null };
    if (!minutes && state.settings.pausedUntil) changes.report = { ...state.report, status: "pending" };
    try {
      // Keep the old schedules until the replacement wake-up is secured and
      // storage commits. A failed pause must not strand an enabled tracker.
      if (minutes) {
        await chrome.alarms.create(RESUME_ALARM, { when: settings.pausedUntil });
      } else {
        await syncAlarm(LIVE_ALARM, true, settings.intervalSeconds);
        if (await chrome.permissions.contains(COMMUNITY_ACCESS)) {
          await syncAlarm(COMMUNITY_ALARM, true, settings.communityIntervalSeconds);
        }
      }
      await chrome.storage.local.set(changes);
    } catch (error) {
      await syncAlarms(state.settings).catch((rollbackError) => console.warn("중지 예약 복구 실패:", rollbackError));
      throw error;
    }
    // These remove obsolete alarms after the committed state is already safe.
    // Any remaining check/retry alarm still consults the saved paused state.
    await syncAlarms(settings).catch((error) => console.warn("중지 예약 정리 실패:", error));
    await getState().then(syncNotificationRetryAlarm).catch((error) => console.warn("알림 예약 정리 실패:", error));
    if (minutes) await clearScheduleRecovery().catch(console.warn);
    if (!minutes) void requestCheck().catch(() => {});
    return { ok: true, settings };
  });
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id) return;
  const popupUrl = chrome.runtime.getURL("popup.html");
  const fromGroupPicker = sender.url?.startsWith(popupUrl + "#") &&
    discordGroupIdPattern.test(sender.url.slice(popupUrl.length + 1));
  if (sender.url !== popupUrl && !fromGroupPicker) return;
  const windowId = sender.tab?.windowId ?? message?.windowId;
  let action;
  if (message?.type === "take-missed-return" && !sender.tab && Number.isInteger(windowId)) {
    action = enqueue(async () => {
      const key = missedReturnKey(windowId);
      const restore = !!(await chrome.storage.session.get(key))[key];
      if (restore) await chrome.storage.session.remove(key);
      return { restore };
    });
  }
  if (message?.type === "ready") action = Promise.all([profileReady, initialSchedules]).then(() => ({ ok: true }));
  if (message?.type === "confirm-news-schedule") action = (async () => {
    // Wait behind any permission-change work already queued by Chrome.
    let alarm = await enqueue(() => chrome.alarms.get(COMMUNITY_ALARM));
    if (!alarm) {
      await reconcileAlarms();
      alarm = await chrome.alarms.get(COMMUNITY_ALARM);
    }
    return { alarm: alarm ?? null };
  })();
  if (message?.type === "week-replays" || message?.type === "week-clips") {
    action = requestWeek(message.type, message.previous === true);
  }
  if (message?.type === "open-week-replay" && replayUrl(message.videoNo)) {
    action = (async () => {
      const checkedAt = Date.now();
      const { status } = await checkReplay(message.videoNo, AbortSignal.timeout(REPLAY_LOOKUP_TIMEOUT_MS));
      if (status !== "public") {
        await chrome.storage.session.remove(["weekReplayCache", "weekReplayCachePrevious"]);
        return { ok: false, status, checkedAt, message: status === "unavailable" ?
          "현재 볼 수 없는 다시보기예요." : "다시보기 공개 상태를 확인하지 못했어요. 잠시 후 다시 시도해 주세요." };
      }
      return enqueueTab(() => focusOrOpenTab(replayUrl(message.videoNo), undefined, undefined, message.background === true, windowId));
    })();
  }
  if (message?.type === "save") action = changeSettings(message.key, message.value);
  if (message?.type === "reset-settings") action = queueSettingsChange(DEFAULT_SETTINGS, true);
  if (message?.type === "pause") action = pauseMonitoring(message.minutes);
  if (message?.type === "check") {
    action = message.restartCountdown ? Promise.all([
      manualCheckGroup(["live"], LIVE_ALARM, "intervalSeconds"),
      manualCheckGroup(NEWS_SOURCES, COMMUNITY_ALARM, "communityIntervalSeconds"),
    ]).then(([live, news]) => ({ ok: true, checks: { ...live, ...news } })) :
      requestCheck(undefined, message.waitForOpening !== false);
  }
  if (message?.type === "live-opening-status") action = Promise.resolve({ opening: isLiveOpening() });
  if (message?.type === "recover") action = reconcileAlarms().then(async (recovered) => {
    const guard = await chrome.alarms.get(RECOVERY_ALARM);
    if (recovered === null || guard) {
      return { ok: false, message: guard ? "예약을 아직 복구하지 못했습니다. 자동으로 다시 시도합니다." :
        "예약을 아직 복구하지 못했습니다. 잠시 후 지금 복구를 다시 눌러 주세요." };
    }
    return requestCheck();
  });
  if (message?.type === "test-notification") action = testNotification();
  if (message?.type === "open-live" && Number.isSafeInteger(message.liveId) && message.liveId > 0) {
    action = openBroadcast(message.liveId, false, message.background === true, windowId);
  }
  if (message?.type === "open-activity-live" && /^live-\d+$/.test(message.id)) action = openBroadcast(Number(message.id.slice(5)), false, message.background === true, windowId);
  if (message?.type === "open-post") action = focusPostTab(message.id);
  if (message?.type === "open-missed") action = openMissedActivity(message.id, windowId);
  if (!action) return;

  action.then(
    (result) => respond(result ?? { ok: true }),
    (error) => {
      if ((message.type === "open-live" || message.type === "open-activity-live") && error instanceof TabNavigationPendingError) {
        respond({ ok: false, message: "라이브 탭을 불러오는 중입니다. 로딩이나 탭 이동이 끝나면 다시 시도해 주세요." });
      } else if (["open-missed", "open-week-replay"].includes(message.type) && error instanceof TabNavigationPendingError) {
        respond({ ok: false, message: "다시보기 탭을 불러오는 중입니다. 로딩이나 탭 이동이 끝나면 다시 시도해 주세요." });
      } else if (message.type === "open-post" && error instanceof TabNavigationPendingError) {
        respond({ ok: false, message: "게시글 탭을 불러오는 중입니다. 로딩이나 탭 이동이 끝나면 ‘게시글 열기’를 다시 눌러 주세요." });
      } else {
        respond({ ok: false });
      }
    },
  );
  return true;
});

// Unpacked reloads do not always supply the original version in onInstalled.
// Snapshot the existing profile before startup checks can create any first-run data.
const profileReady = enqueue(async () => {
  const state = await chrome.storage.local.get(["settings", "newsSourcesVersion", "profileDefaultsVersion", "report", "activity", "communityReport", "tourPending", "firstNotificationSetup", "weeklyFeatureNotice", "newsBasketFeatureNotice"]);
  if (state.newsBasketFeatureNotice === undefined) {
    await chrome.storage.local.set({ newsBasketFeatureNotice: Object.keys(state).length ? "pending" : "seen" });
  }
  if (!state.newsSourcesVersion) {
    await chrome.alarms.clear("check-discord");
    const changes = { newsSourcesVersion: 1 };
    if (state.settings && "notifyDiscord" in state.settings) {
      const { notifyDiscord, ...settings } = state.settings;
      if (!notifyDiscord || !await chrome.permissions.contains(COMMUNITY_ACCESS)) {
        const { pendingNotifications = {} } = await chrome.storage.local.get("pendingNotifications");
        const ids = Object.keys(pendingNotifications).filter(id => pendingNotifications[id].kind === "discord");
        for (const id of ids) delete pendingNotifications[id];
        if (ids.length) {
          changes.pendingNotifications = pendingNotifications;
          changes.activity = (state.activity ?? []).map(item => ids.some(id => item.id === "failure-" + id)
            ? { ...item, outcome: "cancelled", endReason: "type-disabled" } : item);
        }
        for (const source of DISCORD_SOURCES) changes[source + "Report"] = {};
      }
      changes.settings = state.settings = settings;
    }
    await chrome.storage.local.set(changes);
  }
  if (state.profileDefaultsVersion) return;
  const settings = state.settings ?? {};
  const existing = Object.keys(state).length > 0;
  const broadcastMode = settings.broadcastMode ?? (typeof settings.openInBackground === "boolean"
    ? normalizeSettings(settings).broadcastMode : existing ? "notify" : DEFAULT_SETTINGS.broadcastMode);
  await chrome.storage.local.set({ settings: { ...settings, broadcastMode }, profileDefaultsVersion: 1 });
  return { existing, hadMode: settings.broadcastMode != null || typeof settings.openInBackground === "boolean" };
});
chrome.runtime.onInstalled.addListener(({ reason, previousVersion }) => {
  void enqueue(async () => {
    const initialized = await profileReady;
    const changes = reason === "install" && !initialized?.existing ? { firstNotificationSetup: true, tourPending: true } : {};
    const [major, minor] = (previousVersion ?? "").split(".").map(Number);
    if (reason === "update" && previousVersion !== chrome.runtime.getManifest().version &&
        initialized && !initialized.hadMode && Number.isInteger(minor)) {
      const priorDefault = major === 1 && minor < 9 ? "notify" : DEFAULT_SETTINGS.broadcastMode;
      const { settings } = await chrome.storage.local.get("settings");
      if (settings.broadcastMode !== priorDefault) changes.settings = { ...settings, broadcastMode: priorDefault };
    }
    if (Object.keys(changes).length) await chrome.storage.local.set(changes);
  }).then(() => requestCheck()).catch(console.warn);
});
chrome.runtime.onStartup.addListener(() => { void requestCheck().catch(() => {}); });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === LIVE_ALARM) void requestCheck(["live"]).catch(() => {});
  if (alarm.name === COMMUNITY_ALARM) void requestCheck(NEWS_SOURCES).catch(console.warn);
  if (alarm.name === COMMUNITY_RETRY_ALARM) void requestCheck(["community"]).catch(console.warn);
  if (alarm.name === NOTIFICATION_RETRY_ALARM) void retryNotifications().catch(() => {});
  if (alarm.name === RESUME_ALARM || alarm.name === RECOVERY_ALARM) {
    void reconcileAlarms().then((resumed) => resumed && requestCheck()).catch(() => {});
  }
});
function permissionChangesCommunity(permissions) {
  return permissions.permissions?.includes(NOTIFICATION_ACCESS.permissions[0]) ||
    permissions.origins?.includes(COMMUNITY_ACCESS.origins[0]);
}

async function clearScheduleRecovery() {
  await chrome.storage.local.remove("scheduleRecovery");
  await chrome.alarms.clear(RECOVERY_ALARM);
}

function reconcileAlarms() {
  return enqueue(async () => {
    let checkAfterRecovery = false;
    // A durable periodic guard survives worker termination and repeated failures.
    // It is armed before clearing an expired pause, and removed only after all
    // source schedules and the saved recovery state have been reconciled.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const state = await getState();
        const recovery = await chrome.storage.local.get("scheduleRecovery");
        const guard = await chrome.alarms.get(RECOVERY_ALARM);
        const resumed = state.settings.enabled && state.settings.pausedUntil && state.settings.pausedUntil <= Date.now();
        checkAfterRecovery ||= !!resumed || !!recovery.scheduleRecovery || !!guard;
        if (resumed && !guard) await chrome.alarms.create(RECOVERY_ALARM, { periodInMinutes: 0.5 });
        if (resumed) {
          state.settings.pausedUntil = null;
          await chrome.storage.local.set({ settings: state.settings, report: { ...state.report, status: "pending" } });
        }
        await syncAlarms(state.settings);
        await syncNotificationRetryAlarm(state);
        if (recovery.scheduleRecovery) await chrome.storage.local.remove("scheduleRecovery");
        await chrome.alarms.clear(RECOVERY_ALARM);
        return monitoringActive(state.settings) && checkAfterRecovery;
      } catch (error) {
        console.warn("추적 예약 복구 실패:", error);
        // The immediate second attempt handles transient failures. Persistent
        // failures leave a separate alarm, independent of missing source alarms.
        let recoveryAlarm;
        try {
          if (!await chrome.alarms.get(RECOVERY_ALARM)) {
            await chrome.alarms.create(RECOVERY_ALARM, { periodInMinutes: 0.5 });
          }
          recoveryAlarm = await chrome.alarms.get(RECOVERY_ALARM);
        } catch (recoveryError) { console.warn("복구 예약 실패:", recoveryError); }
        // Even when Chrome cannot create any alarm, retain actionable UI state.
        try {
          await chrome.storage.local.set({ scheduleRecovery: { at: Date.now(), retryAt: recoveryAlarm?.scheduledTime ?? null } });
        } catch (storageError) { console.warn("복구 상태 저장 실패:", storageError); }
      }
    }
    return null;
  });
}

chrome.permissions.onAdded.addListener((permissions) => {
  if (permissions.permissions?.includes("notifications")) void chrome.storage.local.remove("firstNotificationSetup");
  listenForNotificationClicks();
  if (permissionChangesCommunity(permissions)) {
    const sources = permissions.permissions?.includes(NOTIFICATION_ACCESS.permissions[0]) ?
      ["live", ...NEWS_SOURCES] : NEWS_SOURCES;
    void reconcileAlarms().then(() => requestCheck(sources)).catch(() => {});
  }
});
chrome.permissions.onRemoved.addListener((permissions) => {
  if (!permissionChangesCommunity(permissions)) return;
  notificationRetry?.abort();
  for (const source of NEWS_SOURCES) pendingChecks.get(source)?.controller.abort();
  void enqueue(async () => {
    const { settings, communityReport, pendingNotifications, activity } = await getState();
    const cancelled = new Set();
    for (const [id, entry] of Object.entries(pendingNotifications)) {
      if (entry.kind === "post" || entry.kind === "discord") {
        delete pendingNotifications[id];
        cancelled.add(`failure-${id}`);
      }
    }
    // The first successful check after re-enabling uses a new baseline.
    const changes = { communityReport: { checkedAt: communityReport.checkedAt }, pendingNotifications };
    for (const source of DISCORD_SOURCES) changes[source + "Report"] = {};
    if (cancelled.size) changes.activity = activity.map((item) => cancelled.has(item.id) ? { ...item, outcome: "cancelled" } : item);
    await chrome.storage.local.set(changes);
    await syncAlarms(settings);
    await syncNotificationRetryAlarm(await getState());
  }).catch(() => {});
});
listenForNotificationClicks();

// Chrome can drop alarms between sessions. Reconcile on every worker start.
const initialSchedules = reconcileAlarms();
void initialSchedules.then((resumed) => resumed && requestCheck()).catch(() => {});
