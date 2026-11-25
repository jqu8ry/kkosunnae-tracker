export const CHANNEL_ID = "3893acad87cc1d479b9f61f2e732a75a";
export const CHANNEL_URL = `https://chzzk.naver.com/${CHANNEL_ID}`;
export const LIVE_URL = `https://chzzk.naver.com/live/${CHANNEL_ID}`;
export const COMMUNITY_URL = `${CHANNEL_URL}/community`;
export const REPLAY_LIST_URL = `${CHANNEL_URL}/videos?videoType=REPLAY&sortType=LATEST&page=1`;
export const LIVE_DETAIL_URL =
  `https://api.chzzk.naver.com/service/v2/channels/${CHANNEL_ID}/live-detail`;
export const REPLAY_LIST_API_URL =
  `https://api.chzzk.naver.com/service/v1/channels/${CHANNEL_ID}/videos?videoType=REPLAY&sortType=LATEST&pagingType=PAGE`;
export const VIDEO_DETAIL_API_URL = "https://api.chzzk.naver.com/service/v2/videos";
export const COMMUNITY_API_URL =
  `https://apis.naver.com/nng_main/nng_comment_api/v1/type/CHANNEL_POST/id/${CHANNEL_ID}/comments?limit=10&offset=0&orderType=DESC&pagingType=PAGE`;
export const NOTIFICATION_ACCESS = { permissions: ["notifications"] };
export const COMMUNITY_ACCESS = {
  ...NOTIFICATION_ACCESS,
  origins: ["https://apis.naver.com/*"],
};

// Settings are stored in seconds; Chrome alarms use minutes.
export const INTERVALS = [1, 3, 5, 10, 15].map(minutes => minutes * 60);
export const COMMUNITY_INTERVALS = [30, 45, 60, 90, 120].map(minutes => minutes * 60);
export const CHECK_ALARMS = { live: "check-live", community: "check-community" };
export const DISCORD_CHANNELS = {
  announcements: { name: "공지사항", id: "1307892076490391554" },
  school: { name: "학기중에는-뭐하나요", id: "1465994353670357004" },
};
export function discordPostUrl(source, id) {
  if (!Object.hasOwn(DISCORD_CHANNELS, source) || typeof id !== "string" || !/^[1-9]\d{16,19}$/.test(id)) return null;
  return `https://discord.com/channels/1307892075437494293/${DISCORD_CHANNELS[source].id}/${id}`;
}
export const RESUME_ALARM = "resume-monitoring";
export const COMMUNITY_RETRY_ALARM = "retry-community-connection";
export function discordTime(id) {
  return Number(BigInt(id) >> 22n) + 1420070400000;
}
export const RECOVERY_ALARM = "recover-monitoring";
export const PAUSE_MAX_MINUTES = 360;
export const BROADCAST_MODES = {
  foreground: "방송 화면 자동 열기",
  background: "백그라운드에서 열기",
  notify: "알림만 받기",
};
export const ACTIVITY_LIMIT = 20;
export const DAY_MS = 86_400_000;
const SEOUL_OFFSET = 9 * 3_600_000;

export function seoulWeekStart(now = Date.now()) {
  const localDay = Math.floor((now + SEOUL_OFFSET) / DAY_MS);
  return (localDay - (localDay + 3) % 7) * DAY_MS - SEOUL_OFFSET;
}

export function replayUrl(videoNo) {
  return Number.isSafeInteger(videoNo) && videoNo > 0 ? `https://chzzk.naver.com/video/${videoNo}` : null;
}

export function activityDiscoveryAt(entry) {
  if (entry.historical) return null;
  // For these sources the existing at field is already the first observation.
  if (["live", "missed", "post"].includes(entry.kind)) return entry.at;
  return entry.discoveredAt ?? null;
}

export function communityPublishedAt(created) {
  const parts = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(created);
  return parts && Date.parse(`${parts[1]}-${parts[2]}-${parts[3]}T${parts[4]}:${parts[5]}:${parts[6]}+09:00`);
}

export function activityOccurredAt(entry) {
  if (["live", "missed", "archive"].includes(entry.kind)) {
    return entry.replayOpenedAt ?? entry.openedAt ?? (entry.historical || entry.kind === "archive" ? entry.at : null);
  }
  if (entry.kind === "post") return communityPublishedAt(entry.postCreated) || (entry.historical ? entry.at : null);
  return entry.kind === "discord" ? entry.at : null;
}

function activitySortTime(entry) {
  return activityDiscoveryAt(entry) ?? activityOccurredAt(entry) ?? entry.at;
}

export function compareActivity(left, right) {
  const historical = Number(!!left.historical) - Number(!!right.historical);
  if (historical) return historical;
  const detected = activitySortTime(right) - activitySortTime(left);
  if (detected) return detected;
  if (left.kind === "discord" && right.kind === "discord" && left.postId && right.postId) {
    return right.postId.length - left.postId.length || right.postId.localeCompare(left.postId);
  }
  // Keep simultaneous non-post events together before sorting a batch of posts.
  const postOrder = Number(left.kind === "post") - Number(right.kind === "post");
  if (postOrder) return postOrder;
  if (left.kind !== right.kind) return left.kind.localeCompare(right.kind);
  if (left.kind !== "post") return 0;
  const created = (entry) => /^\d{14}$/.test(entry.postCreated ?? "") ? entry.postCreated : "";
  const published = created(right).localeCompare(created(left));
  if (published) return published;
  // Older versions did not retain the publication time; their post IDs still order a batch.
  const postId = (entry) => Number(/^post-(\d+)$/.exec(entry.id)?.[1]) || 0;
  return postId(right) - postId(left);
}

export const DEFAULT_SETTINGS = {
  enabled: true,
  intervalSeconds: 5 * 60,
  communityIntervalSeconds: 30 * 60,
  broadcastMode: "foreground",
  notifyLive: true,
  notifyMissed: true,
  pausedUntil: null,
};

export function normalizeSettings(settings = {}) {
  return {
    enabled: settings.enabled ?? DEFAULT_SETTINGS.enabled,
    intervalSeconds: INTERVALS.includes(settings.intervalSeconds) ? settings.intervalSeconds : DEFAULT_SETTINGS.intervalSeconds,
    communityIntervalSeconds: COMMUNITY_INTERVALS.includes(settings.communityIntervalSeconds) ? settings.communityIntervalSeconds : DEFAULT_SETTINGS.communityIntervalSeconds,
    broadcastMode: settings.broadcastMode ?? (typeof settings.openInBackground === "boolean"
      ? (settings.openInBackground ? "background" : "foreground") : DEFAULT_SETTINGS.broadcastMode),
    notifyLive: settings.notifyLive !== false,
    notifyMissed: settings.notifyMissed !== false,
    pausedUntil: Number.isSafeInteger(settings.pausedUntil) && settings.pausedUntil > 0 ? settings.pausedUntil : null,
  };
}

export function monitoringActive(settings) {
  return settings.enabled && !settings.pausedUntil;
}

export function noticeEnabled(settings, kind) {
  if (kind === "discord") return true;
  if (kind === "liveOnly") return settings.broadcastMode === "notify";
  if (kind === "live") return settings.broadcastMode === "background" && settings.notifyLive;
  if (kind === "replayRetry") return true; // Requested by clicking a delivered notification.
  return kind === "missed" ? settings.notifyMissed : kind === "post" ? true : settings.notifyLive;
}
