import { createWeeklyCard, replayPartRows, datedListTitle, formatWeekdayDate } from "./weekly.js";
import { showNewsGroup } from "./posts.js";
import {
  BROADCAST_MODES,
  CHANNEL_URL,
  CHECK_ALARMS,
  COMMUNITY_ACCESS,
  COMMUNITY_RETRY_ALARM,
  COMMUNITY_INTERVALS,
  COMMUNITY_URL,
  DEFAULT_SETTINGS,
  DISCORD_CHANNELS,
  discordPostUrl,
  INTERVALS,
  NOTIFICATION_ACCESS,
  RESUME_ALARM,
  RECOVERY_ALARM,
  activityDiscoveryAt,
  activityOccurredAt,
  communityPublishedAt,
  compareActivity,
  replayUrl,
  monitoringActive,
  normalizeSettings,
} from "./config.js";

const elements = Object.fromEntries(
  [...document.querySelectorAll("[id]")].map((element) => [element.id, element]),
);
const dayFormat = new Intl.DateTimeFormat("ko-KR", { month: "numeric", day: "numeric" });
const clockFormat = new Intl.DateTimeFormat("ko-KR", { timeStyle: "medium", hour12: false });
const minuteFormat = new Intl.DateTimeFormat("ko-KR", { timeStyle: "short", hour12: false });
const pageSize = 3;
const preferredDark = matchMedia("(prefers-color-scheme: dark)");
let popupTheme = "auto";
let confirmedTheme = "auto";
let themeVersion = 0;
let themeStorageRevision = 0;
let scheduleRecovery = null;
let schedulesLoaded = false;
let saved = DEFAULT_SETTINGS;
let report = {};
let communityReport = {};
const discordReports = {};
let alarms = [];
let scheduleVersion = 0;
let loaded = false;
let busy = false;
let checking = false;
let checkVersion = 0;
let checkResult = "";
let checkResultTimer;
let pendingCheckFeedback;
let feedbackVersion = 0;
let savedNoticeTimer;
let refreshTimer;
let notificationAccess = false;
let firstNotificationSetup = false;
let notificationLevel;
let communityAccess = false;
let newsScheduleConfirmation;
let changingPermission = false;
let changingNotificationButton = false;
let permissionVersion = 0;
let activityEntries = [];
let weekBroadcasts = [];
const replayChecks = new Map();
const updateWeeklyCard = createWeeklyCard(elements, sendNavigation, applyReplayChecks);
let activityLimit = pageSize;
let permissionSuccess = false;
let testCount = 0;
let notificationRetryAt;
let pendingNotifications = {};
let activityFilter = "all";
const basketButtons = [...elements["news-basket"].querySelectorAll("button[data-source]")];
elements["news-basket"].querySelector('[data-source="post"]').prepend(elements["chzzk-mark"].content.cloneNode(true));
elements["news-basket"].querySelector('[data-source="discord"]').prepend(elements["discord-mark"].content.cloneNode(true));
function selectedBasketButton() {
  return basketButtons.find(button => button.dataset.source === activityFilter);
}
let currentView = "home";
let featureNoticePending = false;
let claimingFeatureNotice = false;

function homeCanShowNotice() {
  return currentView === "home" && !document.hidden && tourStep < 0 &&
    elements["first-notification"].hidden && elements["tour-offer"].hidden;
}

async function showFeatureNotice() {
  if (!featureNoticePending || claimingFeatureNotice || !homeCanShowNotice()) return;
  claimingFeatureNotice = true;
  try {
    // Two open windows can reach Home at the same time.
    await navigator.locks.request("news-basket-feature-notice", async () => {
      const { newsBasketFeatureNotice } = await chrome.storage.local.get("newsBasketFeatureNotice");
      if (newsBasketFeatureNotice !== "pending") { featureNoticePending = false; return; }
      if (!homeCanShowNotice()) return;
      elements["feature-notice"].hidden = false;
      await chrome.storage.local.set({ newsBasketFeatureNotice: "seen" });
      featureNoticePending = false;
    });
  } finally { claimingFeatureNotice = false; }
}
document.addEventListener("visibilitychange", showFeatureNotice);
elements["feature-close"].addEventListener("click", () => {
  elements["feature-notice"].hidden = true;
  elements["nav-home"].focus();
});
elements["feature-activity"].addEventListener("click", () => {
  selectView("activity");
  elements["nav-activity"].focus();
});
let tourPending = false;
let tourStep = -1;
let tourFromSettings = false;
const tourSteps = [
  { view: "home", target: elements.hero, title: "홈에서 추적 상태 보기", text: "고양이 옆에서 방송 상태를 확인해요.\n‘다음 확인’에는 조회까지 남은 시간이 보여요." },
  { view: "settings", target: elements["broadcast-mode"].closest("label"), title: "방송이 시작되면 어떻게 할까요?", text: "기본값은 ‘방송 화면 자동 열기’예요.\n보던 화면에 머물려면 아래에서 골라요.", options: [["탭도 열기", "백그라운드에서 열기"], ["알림만 보기", "알림만 받기"]] },
  { view: "activity", target: elements["week-card"], title: "지난주와 이번 주 방송 발자국", text: "‘지난주’와 ‘이번 주’로 방송한 날을 찾아요.", options: [["발자국", "라이브 또는 공개된 다시보기"], ["필름 숫자", "그날 만든 클립"]] },
  { view: "activity", target: elements["news-basket"], title: "지나간 방송과 새 글 찾기", text: "소식 바구니에서 방송·치지직·디스코드를 눌러 보세요. ‘전체’를 누르면 모든 소식이 다시 보여요.", showEmptyExample: true },
];
let openingLive = false;
let automaticLiveOpening = false;
let openingRevision = 0;
let pauseDraft = null;
let pauseSaving = false;
let resuming = false;
let pauseVersion = 0;
let submittedPause = null;
let pauseDragging = false;
let liveFeedback = null;
let liveFeedbackTimer;
let menuLiveId = null;
let settingsRevision = 0;

function selectView(view) {
  if (view !== "settings" && elements.feedback.dataset.settingsOnly) showFeedback("");
  elements["pause-panel"].open = false;
  if (tourStep >= 0 && view !== tourSteps[tourStep].view) hideTour();
  currentView = view;
  if (view !== "home") elements["feature-notice"].hidden = true;
  elements["home-panel"].hidden = view !== "home";
  elements["activity-panel"].hidden = view !== "activity";
  elements.settings.hidden = view !== "settings";
  elements.settings.open = view === "settings";
  menuLiveId = null;
  elements["live-choices"].hidden = true;
  elements["open-live"].setAttribute("aria-expanded", "false");
  for (const name of ["home", "activity", "settings"]) {
    elements[`nav-${name}`].setAttribute("aria-pressed", String(name === view));
  }
  render();
}
function hideTour() {
  tourSteps[tourStep]?.target.classList.remove("tour-target");
  tourStep = -1;
  elements["tour-card"].hidden = true;
}

function showTourStep(index) {
  hideTour();
  tourStep = index;
  const step = tourSteps[index];
  selectView(step.view);
  const card = elements["tour-card"];
  const before = step.view === "settings" ? elements.controls : step.target;
  before.before(card);
  step.target.classList.add("tour-target");
  elements["tour-heading"].textContent = `${index + 1}/${tourSteps.length} · ${step.title}`;
  elements["tour-description"].textContent = step.text;
  const options = elements["tour-options"];
  options.replaceChildren();
  for (const [label, value] of step.options ?? []) {
    const term = document.createElement("dt"), detail = document.createElement("dd");
    term.textContent = label;
    detail.textContent = value;
    options.append(term, detail);
  }
  options.hidden = !step.options;
  elements["tour-next"].textContent = index === tourSteps.length - 1 ? "마치기" : "다음";
  card.hidden = false;
  elements["tour-heading"].focus();
}

function finishTour() {
  hideTour();
  selectView(tourFromSettings ? "settings" : "home");
  elements[tourFromSettings ? "tour-replay" : "nav-home"].focus();
}

async function dismissTourOffer() {
  if (!tourPending) return true;
  try {
    await chrome.storage.local.remove("tourPending");
    tourPending = false;
    renderPermissionBanner();
    return true;
  } catch {
    showFeedback("둘러보기 선택을 저장하지 못했어요. 다시 시도해 주세요.", true);
    return false;
  }
}

for (const id of ["tour-start", "tour-replay"]) {
  elements[id].addEventListener("click", async () => {
    const view = currentView;
    if (!await dismissTourOffer() || currentView !== view) return;
    tourFromSettings = id === "tour-replay";
    showTourStep(0);
  });
}
elements["tour-dismiss"].addEventListener("click", async () => {
  if (await dismissTourOffer() && currentView === "home") elements["nav-home"].focus();
});
elements["tour-next"].addEventListener("click", () => {
  if (tourStep === tourSteps.length - 1) finishTour();
  else showTourStep(tourStep + 1);
});
elements["tour-skip"].addEventListener("click", finishTour);
for (const view of ["home", "activity", "settings"]) {
  elements[`nav-${view}`].addEventListener("click", () => selectView(view));
}
elements["activity-preview"].addEventListener("click", () => {
  selectView("activity");
  elements["nav-activity"].focus();
});
elements["open-live"].addEventListener("click", () => {
  if (openingLive) return;
  clearTimeout(liveFeedbackTimer);
  liveFeedback = null;
  paintLiveChoice();
  const expanded = elements["live-choices"].hidden;
  menuLiveId = expanded ? report.observedLiveId : null;
  elements["live-choices"].hidden = !expanded;
  elements["open-live"].setAttribute("aria-expanded", String(expanded));
  if (expanded) elements["pause-panel"].open = false;
  if (expanded) elements["open-background"].focus();
});
const dialogOpeners = new Map([
  [elements["roulette-dialog"], elements["open-roulette"]],
  [elements["live-preview"], elements["preview-live"]],
  [elements["reset-dialog"], elements["reset-settings"]],
]);
let dismissedDialogOpener = null;
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
  if (event.repeat && dismissedDialogOpener) {
    event.preventDefault();
    return;
  }
  const dialog = document.querySelector("dialog[open]");
  const opener = dialogOpeners.get(dialog);
  if (opener) {
    event.preventDefault();
    dismissedDialogOpener = opener;
    dialog.close("cancel");
    opener.focus({ preventScroll: true });
    return;
  }
  const atDismissedDialog = dismissedDialogOpener && document.activeElement === dismissedDialogOpener;
  dismissedDialogOpener = null;
  if (!dialog && atDismissedDialog && chrome.extension.getViews({ type: "popup" }).includes(window)) {
    event.preventDefault();
    window.close();
    return;
  }
  if (currentView !== "home" || elements["live-choices"].hidden || dialog) return;
  event.preventDefault();
  elements["live-choices"].hidden = true;
  menuLiveId = null;
  elements["open-live"].setAttribute("aria-expanded", "false");
  elements["open-live"].focus({ preventScroll: true });
});
async function sendNavigation(message) {
  const { id: windowId } = await chrome.windows.getCurrent();
  const result = await chrome.runtime.sendMessage({ ...message, windowId });
  if (message.type === "open-week-replay" && result?.status) {
    applyReplayChecks({ [message.videoNo]: result.status }, result.checkedAt);
  }
  return result;
}

function applyReplayChecks(results, snapshotTime, times = {}) {
  let changed = false;
  for (const [id, status] of Object.entries(results)) {
    const videoNo = Number(id);
    const checkedAt = times[id] ?? snapshotTime;
    const previous = replayChecks.get(videoNo);
    if (previous && previous.checkedAt > checkedAt) continue;
    replayChecks.set(videoNo, { status, checkedAt });
    changed ||= previous?.status !== status;
  }
  if (changed) queueMicrotask(() => renderActivity());
}

async function openLive(background) {
  if (openingLive) return;
  const liveId = menuLiveId;
  if (!liveId || liveId !== report.observedLiveId) return;
  showLine("open-feedback", "");
  clearTimeout(liveFeedbackTimer);
  liveFeedback = null;
  openingLive = true;
  if (background) paintLiveChoice(true);
  else closeLiveChoices();
  render();
  try {
    const result = await sendNavigation({ type: "open-live", liveId, background });
    if (background && menuLiveId !== liveId) return;
    if (!result?.ok) {
      liveFeedback = "다시 시도";
      showFeedback(result?.message ?? "방송 탭을 열 수 없습니다. 다시 시도해 주세요.", true);
    }
    else if (result.destination) showFeedback(result.destination === "replay" ? "방송이 종료되어 해당 다시보기로 연결했어요." : "방송이 종료되어 채널 영상 목록으로 연결했어요.");
    else if (background) {
      liveFeedback = result.openedTab ? "✓ 열기 완료" : "✓ 이미 열려 있음";
      liveFeedbackTimer = setTimeout(() => {
        if (menuLiveId === liveId) closeLiveChoices();
        liveFeedback = null;
        paintLiveChoice();
      }, 1500);
    } else showFeedback("");
  } catch {
    liveFeedback = "다시 시도";
    showFeedback("방송 탭을 열 수 없습니다. 다시 시도해 주세요.", true);
  } finally {
    openingLive = false;
    paintLiveChoice();
    render();
    const trigger = elements["open-live"];
    if (background && currentView === "home" && !trigger.hidden && !trigger.disabled &&
        document.hasFocus() && document.activeElement === document.body) {
      trigger.focus({ preventScroll: true });
    }
  }
}
function paintLiveChoice(pending = false) {
  const button = elements["open-background"];
  button.ariaBusy = String(pending);
  button.setAttribute("aria-label", pending ? "방송 탭 확인 중" : liveFeedback || "백그라운드에서 열기");
  button.querySelector("strong").textContent = liveFeedback || "백그라운드에서 열기";
  button.classList.toggle("action-success", !!liveFeedback?.startsWith("✓"));
}
function closeLiveChoices() {
  const inside = elements["live-choices"].contains(document.activeElement);
  menuLiveId = null;
  elements["live-choices"].hidden = true;
  elements["open-live"].setAttribute("aria-expanded","false");
  if (inside) elements["open-live"].focus({preventScroll:true});
}
elements["open-background"].addEventListener("click", () => void openLive(true));
elements["open-foreground"].addEventListener("click", () => void openLive(false));

elements.channel.href = CHANNEL_URL;
elements.version.textContent = `v${chrome.runtime.getManifest().version}`;
for (const [select, intervals] of [
  [elements.interval, INTERVALS],
  [elements["community-interval"], COMMUNITY_INTERVALS],
]) {
  for (const seconds of intervals) {
    const label = seconds < 60 ? `${seconds}초` : `${seconds / 60}분`;
    select.add(new Option(label, seconds));
  }
}
for (const [mode, label] of Object.entries(BROADCAST_MODES)) {
  elements["broadcast-mode"].add(new Option(label, mode));
}

function setTheme(value) {
  popupTheme = value === "light" || value === "dark" ? value : "auto";
  elements.theme.value = popupTheme;
  const chromeTheme = preferredDark.matches ? "dark" : "light";
  document.documentElement.dataset.theme = popupTheme === "auto" ? chromeTheme : popupTheme;
}

setTheme(popupTheme);
preferredDark.addEventListener("change", () => setTheme(popupTheme));

function showLine(id, text) {
  const element = elements[id];
  if (element.textContent !== text) element.textContent = text;
  element.hidden = !text;
}

function showFeedback(text, error = false, id = "feedback", granted = false) {
  delete elements[id].dataset.replayEntry;
  if (id === "feedback") {
    clearTimeout(savedNoticeTimer);
    delete elements.feedback.dataset.settingsOnly;
    permissionSuccess = granted;
  }
  const line = elements[id];
  line.dataset.error = error;
  line.classList.toggle("action-success", text === "✓ 다시보기 확인 완료");
  if (text && (error || text.length > 23) && ["feedback","check-feedback"].includes(id)) {
    if (line.dataset.detail !== text) {
      const caption = document.createElement("span");
      caption.textContent = text;
      const more = document.createElement("button");
      more.type = "button";
      more.textContent = "자세히";
      more.onclick = () => {
        const dialog = elements["details-dialog"];
        elements["details-title"].textContent = "확인 안내";
        elements["details-message"].textContent = text;
        dialogOpeners.set(dialog, more);
        dialog.showModal();
      };
      line.replaceChildren(caption,more);
      line.dataset.detail = text;
    }
    line.hidden = false;
  } else {
    delete line.dataset.detail;
    showLine(id,text);
  }
  if (id === "feedback") renderOffButton();
}

function showSettingsResult(text, granted = false) {
  showFeedback(text, false, "feedback", granted);
  elements.feedback.dataset.settingsOnly = "true";
  savedNoticeTimer = setTimeout(() => showFeedback(""), 3000);
}

function renderOffButton() {
  elements["disable-notifications"].hidden = !loaded || !notificationAccess || currentView !== "settings" || notificationLevel === "denied";
  elements["disable-notifications"].disabled = busy || changingNotificationButton;
}

function formatTime(value, clock = clockFormat, showYesterday = false) {
  const date = new Date(value);
  const today = new Date();
  let day = "오늘";
  if (date.toDateString() !== today.toDateString()) {
    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1);
    day = showYesterday && date.toDateString() === yesterday.toDateString() ? "어제" : dayFormat.format(date);
  }
  return `${day} ${clock.format(date)}`;
}

function remainingTime(value, now = Date.now()) {
  const seconds = Math.max(0, Math.ceil((value - now) / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds % 3600 / 60);
  const rest = seconds % 60;
  if (!seconds) return "0초 후";
  return `${hours ? `${hours}시간 ` : ""}${minutes ? `${minutes}분 ` : ""}${rest || !minutes ? `${rest}초 ` : ""}후`;
}

function countdownText(value, now) {
  const seconds = Math.max(0, Math.ceil((value - now) / 1000));
  if (seconds <= 60) return `${seconds}초 후`;
  return `${Math.floor(seconds / 60)}분 ${seconds % 60}초 후`;
}

function showCheckTime(id, value, mode = "time") {
  const element = elements[id];
  if (!Number.isFinite(value)) {
    if (element.textContent !== value) element.textContent = value;
    element.removeAttribute("title");
    return;
  }
  const iso = new Date(value).toISOString();
  const time = element.firstElementChild?.dateTime === iso ? element.firstElementChild : document.createElement("time");
  if (time.dateTime !== iso) time.dateTime = iso;
  const lastCheck = mode === "last-check";
  const formatted = formatTime(value, mode === "minute" || lastCheck ? minuteFormat : clockFormat, lastCheck);
  const countdown = mode === "countdown";
  const text = countdown ? countdownText(value, Date.now()) : formatted;
  element.title = countdown ? `예정 시각 · ${formatted} (Chrome 실행 상태에 따라 지연될 수 있습니다)` : formatted;
  if (time.textContent !== text) time.textContent = text;
  if (time.parentNode !== element) element.replaceChildren(time);
}

function nextCheckTime(alarm, retryAt, inactiveText) {
  if (inactiveText) return inactiveText;
  if (!alarm) return "예약 확인 중";
  const period = alarm.periodInMinutes * 60_000;
  const skipped = retryAt > alarm.scheduledTime ? Math.ceil((retryAt - alarm.scheduledTime) / period) : 0;
  return alarm.scheduledTime + skipped * period;
}

async function refreshAlarms() {
  const version = ++scheduleVersion;
  const current = await Promise.all([
    chrome.alarms.get(CHECK_ALARMS.live),
    chrome.alarms.get(CHECK_ALARMS.community),
    chrome.alarms.get(COMMUNITY_RETRY_ALARM),
  ]).catch(() => []);
  if (version === scheduleVersion) {
    alarms = current;
    schedulesLoaded = true;
    render();
  }
}

function renderPermissionBanner() {
  renderOffButton();
  const missing = loaded && !notificationAccess;
  const firstPrompt = missing && firstNotificationSetup === true && currentView === "home" && tourStep < 0;
  elements["tour-offer"].hidden = !loaded || !tourPending || tourStep >= 0 || currentView !== "home" || firstPrompt || changingPermission;
  const blocked = loaded && notificationAccess && notificationLevel === "denied";
  elements["first-notification"].hidden = !firstPrompt;
  void showFeatureNotice();
  elements.hero.hidden = firstPrompt;
  elements["first-allow"].disabled = elements["first-later"].disabled = changingPermission;
  const banner = elements["notification-banner"];
  const on = loaded && notificationAccess && !blocked;
  banner.hidden = !(missing && !firstPrompt) && !blocked && !(on && currentView === "settings");
  banner.dataset.on = String(on);
  showLine("permission-message", blocked ? "Chrome 알림이 차단되어 있어요." : on ? "Chrome 알림 켜짐" : "Chrome 알림 꺼짐");
  elements["allow-notifications"].textContent = changingNotificationButton && missing ? "허용 대기" : "알림 켜기";
  elements["allow-notifications"].disabled = changingPermission;
  elements["allow-notifications"].hidden = !missing;
  elements["notification-help"].hidden = !blocked;
  if (!blocked) {
    elements["notification-guide"].hidden = true;
    elements["notification-help"].setAttribute("aria-expanded", "false");
  }
}

const reduceCardMotion = matchMedia("(prefers-reduced-motion: reduce)");
let cardTurn = null;
reduceCardMotion.addEventListener("change", () => { if (cardTurn) render(); });

function paintHomeCard(state, text) {
  elements.hero.dataset.state = state;
  for (const [index, id] of ["hero-badge", "hero-title", "hero-description"].entries()) {
    if (elements[id].textContent !== text[index]) elements[id].textContent = text[index];
  }
  const mascot = `assets/${state === "live" ? "live" : ["waiting", "paused", "off"].includes(state) ? "paused" : "waiting"}.png`;
  if (elements["hero-mascot"].getAttribute("src") !== mascot) elements["hero-mascot"].src = mascot;
}

function updateHomeCard(state, text, manualToggle) {
  const card = elements.hero;
  const motion = !reduceCardMotion.matches && !card.hidden && currentView === "home";
  if (cardTurn && motion && (cardTurn.state === "off") === (state === "off")) {
    cardTurn.state = state;
    cardTurn.text = text;
    if (cardTurn.swapped) paintHomeCard(state, text);
    return;
  }
  if (cardTurn) {
    cancelAnimationFrame(cardTurn.frame);
    for (const effect of cardTurn.effects) effect.cancel();
  }
  cardTurn = null;
  if (!motion || !manualToggle || card.dataset.state === state) {
    paintHomeCard(state, text);
    return;
  }
  const duration = 900;
  const angle = state === "off" ? 24 : -24;
  const tilt = degrees => ({ transform:`perspective(900px) rotateY(${degrees}deg)`, easing:"ease-in-out" });
  const rotation = card.animate([tilt(0), tilt(angle), tilt(0)], {id:"card-turn-tilt", duration});
  const fades = Array.from(card.children, face => face.animate(
    [{opacity:1}, {opacity:0, offset:.5}, {opacity:1}], {duration, easing:"ease-in-out"}
  ));
  const turn = cardTurn = {state, text, effects:[rotation, ...fades], swapped:false};
  const swapAtMidpoint = () => {
    if (turn !== cardTurn) return;
    if (rotation.currentTime >= duration / 2) {
      turn.swapped = true;
      paintHomeCard(turn.state, turn.text);
    } else turn.frame = requestAnimationFrame(swapAtMidpoint);
  };
  turn.frame = requestAnimationFrame(swapAtMidpoint);
  rotation.onfinish = () => {
    if (turn !== cardTurn) return;
    if (!turn.swapped) paintHomeCard(turn.state, turn.text);
    cardTurn = null;
  };
}

function render() {
  const now = Date.now();
  if (pendingCheckFeedback) refreshCheckFeedback(now);
  const active = monitoringActive(saved);
  const paused = saved.enabled && !!saved.pausedUntil;
  const liveWaiting = now < report.retryAt;
  const communityEnabled = communityAccess;
  const communityWaiting = communityEnabled && now < communityReport.retryAt;
  const newsReports = [communityReport, ...Object.keys(DISCORD_CHANNELS).map(key => discordReports[key] ?? {})];
  const discordWaiting = !communityEnabled ||
    Object.keys(DISCORD_CHANNELS).every(key => now < discordReports[key]?.retryAt);
  const allWaiting = liveWaiting && (!communityEnabled || communityWaiting) && discordWaiting;
  const statusText = { live: "방송 중", offline: "오프라인", unknown: "상태 확인 실패", pending: "현재 상태 확인 중" };
  const heroState = !loaded ? "loading" : paused ? "paused" : !active ? "off" :
    report.status === "live" ? "live" : report.status === "unknown" ? "error" : "waiting";
  const hero = {
    loading: ["준비 중", "추적기를 준비하고 있어요", "저장된 설정을 불러오고 있어요."],
    paused: ["일시 중지", "잠시 쉬고 있어요", saved.pausedUntil > now ? "남은 시간이 끝나면 자동 추적을 재개해요." : "추적 재개를 기다리고 있어요."],
    off: ["추적 꺼짐", "자동 추적이 꺼져 있어요", "자동 추적을 켜면 소식을 확인해요."],
    live: ["LIVE", "유설Seol 방송 중", "방송을 보러 갈까요?"],
    error: ["확인 지연", "방송 상태를 확인하지 못했어요", "아래 오류와 재시도 시간을 확인해 주세요."],
    waiting: ["추적 중", report.status === "offline" ? "방송을 기다리고 있어요" : "방송 상태를 확인하고 있어요", communityEnabled ? "방송 시작과 커뮤니티·디스코드 새 글을 확인하고 있어요." : "유설Seol의 방송 시작을 확인하고 있어요."],
  }[heroState];
  const oldState = cardTurn?.state ?? elements.hero.dataset.state;
  const manualToggle = loaded && oldState !== "loading" && (oldState === "off") !== (heroState === "off") &&
    pendingSettings.get("enabled")?.value === saved.enabled;
  if (resuming && oldState === "paused" && active && currentView === "home" &&
      !matchMedia("(prefers-reduced-motion: reduce)").matches) {
    elements.hero.animate([{opacity:0.65}, {opacity:1}], {duration:240,easing:"ease-out"});
  }
  updateHomeCard(heroState, hero, manualToggle);
  const closeMenu = menuLiveId !== null && (heroState !== "live" || menuLiveId !== report.observedLiveId);
  const restoreFocus = (closeMenu && elements["live-choices"].contains(document.activeElement)) ||
    (heroState !== "live" && document.activeElement === elements["open-live"]);
  if (!elements["open-feedback"].hidden && (heroState !== "live" || elements["open-feedback"].dataset.liveId !== String(report.observedLiveId))) showLine("open-feedback", "");
  elements["open-live"].hidden = heroState !== "live";
  elements["open-live"].disabled = openingLive;
  const openLabel = openingLive ? "여는 중…" : "방송 열기";
  if (elements["open-live"].textContent !== openLabel) elements["open-live"].textContent = openLabel;
  if (heroState !== "live" || closeMenu) {
    menuLiveId = null;
    elements["live-choices"].hidden = true;
    elements["open-live"].setAttribute("aria-expanded", "false");
  }
  elements.status.textContent = paused ? "일시 중지" : active ? (statusText[report.status] ?? "첫 확인 대기 중") : "자동 추적 꺼짐";
  elements.status.dataset.status = active ? (report.status ?? "") : "";
  const notificationBlocked = notificationLevel === "denied";
  renderPermissionBanner();
  elements["allow-community"].hidden = !loaded || communityEnabled;
  const stopped = paused ? "일시 중지" : active ? "" : "추적 꺼짐";
  const communityInactive = stopped || (communityEnabled ? "" : "새 글 추적 꺼짐");
  const communityStatus = stopped || (!communityEnabled ? "알림 꺼짐" :
    newsReports.every(r => r.error) ? "확인 실패" : newsReports.some(r => r.error) ? "일부 확인 실패" :
    notificationBlocked ? "알림 차단됨" : newsReports.every(r => r.initialized) ? "추적 중" : "첫 확인 대기 중");
  elements["community-status"].textContent = communityStatus;
  elements["community-status"].dataset.status = communityStatus === "추적 중" ? "tracking" : "";
  elements["tracking-options"].hidden = !loaded;
  const missedEnabled = pendingSettings.get("notifyMissed")?.value ?? saved.notifyMissed;
  showLine("missed-summary", missedEnabled ? "켜짐" : "꺼짐");
  elements["missed-summary"].dataset.on = String(missedEnabled);
  elements["community-on-label"].hidden = !communityEnabled;
  elements["missed-delay"].hidden = !(active && missedEnabled && notificationAccess && !notificationBlocked && report.status === "unknown" && report.error);
  const [liveAlarm, communityAlarm] = alarms;
  const retryTime = alarms[2]?.scheduledTime;
  const communityRetry = active && communityEnabled && Number.isFinite(retryTime);
  showLine("community-auto-retry", communityRetry && retryTime > now ?
    `치지직 재시도 ${countdownText(retryTime, now)}` : "");
  const missingSchedule = loaded && schedulesLoaded && active && !pendingSettings.has("enabled") &&
    (!liveAlarm || (communityEnabled && !communityAlarm && !changingPermission));
  const recovering = loaded && saved.enabled && (!!scheduleRecovery || missingSchedule);
  elements["schedule-recovery"].hidden = !recovering;
  elements["recover-schedule"].disabled = busy || checking;
  showLine("schedule-recovery-status", !recovering ? "" : scheduleRecovery ?
    `추적 예약을 복구하고 있어요.${Number.isFinite(scheduleRecovery.retryAt) ? ` 다음 복구 시도 · ${formatTime(scheduleRecovery.retryAt)}` : " 지금 복구를 눌러 다시 시도해 주세요."}` :
    "일부 자동 확인 예약을 찾지 못했어요. 지금 복구를 눌러 주세요.");
  if (notificationAccess && !notificationBlocked) elements["test-notification"].removeAttribute("aria-describedby");
  else elements["test-notification"].setAttribute("aria-describedby", "permission-message");
  const latestStart = report.latestOpenedAt ?? Math.max(0, ...activityEntries.filter(e => e.kind === "live" || e.kind === "missed").map(e => e.openedAt || 0));
  showCheckTime("latest-live-at", latestStart || "기록 없음", "minute");
  const created = communityReport.latest?.created ?? activityEntries.find(e => e.kind === "post" && e.postCreated)?.postCreated;
  const postedAt = communityPublishedAt(created);
  const discordDates = Object.values(discordReports).map(r => /^[1-9]\d{16,19}$/.test(r.latestId ?? "")
    ? Number(BigInt(r.latestId) >> 22n) + 1420070400000 : 0).filter(time => time <= now);
  showCheckTime("latest-post-at", Math.max(postedAt || 0, ...discordDates) || "기록 없음", "minute");
  showCheckTime("checked-at", report.checkedAt ?? "기록 없음", "last-check");
  showCheckTime("community-checked-at", Math.max(...newsReports.map(r => r.checkedAt || 0)) || "기록 없음", "last-check");
  const liveNext = recovering && !liveAlarm && !stopped ? "복구 대기" : nextCheckTime(liveAlarm, report.retryAt, stopped);
  const communityNext = recovering && !communityAlarm && !communityInactive ? "복구 대기" : nextCheckTime(communityAlarm, Math.min(...newsReports.map(r => r.retryAt || 0)), communityInactive);
  showCheckTime("live-next-at", liveNext, "countdown");
  showCheckTime("community-next-at", communityNext, "countdown");
  showLine("error", saved.enabled ? (report.error ?? "") : "");
  showLine("live-opening", loaded && active && automaticLiveOpening ? "라이브 탭 여는 중…" : "");
  showLine("last-known", saved.enabled && report.status === "unknown" && Number.isFinite(report.lastKnownAt) &&
    (report.lastKnownStatus === "live" || report.lastKnownStatus === "offline") ?
    `마지막 정상 상태 · ${statusText[report.lastKnownStatus]} (${formatTime(report.lastKnownAt)})` : "");
  showLine("retry-at", active && liveWaiting ? `수동 확인 가능 · ${formatTime(report.retryAt)}부터` : "");
  showLine("community-error", saved.enabled && communityEnabled ? (communityReport.error ?? "") : "");
  showLine(
    "community-retry-at",
    active && communityWaiting ? `수동 확인 가능 · ${formatTime(communityReport.retryAt)}부터` : "",
  );
  const hasNotificationRetry = active && notificationAccess && Number.isFinite(notificationRetryAt);
  showLine("notification-retry-at", !hasNotificationRetry ? "" : now < notificationRetryAt ?
    `다음 알림 재시도 · ${formatTime(notificationRetryAt)}` : "알림 재시도 대기 중…");

  const disableSettings = !loaded || busy;
  if (elements.controls.disabled !== disableSettings) elements.controls.disabled = disableSettings;
  elements.enabled.disabled = !loaded || busy;
  for (const id of ["pause-minutes", "pause-entry", "resume"]) elements[id].disabled = !loaded || busy || !saved.enabled;
  renderPauseSlider(now);
  elements["pause-notice"].hidden = !paused && !resuming;
  showLine("pause-status", resuming ? "추적을 재개하고 있어요…" : !paused ? "" : saved.pausedUntil > now ?
    `일시 중지 중 · ${formatTime(saved.pausedUntil)}에 재개` : "재개 대기 중…");
  elements["allow-notifications"].disabled = !loaded || busy || changingNotificationButton;
  elements["allow-community"].disabled = !loaded || busy || changingPermission;
  elements.community.disabled = !loaded || busy;
  elements.community.setAttribute("aria-disabled", String(changingPermission || elements.community.disabled));
  elements.check.disabled = !loaded || busy || !active;
  elements.check.ariaDisabled = checking || allWaiting ? "true" : null;
  elements.check.ariaBusy = checking ? "true" : null;
  if (restoreFocus && currentView === "home") {
    const target = heroState === "live" && !openingLive ? elements["open-live"] :
      elements.check.disabled || checking || allWaiting ? elements["nav-home"] : elements.check;
    target.focus({ preventScroll: true });
  }
  const complete = active && !checking && !allWaiting && (checkResult === "complete" || checkResult === "returning");
  elements.check.classList.toggle("check-complete", complete);
  elements.check.classList.toggle("check-returning", complete && checkResult === "returning");
  const checkLabel = checking ? "확인 중…" : active && allWaiting ? "재시도 대기" :
    complete ? "확인 완료" : active && checkResult === "failed" ? "다시 시도" : "지금 확인";
  if (elements["check-caption"].textContent !== checkLabel) elements["check-caption"].textContent = checkLabel;
  for (const id of ["notify-live", "notify-missed"]) elements[id].disabled = !loaded || busy;
  const failedChannels = Object.entries(DISCORD_CHANNELS).filter(([key]) => discordReports[key]?.error).map(([, channel]) => channel.name);
  showLine("discord-state", active && communityEnabled && failedChannels.length ?
    "디스코드 " + failedChannels.join(", ") + " 조회 실패 · 자동으로 다시 확인해요." : "");
  elements["background-banner-option"].hidden = false;
  elements["notify-live"].disabled ||= saved.broadcastMode !== "background";
  elements["notify-live"].checked = pendingSettings.get("notifyLive")?.value ?? saved.notifyLive;
  elements["test-notification"].disabled = !loaded || busy || !notificationAccess || notificationBlocked;
  elements["reset-settings"].disabled = !loaded || busy || pauseSaving;

  clearTimeout(refreshTimer);
  // Expiry is still meaningful while monitoring is off; refresh only the UI.
  const nextExpiry = Math.min(Infinity, ...Object.entries(pendingNotifications)
    .map(([id, pending]) => notificationExpiry(id, pending)).filter((time) => time > now));
  // Relative dates can change even when monitoring and notification retries are off.
  const nextDay = new Date(now);
  nextDay.setHours(24, 0, 0, 0);
  const deadlines = [nextExpiry, nextDay.getTime(), saved.pausedUntil];
  if (active) {
    deadlines.push(report.retryAt, hasNotificationRetry && notificationRetryAt);
    if (communityEnabled) deadlines.push(...newsReports.map(r => r.retryAt), retryTime);
  }
  const nextChange = Math.min(...deadlines.filter(time => time > now));
  if (loaded && currentView === "home") {
    // An alarm or storage event replaces this timer and its captured schedule.
    const clocks = [["live-next-at", liveNext], ["community-next-at", communityNext]]
      .filter(([, value]) => Number.isFinite(value));
    function tick(time) {
      if (time >= nextChange || time < now) return render();
      for (const [id, value] of clocks) {
        const label = elements[id].firstElementChild;
        const text = countdownText(value, time);
        if (label.textContent !== text) label.textContent = text;
      }
      if (communityRetry && time < retryTime) {
        const text = `치지직 재시도 ${countdownText(retryTime, time)}`;
        if (elements["community-auto-retry"].textContent !== text) elements["community-auto-retry"].textContent = text;
      }
      if (paused && time !== now) renderPauseSlider(time);
      const ticking = clocks.some(([, value]) => value > time) || retryTime > time && communityRetry || saved.pausedUntil > time;
      refreshTimer = setTimeout(() => tick(Date.now()), Math.min(ticking ? 1000 : Infinity, nextChange - time));
    }
    tick(now);
  } else if (loaded && currentView === "activity") {
    refreshTimer = setTimeout(render, Math.min(nextChange - now, active || paused ? 1000 : 60_000));
  }
  renderActivity();
}

function setForm(settings) {
  settingsRevision++;
  saved = normalizeSettings(settings);
  if (!monitoringActive(saved)) clearCheckFeedback();
  syncFormControls();
}

function syncFormControls() {
  elements.enabled.checked = pendingSettings.get("enabled")?.value ?? saved.enabled;
  elements.interval.value = pendingSettings.get("intervalSeconds")?.value ?? saved.intervalSeconds;
  elements["community-interval"].value = pendingSettings.get("communityIntervalSeconds")?.value ?? saved.communityIntervalSeconds;
  elements["broadcast-mode"].value = pendingSettings.get("broadcastMode")?.value ?? saved.broadcastMode;
  const modeHelp = {
    foreground: "방송 탭을 앞으로 가져오고, 없으면 새로 열어요.",
    background: "보던 화면을 유지하고, 방송 탭이 없을 때만 열어요.",
    notify: "Chrome 알림을 누르면 방송이 열려요.",
  };
  showLine("broadcast-mode-help", modeHelp[elements["broadcast-mode"].value] ?? "");
  elements["notify-missed"].checked = pendingSettings.get("notifyMissed")?.value ?? saved.notifyMissed;
}

function createReplayButton(id) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "text-button activity-replay";
  button.textContent = "다시보기";
  const status = document.createElement("p");
  status.className = "replay-feedback";
  status.id = "replay-feedback-" + id;
  status.setAttribute("role", "status");
  button.setAttribute("aria-describedby", status.id);
  button.addEventListener("click", async () => {
    if (button.hasAttribute("aria-disabled")) return;
    status.textContent = "";
    delete status.dataset.replayEntry;
    button.setAttribute("aria-disabled", "true");
    button.ariaBusy = "true";
    delete status.dataset.success;
    button.setAttribute("aria-label", "다시보기 확인 중");
    try {
      const videoNo = activityEntries.find(entry => entry.id === id)?.replayVideoNo;
      const result = await sendNavigation(replayUrl(videoNo) ? { type: "open-week-replay", videoNo } : { type: "open-missed", id });
      if (!result?.ok) {
        status.textContent = result?.message ?? "다시보기를 열 수 없습니다. 다시 시도해 주세요.";
        if (result?.status) {
          status.dataset.replayEntry = id;
          renderActivity();
        }
      } else {
        status.dataset.success = "true";
        status.textContent = result.destination === "list" ? "채널 영상 목록을 열었어요." : "✓ 다시보기 확인 완료";
      }
    } catch {
      status.textContent = "다시보기를 열 수 없습니다. 다시 시도해 주세요.";
    } finally {
      button.removeAttribute("aria-disabled");
      button.removeAttribute("aria-label");
      button.ariaBusy = "false";
      button.textContent = "다시보기";
    }
  });
  return { button, status };
}

function activityType(entry) {
  if (entry.kind === "archive" || entry.kind === "live" && entry.historical) return "ended";
  if (entry.kind === "discord") return "post";
  if (entry.kind !== "live") return entry.kind;
  const same = entry.id === `live-${report.observedLiveId}`;
  if (same && monitoringActive(saved) && report.status === "live") return "live";
  const status = ["unknown", "pending"].includes(report.status) ? report.lastKnownStatus : report.status;
  return status === "offline" || (report.observedLiveId && !same) ? "ended" : "unknown";
}

function createActivityRow(entry) {
  const row = document.createElement("li");
  row.dataset.id = entry.id;
  row.dataset.type = entry.kind;
  const post = entry.kind === "post" && /^post-([1-9]\d{0,15})$/.exec(entry.id);
  const discordUrl = entry.kind === "discord" && discordPostUrl(entry.source, entry.postId);
  const archive = entry.kind === "archive";
  const title = document.createElement("strong");
  const action = post || discordUrl ? document.createElement("a") : archive || entry.kind === "live" ? document.createElement("button") : null;
  if (action) {
    if (post || discordUrl) {
      action.href = discordUrl || `${COMMUNITY_URL}/detail/${post[1]}`;
      action.target = "_blank";
      action.rel = "noopener noreferrer";
    } else {
      action.type = "button";
    }
    action.className = "activity-action";
    action.textContent = archive ? "다시보기" : post || discordUrl ? "게시글 열기" : "라이브 열기";
    action.addEventListener("click", (event) => {
      if (discordUrl) return;
      if (archive) {
        if (action.ariaBusy === "true") return;
        action.ariaBusy = "true";
        action.setAttribute("aria-label","다시보기 확인 중");
        const videoNo = activityEntries.find(item => item.id === entry.id)?.replayVideoNo;
        void sendNavigation({ type: "open-week-replay", videoNo, background: event.ctrlKey || event.metaKey }).then(result => {
          if (!result?.ok) {
            showFeedback(result?.message ?? "다시보기를 열 수 없습니다.", true);
            if (result?.status) {
              elements.feedback.dataset.replayEntry = entry.id;
              renderActivity();
            }
          } else showFeedback("✓ 다시보기 확인 완료");
        }).catch(() => showFeedback("다시보기를 열 수 없습니다.", true)).finally(() => {
          action.ariaBusy = "false";
          action.removeAttribute("aria-label");
        });
        return;
      }
      const background = event.ctrlKey || event.metaKey;
      if (post && (background || event.shiftKey || event.altKey)) return;
      event.preventDefault();
      showFeedback("");
      void sendNavigation(post ? { type: "open-post", id: post[1] } : { type: "open-activity-live", id: entry.id, background }).then((result) => {
        if (!result?.ok) showFeedback(result?.message ?? "대상 탭을 열 수 없습니다.", true);
      }).catch(() => showFeedback("대상 탭을 열 수 없습니다.", true));
    });
  }
  if (entry.kind === "failure") {
    title.className = "failure";
    const source = { live: "방송", liveOnly: "방송", missed: "놓친 방송", replayRetry: "다시보기 재시도 안내", post: "새 글", discord: "디스코드" }[entry.noticeKind];
    title.textContent = source ? `${source} 알림 실패` : "알림 실패";
  } else {
    title.textContent = entry.kind === "discord" ? "디스코드 · " + (DISCORD_CHANNELS[entry.source]?.name ?? "새 글") :
      { archive: "지난 방송", live: "방송 시작", missed: "놓친 방송", post: "치지직 커뮤니티 글" }[entry.kind];
  }
  if (entry.kind === "discord" || entry.kind === "post") {
    const mark = elements[entry.kind === "discord" ? "discord-mark" : "chzzk-mark"];
    const icon = mark.content.firstElementChild.cloneNode(true);
    icon.classList.add("source-icon");
    title.prepend(icon);
  }
  const copy = document.createElement("div");
  copy.className = "activity-copy";
  const meta = document.createElement("div");
  meta.className = "activity-meta";
  const originalTime = document.createElement("small");
  originalTime.className = "activity-original-time";
  originalTime.hidden = true;
  meta.append(title, originalTime);
  copy.append(meta);
  const heading = document.createElement("h3");
  heading.className = "activity-group";
  heading.hidden = true;
  const line = document.createElement("div");
  line.className = "activity-line";
  line.append(document.createElement("time"), copy);
  row.append(heading, line);
  if (action) line.append(action);
  if (["archive", "live", "missed"].includes(entry.kind)) {
    const availability = document.createElement("small");
    availability.className = "replay-availability";
    availability.hidden = true;
    line.append(availability);
  }
  if (entry.kind === "missed" || entry.kind === "live") {
    const { button, status } = createReplayButton(entry.id);
    line.append(button);
    copy.append(status);
  }
  const detail = document.createElement("small");
  detail.className = "activity-detail";
  detail.id = `detail-${entry.id}`;
  if (entry.kind === "failure") copy.append(detail);
  else copy.prepend(detail);
  if (entry.kind !== "failure") {
    const expand = document.createElement("button");
    expand.type = "button";
    expand.className = "text-button title-toggle";
    expand.textContent = "제목 펼치기";
    expand.setAttribute("aria-expanded", "false");
    expand.setAttribute("aria-controls", detail.id);
    expand.addEventListener("click", () => {
      const expanded = row.dataset.expanded !== "true";
      row.dataset.expanded = String(expanded);
      expand.setAttribute("aria-expanded", String(expanded));
      expand.textContent = expanded ? "제목 접기" : "제목 펼치기";
    });
    copy.append(expand);
  }
  if (entry.kind === "missed" || entry.kind === "live") {
    const status = document.createElement("small");
    status.className = "replay-fallback";
    status.hidden = true;
    copy.append(status);
  }
  return row;
}

function updateActivityParts(row, button, entry) {
  let list = row.querySelector(".activity-parts");
  if (!list && entry.replayParts?.length > 1) {
    list = document.createElement("div");
    list.className = "activity-parts";
    list.id = "parts-" + entry.id;
    list.hidden = true;
    const dialog = document.createElement("dialog");
    dialog.className = "selection-dialog";
    const heading = document.createElement("h2");
    heading.id = "heading-" + list.id;
    dialog.setAttribute("aria-labelledby", heading.id);
    const header = document.createElement("div");
    header.className = "section-heading";
    const close = document.createElement("button");
    close.type = "button";
    close.textContent = "닫기";
    close.className = "parts-close";
    close.onclick = () => dialog.close();
    header.append(heading, close);
    dialog.append(header, list);
    row.append(dialog);
    button.setAttribute("aria-haspopup","dialog");
    dialog.addEventListener("keydown", event => {
      if (event.key === "Escape") {event.preventDefault();dialog.close();}
    });
    dialog.addEventListener("close", () => {
      list.hidden = true;
      if (button.hasAttribute("aria-expanded")) button.setAttribute("aria-expanded","false");
      if (button.isConnected && !button.hidden) button.focus({preventScroll:true});
    });
    button.addEventListener("click", event => {
      if (!button.hasAttribute("aria-expanded")) return;
      event.stopImmediatePropagation();
      list.hidden = !list.hidden;
      button.setAttribute("aria-expanded", String(!list.hidden));
      if (!list.hidden) {
        dialog.showModal();
        (list.querySelector("button:enabled") || close).focus();
      } else dialog.close();
    }, true);
  }
  if (!list) return;
  if (entry.replayParts?.length < 2 || !entry.replayParts || button.hidden) {
    if (list.parentElement.open) list.parentElement.close();
    list.hidden = true;
    button.removeAttribute("aria-expanded");
    button.removeAttribute("aria-controls");
    return;
  }
  button.setAttribute("aria-expanded", String(!list.hidden));
  button.setAttribute("aria-controls", list.id);
  const start = entry.replayOpenedAt ?? entry.openedAt ?? entry.replayParts[0].openedAt;
  list.parentElement.querySelector("h2").textContent = datedListTitle(start, "다시보기", entry.replayParts.length);
  const signature = JSON.stringify([start, ...entry.replayParts.map(p => [p, replayChecks.get(p.videoNo)?.status])]);
  if (signature === list.dataset.signature) return;
  const focused = list.contains(document.activeElement) && document.activeElement.dataset.item;
  list.dataset.signature = signature;
  const open = async part => {
    try {
      const result = await sendNavigation({type: "open-week-replay", videoNo: part.videoNo});
      if (list.parentElement.open) list.parentElement.close();
      showFeedback(result?.ok ? "✓ 다시보기 확인 완료" : result?.message || "다시보기를 열 수 없어요.", !result?.ok);
    } catch { if (list.parentElement.open) list.parentElement.close(); showFeedback("다시보기를 열 수 없어요.", true); }
  };
  list.replaceChildren(...replayPartRows(entry.replayParts, start, open, replayChecks));
  if (focused) (list.querySelector(`button:enabled[data-item="${focused}"]`) ?? button).focus();
}

function notificationExpiry(id, pending) {
  // Use the same legacy timestamp fallback as the notification sender.
  const createdAt = pending.createdAt ?? activityEntries.find((item) => item.id === id)?.at ??
    activityEntries.find((item) => item.id === `failure-${id}`)?.at ?? pending.retryAt;
  return Number.isFinite(createdAt) ? createdAt + 86_400_000 : NaN;
}

function failureStatus(entry) {
  const reasons = { deadline: "24시간 경과", "broadcast-ended": "방송 종료 또는 변경" };
  if (entry.outcome === "opened") return "다시보기를 열었습니다 · 추가 안내 종료";
  if (entry.outcome === "sent" || entry.recovered) return "재시도 성공";
  if (entry.outcome === "expired") return `발송 종료${reasons[entry.endReason] ? ` · ${reasons[entry.endReason]}` : ""}`;
  if (entry.outcome === "cancelled") return entry.endReason === "type-disabled" ? "발송 취소 · 해당 알림을 껐습니다" : "발송 취소 · 새 글 알림을 다시 켜면 새 글부터 확인합니다";
  if (!loaded) return "알림 상태 확인 중";
  const id = entry.id.replace(/^failure-/, "");
  const pending = pendingNotifications[id];
  if (!pending) return "이전 실패 기록 · 대기 중인 발송 없음";
  const expiresAt = notificationExpiry(id, pending);
  if (Date.now() >= expiresAt) return "발송 종료 · 24시간 경과";
  const needsLiveCheck = pending.kind === "live" || pending.kind === "liveOnly";
  const retryAt = Math.max(pending.retryAt, needsLiveCheck ? report.retryAt ?? 0 : 0);
  const noRetry = "재시도 없음 · 다음 시도가 발송 기한 이후입니다";
  if (retryAt >= expiresAt) return noRetry;
  if (!saved.enabled) return "일시 중단 · 기한 내 자동 추적을 켜면 재개합니다";
  if (saved.pausedUntil) return "일시 중단 · 기한 내 추적이 재개되면 다시 시도합니다";
  if (!notificationAccess) return "일시 중단 · Chrome 알림을 허용해 주세요";
  if (notificationLevel === "denied") return "Chrome에서 차단 · 알림 설정 확인 필요";
  if (!Number.isFinite(notificationRetryAt)) return "재시도 일정 확인 중";
  const plannedAt = Math.max(retryAt, notificationRetryAt);
  return plannedAt >= expiresAt ? noRetry : `재시도 예약됨 · ${formatTime(plannedAt)}`;
}

const activityClock = new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const shortActivityDate = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Seoul", month: "numeric", day: "numeric" });
const activityDay = ms => Math.floor((ms + 9 * 3600000) / 86400000);

function activityTimeLabels(entry) {
  const broadcast = ["live", "missed", "archive"].includes(entry.kind);
  const occurred = activityOccurredAt(entry);
  const discovery = activityDiscoveryAt(entry);
  const at = discovery ?? occurred ?? entry.at;
  const format = ms => (activityDay(ms) === activityDay(Date.now()) ? "오늘" : formatWeekdayDate(ms)) + " " + activityClock.format(ms);
  const eventLabel = broadcast ? "방송 시작" : "작성";
  const primary = format(at) + (discovery != null ? " 발견" : occurred != null ? " " + eventLabel : "");
  const showOriginal = occurred != null && discovery != null &&
    (entry.kind === "missed" || Math.floor(occurred / 60000) !== Math.floor(discovery / 60000));
  const original = entry.historical && occurred != null ? activityClock.format(occurred) + " " + eventLabel :
    showOriginal ? format(occurred) + " " + eventLabel : "";
  return { at, primary, original };
}

function renderActivity(entries = activityEntries) {
  elements["tour-example"].hidden = !tourSteps[tourStep]?.showEmptyExample || entries.length > 0;
  entries = [...entries].sort(compareActivity);
  activityEntries = entries;
  updateWeeklyCard(currentView === "activity", { entries, broadcasts: weekBroadcasts, report, settings: saved, replayChecks });
  const list = elements["activity-list"];
  const focused = list.contains(document.activeElement) ? document.activeElement : null;
  const focusedId = focused?.closest("li")?.dataset.id;
  const errors = elements["basket-errors"];
  const errorCount = entries.filter(entry => entry.kind === "failure").length;
  const errorHadFocus = document.activeElement === errors;
  errors.hidden = errorCount === 0;
  if (errorCount) {
    const label = `알림 오류 ${errorCount}건`;
    if (errors.textContent !== label) errors.textContent = label;
  } else if (activityFilter === "failure") {
    activityFilter = "all";
    activityLimit = pageSize;
  }
  for (const button of basketButtons) {
    const pressed = String(button.dataset.source === activityFilter);
    if (button.getAttribute("aria-pressed") !== pressed) button.setAttribute("aria-pressed", pressed);
  }
  if (!errorCount && errorHadFocus) selectedBasketButton().focus({ preventScroll: true });
  const matches = (entry) => {
    if (activityFilter === "broadcast") return ["live", "missed", "archive"].includes(entry.kind);
    return activityFilter === "all" || entry.kind === activityFilter;
  };
  const trackedVideos = new Set(entries.filter(e => ["live","missed"].includes(e.kind)).map(e => e.replayVideoNo).filter(Boolean));
  const seenArchive = new Set();
  const duplicates = new Set();
  for (const e of entries) if (e.kind === "archive" && e.replayVideoNo) {
    if (trackedVideos.has(e.replayVideoNo) || seenArchive.has(e.replayVideoNo)) duplicates.add(e.id);
    seenArchive.add(e.replayVideoNo);
  }
  const latest = entries.find(entry => !duplicates.has(entry.id));
  const preview = latest ? `${({ live: latest.historical ? "지난 방송" : "방송 시작", archive: "지난 방송", missed: "놓친 방송", post: "치지직 커뮤니티 글", discord: "디스코드 글", failure: "알림 실패" })[latest.kind]} · ${activityTimeLabels(latest).primary}` : "기록된 활동이 없습니다.";
  if (elements["activity-summary"].textContent !== preview) elements["activity-summary"].textContent = preview;
  const filtered = entries.filter(e => !duplicates.has(e.id) && matches(e));
  const focusedIndex = filtered.findIndex((entry) => entry.id === focusedId);
  activityLimit = Math.max(activityLimit, focusedIndex + 1);
  let shown = 0;
  let previousGroup;
  const today = activityDay(Date.now());
  // Older entries without a discovery timestamp must not label their publication time as discovery.
  const mixedDays = new Set(filtered.filter(entry => !entry.historical && activityDiscoveryAt(entry) == null)
    .map(entry => activityDay(activityOccurredAt(entry) ?? entry.at)));

  const current = new Map([...list.children].map((row) => [row.dataset.id, row]));
  for (const [index, entry] of entries.entries()) {
    const row = current.get(entry.id) ?? createActivityRow(entry);
    const type = activityType(entry);
    row.dataset.type = type;
    if (entry.kind === "live") {
      const live = type === "live";
      const ended = type === "ended";
      row.querySelector(".activity-action").hidden = !live;
      row.querySelector(".activity-replay").hidden = !ended;
      row.querySelector("strong").textContent = live ? "방송 시작" : ended ? "종료된 방송" : "방송 시작 · 현재 상태 미확인";
    }
    const availability = row.querySelector(".replay-availability");
    if (availability) {
      const hasReplayAction = ["ended", "missed"].includes(type);
      const status = entry.replayVideoNo ? replayChecks.get(entry.replayVideoNo)?.status ?? "checking" : null;
      const help = { unavailable: "다시보기 시청 불가", unknown: "다시보기 확인 못함", checking: "다시보기 확인 중" }[status];
      if (status === "public") {
        if (elements.feedback.dataset.replayEntry === entry.id) showFeedback("");
        const error = row.querySelector(".replay-feedback");
        if (error?.dataset.replayEntry === entry.id) {
          error.textContent = "";
          delete error.dataset.replayEntry;
        }
      }
      availability.textContent = hasReplayAction && help ? help : "";
      availability.hidden = !availability.textContent;
      const button = row.querySelector(entry.kind === "archive" ? ".activity-action" : ".activity-replay");
      button.hidden = !hasReplayAction || !!help || (entry.kind === "archive" && !entry.replayVideoNo);
      updateActivityParts(row, button, entry);
    }
    current.delete(entry.id);
    const included = !duplicates.has(entry.id) && matches(entry);
    row.hidden = !included || shown >= activityLimit;
    if (included) shown++;
    const detail = row.querySelector(".activity-detail");
    const text = entry.kind === "failure" ? failureStatus(entry) : ["ended", "missed"].includes(type) ? entry.replayTitle || entry.title : entry.title;
    if (detail.textContent !== (text ?? "")) detail.textContent = text ?? "";
    detail.hidden = !text;
    const expand = row.querySelector(".title-toggle");
    if (expand) expand.hidden = !text || text.length <= 36;
    const replayStatus = row.querySelector(".replay-fallback");
    if (replayStatus) {
      const reasons = {
        "not-found": "공개 다시보기 확인 안 됨 · 채널 영상 목록 열림",
        "lookup-failed": "다시보기 조회 실패 · 채널 영상 목록 열림",
        "broadcast-unknown": "방송 시작 시각 확인 안 됨 · 채널 영상 목록 열림",
      };
      const fallback = reasons[entry.replayFallback] ?? "";
      if (replayStatus.textContent !== fallback) replayStatus.textContent = fallback;
      replayStatus.hidden = !fallback;
    }
    const time = row.querySelector("time");
    const labels = activityTimeLabels(entry);
    const iso = new Date(labels.at).toISOString();
    if (time.dateTime !== iso) {
      time.dateTime = iso;
    }
    const date = shortActivityDate.format(labels.at).replace("/", ".");
    const clock = entry.historical ? date : activityClock.format(labels.at);
    if (time.textContent !== clock) time.textContent = clock;
    time.setAttribute("aria-label", labels.primary);
    const day = activityDay(labels.at);
    const group = entry.historical ? "history" : day;
    const heading = row.querySelector(".activity-group");
    heading.hidden = row.hidden || previousGroup === group;
    if (!heading.hidden) {
      const prefix = day === today ? "오늘" : day === today - 1 ? "어제" : formatWeekdayDate(labels.at);
      const label = entry.historical ? "설치 전 소식" : prefix + (mixedDays.has(day) ? " 활동" : " 발견한 소식");
      if (heading.textContent !== label) heading.textContent = label;
      heading.classList.toggle("historical", !!entry.historical);
    }
    if (!row.hidden) previousGroup = group;
    const originalTime = row.querySelector(".activity-original-time");
    if (originalTime.textContent !== labels.original) originalTime.textContent = labels.original;
    originalTime.hidden = !labels.original;
    if (list.children[index] !== row) list.insertBefore(row, list.children[index] ?? null);
  }
  for (const row of current.values()) row.remove();
  list.hidden = !filtered.length;
  elements["activity-empty"].hidden = !!filtered.length;
  elements["activity-empty"].textContent = !entries.length ? "아직 발견한 소식이 없어요" : "아직 이 바구니에 담긴 소식이 없어요";
  elements["activity-empty"].classList.toggle("first-empty", !entries.length);
  const more = elements["activity-more"];
  more.hidden = filtered.length <= activityLimit;
  const moreLabel = `더 보기 · ${Math.min(pageSize, filtered.length - activityLimit)}건`;
  if (!more.hidden && more.textContent !== moreLabel) more.textContent = moreLabel;
  if (focused && (focused.closest("[hidden]") || document.activeElement !== focused)) {
    const row = focused.closest("li");
    const replacement = row?.querySelector(".activity-action:not([hidden]), .activity-replay:not([hidden])");
    const target = !focused.isConnected && list.contains(document.activeElement) ? document.activeElement : focused.isConnected && !row?.hidden ? (focused.closest("[hidden]") ? replacement : focused) : null;
    (target ?? selectedBasketButton()).focus({ preventScroll: true });
  }
}

async function refreshSavedSettings() {
  const revision = settingsRevision;
  const state = await chrome.storage.local.get("settings");
  // A storage event received during this read is newer than its snapshot.
  if (revision === settingsRevision) setForm(state.settings);
}

function preserveSettingFocus() {
  // With a keyboard-operated picker, the focused element can still be an option.
  const control = document.activeElement?.closest("select, input");
  if (!control || !document.hasFocus()) return;

  const pending = new AbortController();
  const cancel = () => pending.abort();
  const options = { capture: true, signal: pending.signal };
  document.addEventListener("pointerdown", cancel, options);
  document.addEventListener("focusin", event => {
    if (!control.contains(event.target) && event.target !== document.body) cancel();
  }, options);
  window.addEventListener("blur", cancel, { signal: pending.signal });
  return () => {
    // Let Chrome finish closing its picker, including a save that resolved in the same frame.
    requestAnimationFrame(() => {
      const untouched = !pending.signal.aborted;
      cancel();
      if (!untouched || !document.hasFocus() || control.matches(":disabled") || !control.getClientRects().length) return;
      if (document.activeElement === document.body || control.contains(document.activeElement)) {
        control.focus({ preventScroll: true });
      }
    });
  };
}

function clearCheckFeedback() {
  pendingCheckFeedback = null;
  ++checkVersion;
  clearTimeout(checkResultTimer);
  checking = false;
  checkResult = "";
  showFeedback("", false, "check-feedback");
}

function showCheckStatuses(checks, includeCommunity) {
  const labels = { complete: "확인 완료", failed: "확인 실패", waiting: "재시도 대기", available: "재시도 가능", off: "꺼짐", cancelled: "확인 취소" };
  const parts = [`방송 ${labels[checks.live]}`];
  if (includeCommunity) parts.push(`커뮤니티 ${labels[checks.community]}`);
  if (communityAccess) {
    const statuses = Object.keys(DISCORD_CHANNELS).map(key => checks[key]);
    const status = statuses.includes("failed") ? "failed" : statuses.find(value => value !== "complete") ?? "complete";
    parts.push(`디스코드 ${labels[status]}`);
  }
  showFeedback(parts.join(" · "), Object.values(checks).includes("failed"), "check-feedback");
}

function refreshCheckFeedback(now) {
  const { checks, startedAt, includeCommunity } = pendingCheckFeedback;
  const reports = { live: report, community: communityReport, ...discordReports };
  const visible = { ...checks };
  for (const [source, status] of Object.entries(checks)) {
    if (status === "off" || status === "cancelled") continue;
    const latest = reports[source];
    if (latest?.checkedAt >= startedAt) {
      visible[source] = latest.error ? "failed" : "complete";
    } else if (status === "waiting" && latest?.retryAt <= now) {
      visible[source] = "available";
    }
  }
  const unresolved = Object.values(visible).some(status => status === "failed" || status === "waiting" || status === "available");
  if (unresolved) showCheckStatuses(visible, includeCommunity);
  else {
    pendingCheckFeedback = null;
    checkResult = "";
    showFeedback("", false, "check-feedback");
  }
}

async function send(message, progress, success) {
  const isCheck = message.type === "check";
  const startedAt = isCheck ? Date.now() : null;
  const checkId = isCheck ? ++checkVersion : null;
  const restoreFocus = message.type === "save" ? preserveSettingFocus() : undefined;
  const updatesSettings = ["save", "pause", "reset-settings"].includes(message.type);
  const communityAtStart = communityAccess;
  const feedback = isCheck ? "check-feedback" : "feedback";
  const resultDialog = ["test-notification", "reset-settings"].includes(message.type);
  const settingSave = message.type === "save";
  const displayResult = (text, error = false) => {
    if (!resultDialog) {
      showFeedback(text, error, feedback);
      if (message.type === "save" && !error) savedNoticeTimer = setTimeout(() => showFeedback(""), 3000);
      return;
    }
    const dialog = elements["details-dialog"];
    const resetComplete = message.type === "reset-settings" && !error;
    elements["details-title"].textContent = resetComplete ? text : message.type === "test-notification" ? "테스트 알림" : "설정 초기화";
    elements["details-message"].textContent = resetComplete ? "" : text;
    dialogOpeners.set(dialog, elements[message.type]);
    if (!dialog.open) dialog.showModal();
  };
  if (isCheck) {
    pendingCheckFeedback = null;
    clearTimeout(checkResultTimer);
    checkResult = "";
    checking = true;
  } else if (!settingSave) busy = true;
  const feedbackId = feedback === "feedback" ? ++feedbackVersion : feedbackVersion;
  if (!resultDialog && !settingSave) showFeedback(progress, false, feedback);
  render();
  // The minimum applies to the button animation, never to the lookup or its alarm.
  const minimumDisplay = isCheck ? new Promise(resolve => setTimeout(resolve, 1000)) : null;
  try {
    const result = await chrome.runtime.sendMessage(message);
    if (isCheck) {
      await refreshAlarms();
      await minimumDisplay;
      if (checkId !== checkVersion) return;
    }
    if (updatesSettings) {
      await refreshSavedSettings();
      await refreshAlarms();
    }
    if (!resultDialog && feedback === "feedback" && feedbackId !== feedbackVersion) return;
    if (result?.ok) {
      if (isCheck) {
        const checks = result.checks;
        const includeCommunity = communityAtStart === communityAccess;
        const statuses = Object.values(checks);
        if (checks.live === "complete" && statuses.every(status => status === "complete" || status === "off")) checkResult = "complete";
        else if (statuses.some(status => status === "failed" || status === "waiting")) {
          checkResult = "failed";
          pendingCheckFeedback = { checks, includeCommunity, startedAt };
        }
        showCheckStatuses(checks, includeCommunity);
      } else {
        if (message.type === "reset-settings") {
          elements["pause-minutes"].value = elements["pause-minutes"].defaultValue;
          elements["pause-panel"].open = false;
        }
        if (message.type === "test-notification") success = `테스트 알림을 보냈어요 · 이번 팝업에서 ${++testCount}회`;
        displayResult(success);
      }
    } else {
      if (isCheck) checkResult = "failed";
      displayResult(result?.message ?? "작업을 처리할 수 없습니다. 다시 시도해 주세요.", true);
    }
  } catch {
    if (isCheck) {
      await minimumDisplay;
      if (checkId !== checkVersion) return;
      checkResult = "failed";
    }
    if (updatesSettings) {
      await refreshSavedSettings().catch(() => setForm(saved));
      await refreshAlarms();
    }
    if (resultDialog || feedback !== "feedback" || feedbackId === feedbackVersion) {
      displayResult("작업을 처리할 수 없습니다. 다시 시도해 주세요.", true);
    }
  } finally {
    if (isCheck && checkId === checkVersion) {
      checking = false;
      const restoreButton = () => {
        if (checkResult !== "failed") showFeedback("", false, "check-feedback");
        checkResult = "";
        render();
      };
      if (checkResult === "complete") {
        checkResultTimer = setTimeout(() => {
          if (matchMedia("(prefers-reduced-motion: reduce)").matches) return restoreButton();
          checkResult = "returning";
          render();
          checkResultTimer = setTimeout(restoreButton, 160);
        }, 2000);
      } else if (checkResult) checkResultTimer = setTimeout(restoreButton, 1100);
    } else if (!isCheck && !settingSave) busy = false;
    render();
    restoreFocus?.();
  }
}

const pendingSettings = new Map();
function applySetting(key, value) {
  if (loaded && !busy) {
    if (key === "enabled" && !value) clearCheckFeedback();
    // A later setting change supersedes any outstanding slider response.
    pauseVersion++;
    pauseDraft = null;
    pauseSaving = false;
    pauseDragging = false;
    const change = {value};
    pendingSettings.set(key, change);
    void send({ type: "save", key, value }, "설정을 적용하는 중…", "설정을 적용했습니다.").finally(() => {
      if (pendingSettings.get(key) !== change) return;
      pendingSettings.delete(key);
      syncFormControls();
      render();
    });
  }
}

function pauseDuration(minutes) {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return [hours && hours + "시간", (rest || !hours) && rest + "분"].filter(Boolean).join(" ");
}

function renderPauseSlider(now = Date.now()) {
  const paused = saved.enabled && !!saved.pausedUntil;
  const slider = elements["pause-minutes"];
  const editing = pauseDraft !== null || pauseDragging;
  const minutes = editing ? Number(slider.value) : paused ? Math.max(0, (saved.pausedUntil - now) / 60_000) : Number(slider.value);
  if (paused && !editing) slider.value = String(5 * Math.ceil(minutes / 5));
  const text = paused && !editing ? (minutes > 0 ? remainingTime(saved.pausedUntil, now).replace(/ 후$/, "") : "재개 대기 중") :
    !minutes ? "즉시 재개" : pauseDuration(minutes);
  elements["pause-label"].textContent = editing ? "선택한 시간" : paused ? "남은 시간" : "중지 시간";
  elements["pause-duration"].textContent = text;
  elements["pause-remaining"].textContent = paused ? "남은 시간 " + pauseDuration(Math.max(0, Math.ceil((saved.pausedUntil-now)/60000))) : "";
  slider.setAttribute("aria-valuetext", text);
  slider.style.setProperty("--pause-fill", `${Math.max(0, Math.min(100, minutes / 360 * 100))}%`);
}

async function applyPauseDraft() {
  if (pauseDraft === null || (pauseSaving && submittedPause === pauseDraft)) return;
  const minutes = pauseDraft;
  if (minutes > 0) clearCheckFeedback();
  const version = ++pauseVersion;
  submittedPause = minutes;
  pauseSaving = true;
  try {
    // Send in the input event, so closing the popup cannot discard a timer's draft.
    // The worker serializes writes; only the newest reply updates this screen.
    const result = await chrome.runtime.sendMessage({ type: "pause", minutes });
    if (version !== pauseVersion) return;
    if (!result?.ok) throw new Error(result?.message ?? "중지 시간을 적용할 수 없습니다. 다시 조절해 주세요.");
    const revision = settingsRevision;
    const state = await chrome.storage.local.get("settings");
    if (version !== pauseVersion) return;
    // Storage events may have supplied a newer state while this read waited.
    if (revision === settingsRevision) setForm(state.settings);
    pauseDraft = null;
    await refreshAlarms();
    return version === pauseVersion;
  } catch (error) {
    if (version !== pauseVersion) return;
    pauseDraft = null;
    showFeedback(error.message || "중지 시간을 적용할 수 없습니다.", true);
    const revision = settingsRevision;
    const state = await chrome.storage.local.get("settings").catch(() => null);
    if (version !== pauseVersion) return;
    if (state && revision === settingsRevision) setForm(state.settings);
    await refreshAlarms();
  } finally {
    if (version === pauseVersion) { pauseSaving = false; render(); }
  }
}

elements["pause-minutes"].addEventListener("pointerdown", () => { pauseDragging = true; });
const pausePanel = elements["pause-panel"];
function dismissPause() {
  pausePanel.open = false;
  pausePanel.querySelector("summary").focus({preventScroll:true});
}
pausePanel.addEventListener("toggle", () => {
  if (!pausePanel.open) return;
  closeLiveChoices();
  const box = pausePanel.getBoundingClientRect();
  const spaceBelow = window.innerHeight - box.bottom - 8;
  const above = spaceBelow < 200 && box.top > spaceBelow;
  pausePanel.classList.toggle("above",above);
  pausePanel.style.setProperty("--pause-space",Math.max(85,above ? box.top - 8 : spaceBelow)+"px");
});
pausePanel.addEventListener("keydown",event=>{
  if (event.key==="Escape" && pausePanel.open) {event.preventDefault();dismissPause();}
});
document.addEventListener("pointerdown",event=>{
  if (!pausePanel.contains(event.target)) pausePanel.open = false;
  if (!elements["live-choices"].contains(event.target) && !elements["open-live"].contains(event.target) && menuLiveId !== null) closeLiveChoices();
});
for (const event of ["pointerup", "pointercancel", "blur"]) {
  elements["pause-minutes"].addEventListener(event, () => {
    pauseDragging = false;
    void applyPauseDraft();
  });
}
function choosePause(minutes) {
  if (!loaded || busy || !saved.enabled) return;
  elements["pause-minutes"].value = String(minutes);
  pauseDraft = minutes;
  renderPauseSlider();
  void applyPauseDraft();
}
elements["pause-minutes"].addEventListener("input", () => choosePause(Number(elements["pause-minutes"].value)));
elements["pause-entry"].addEventListener("click", event => {
  const minutes = event.target.closest("button[data-minutes]")?.dataset.minutes;
  if (minutes !== undefined) {
    choosePause(Number(minutes));
    dismissPause();
  }
});
elements["pause-minutes"].addEventListener("change", () => void applyPauseDraft());
renderPauseSlider();
elements.resume.addEventListener("click", async () => {
  if (busy || resuming) return;
  resuming = true;
  pauseDraft = 0;
  elements["pause-minutes"].value = "0";
  elements.resume.setAttribute("aria-busy", "true");
  const running = applyPauseDraft();
  const version = pauseVersion;
  render();
  try {
    if (!await running || !pausePanel.open || currentView !== "home") return;
    if (!matchMedia("(prefers-reduced-motion: reduce)").matches) {
      const panel = pausePanel.querySelector(".pause-controls");
      const fade = panel.animate([{opacity:1}, {opacity:0,transform:"translateY(-3px)"}],
        {duration:180,delay:120,easing:"ease-in",fill:"both"});
      await fade.finished.catch(() => {});
      fade.cancel();
    }
    if (version === pauseVersion && pausePanel.open && currentView === "home") dismissPause();
  } finally {
    elements.resume.removeAttribute("aria-busy");
    resuming = false;
    render();
  }
});


elements["news-basket"].addEventListener("click", event => {
  const button = event.target.closest("button[data-source]");
  if (!button || button.hidden || button.dataset.source === activityFilter) return;
  activityFilter = button.dataset.source;
  activityLimit = pageSize;
  renderActivity();
  if (!reduceCardMotion.matches) {
    const results = elements["basket-results"];
    for (const animation of results.getAnimations()) animation.cancel();
    results.animate([{opacity:.35, transform:"translateY(3px)"}, {opacity:1, transform:"none"}],
      {id:"basket-filter", duration:300, easing:"ease-out"});
  }
});
for (const toggle of document.querySelectorAll('input[role="switch"]')) {
  toggle.addEventListener("input", () => toggle.classList.add("switch-motion"));
}
elements["notify-live"].addEventListener("change", () => applySetting("notifyLive", elements["notify-live"].checked));
elements["notify-missed"].addEventListener("change", () => applySetting("notifyMissed", elements["notify-missed"].checked));

elements.theme.addEventListener("change", async () => {
  const version = ++themeVersion;
  const choice = elements.theme.value;
  setTheme(choice);
  try {
    await chrome.storage.local.set({ popupTheme: choice });
  } catch {
    if (version !== themeVersion) return;
    const revision = themeStorageRevision;
    const current = await chrome.storage.local.get("popupTheme").catch(() => null);
    if (version !== themeVersion) return;
    if (revision === themeStorageRevision) setTheme(current ? current.popupTheme : confirmedTheme);
    showFeedback("화면 모드를 저장할 수 없습니다. 다시 시도해 주세요.", true);
  }
});
elements["recover-schedule"].addEventListener("click", () => {
  if (!busy && !checking) void send({ type: "recover" }, "추적 예약을 복구하는 중…", "추적 예약을 복구했습니다.");
});
elements.enabled.addEventListener("change", () => applySetting("enabled", elements.enabled.checked));
elements.interval.addEventListener("change", () => applySetting("intervalSeconds", Number(elements.interval.value)));
elements["community-interval"].addEventListener("change", () => {
  applySetting("communityIntervalSeconds", Number(elements["community-interval"].value));
});
elements["broadcast-mode"].addEventListener("change", () => {
  applySetting("broadcastMode", elements["broadcast-mode"].value);
});
elements.check.addEventListener("click", () => {
  if (!elements.check.disabled && elements.check.ariaDisabled !== "true") {
    void send({ type: "check", waitForOpening: false, restartCountdown: true }, "확인 중…", "");
  }
});

const resetDialog = elements["reset-dialog"];
const previewDialog = elements["live-preview"];
function selectPreviewMode(mode) {
  for (const card of previewDialog.querySelectorAll(".hero")) card.hidden = card.dataset.state !== mode;
  previewDialog.querySelector(`input[value="${mode}"]`).checked = true;
}
previewDialog.addEventListener("change", event => {
  if (event.target.name === "preview-mode") selectPreviewMode(event.target.value);
});
elements["preview-live"].addEventListener("click", () => {
  selectPreviewMode(report.status === "live" ? "waiting" : "live");
  previewDialog.showModal();
  previewDialog.querySelector("input:checked").focus();
});
elements["reset-settings"].addEventListener("click", () => {
  resetDialog.returnValue = "cancel";
  resetDialog.showModal();
});
resetDialog.addEventListener("close", () => {
  if (resetDialog.returnValue === "reset" && !elements["reset-settings"].disabled) {
    void send({ type: "reset-settings" }, "기본값을 적용하는 중…", "설정을 기본 값으로 초기화했습니다.");
  }
});

elements["test-notification"].addEventListener("click", () => {
  if (busy || changingPermission) return;
  void send(
    { type: "test-notification" },
    "테스트 알림 보내는 중…",
    "",
  );
});

async function updateNotificationControls() {
  const version = ++permissionVersion;
  const [notifications, community] = await Promise.all([
    chrome.permissions.contains(NOTIFICATION_ACCESS),
    chrome.permissions.contains(COMMUNITY_ACCESS),
  ]);
  const level = notifications ? await chrome.notifications?.getPermissionLevel().catch(() => undefined) : undefined;
  if (version !== permissionVersion) return;
  if (loaded && community && !communityAccess && monitoringActive(saved)) {
    newsScheduleConfirmation ??= chrome.runtime.sendMessage({type:"confirm-news-schedule"})
      .catch(() => null).finally(() => { newsScheduleConfirmation = undefined; });
    const confirmation = await newsScheduleConfirmation;
    if (version !== permissionVersion) return;
    // Publish the new permission with its alarm, never alongside the old "off" snapshot.
    ++scheduleVersion;
    alarms[1] = confirmation?.alarm;
  }
  notificationAccess = notifications;
  if (!notifications && permissionSuccess) showFeedback("");
  notificationLevel = level;
  if (loaded && communityAccess !== community && !checking) clearCheckFeedback();
  communityAccess = community;
  if (!changingPermission) elements.community.checked = community;
  await refreshAlarms();
}

async function togglePermission(enabled, request, remove, initialSetup = false) {
  if (changingPermission) return;
  changingPermission = true;
  changingNotificationButton = request === NOTIFICATION_ACCESS || remove === NOTIFICATION_ACCESS || initialSetup;
  if (changingNotificationButton) delete elements["notification-banner"].dataset.fill;
  render();
  ++feedbackVersion;
  // A native permission dialog can destroy the popup before its promise settles.
  const returnState = JSON.stringify({ view: currentView, community: request === COMMUNITY_ACCESS, initialSetup });
  if (enabled) localStorage.setItem("permissionReturn", returnState);
  try {
    // This call starts inside the user's click so Chrome can prompt immediately.
    const changed = enabled ? await chrome.permissions.request(request) : await chrome.permissions.remove(remove);
    if (!changed && !enabled) showFeedback("권한을 해제할 수 없습니다.", true);
    if (changed && changingNotificationButton) elements["notification-banner"].dataset.fill = enabled ? "on" : "off";
    return changed;
  } catch {
    if (enabled && localStorage.getItem("permissionReturn") === returnState) localStorage.removeItem("permissionReturn");
    showFeedback("알림 권한을 변경할 수 없습니다. 다시 시도해 주세요.", true);
  } finally {
    await updateNotificationControls().catch(() => showFeedback("알림 권한을 확인할 수 없습니다.", true));
    // A concurrent focus/permission refresh may still be waiting on the worker.
    // Read the permission itself before releasing the switch to further clicks.
    elements.community.checked = await chrome.permissions.contains(COMMUNITY_ACCESS).catch(() => communityAccess);
    changingPermission = false;
    changingNotificationButton = false;
    render();
    if (enabled && loaded) await restorePermissionReturn(false);
  }
}

async function restorePermissionReturn(restoreView = true) {
  const raw = localStorage.getItem("permissionReturn");
  if (!raw) return;
  const { view, community, initialSetup } = JSON.parse(raw);
  const [granted, hasCommunity] = await Promise.all([
    chrome.permissions.contains(community ? COMMUNITY_ACCESS : NOTIFICATION_ACCESS),
    chrome.permissions.contains(COMMUNITY_ACCESS),
  ]);
  if (localStorage.getItem("permissionReturn") !== raw) return;
  localStorage.removeItem("permissionReturn");
  if (!["home", "activity", "settings"].includes(view)) return;
  if (initialSetup && !granted && !notificationAccess) {
    await chrome.storage.local.set({ firstNotificationSetup: "deferred" });
    firstNotificationSetup = "deferred";
  }
  if (currentView !== view) {
    if (!restoreView) return;
    selectView(view);
  }
  let message = granted ? "Chrome 알림을 허용했어요." : "Chrome 알림을 허용하지 않았어요. 위에서 다시 허용할 수 있어요.";
  if (initialSetup) message = granted ? "Chrome 알림과 커뮤니티·디스코드 새 글 알림을 켰어요." : notificationAccess ?
    "Chrome 알림을 허용했어요. 커뮤니티·디스코드 새 글 알림은 별도로 켤 수 있어요." : "Chrome 알림이 꺼져 있어요. 위에서 언제든 켤 수 있어요.";
  else if (community) message = granted ? "커뮤니티·디스코드 새 글 알림을 켰어요." : "새 글 알림을 허용하지 않았어요. ‘새 글 알림’을 다시 선택할 수 있어요.";
  else if (granted && !hasCommunity) message += " 새 글도 받으려면 홈에서 ‘커뮤니티·디스코드 추적’ 옆의 ‘꺼짐’을 누르세요.";
  if (granted && notificationLevel === "denied") message = "확장 프로그램의 권한은 허용됐어요. 위의 ‘설정 확인’에서 Chrome 알림 차단을 확인하세요.";
  if (view === "settings" && (!community || initialSetup) && notificationLevel !== "denied") {
    const allowed = initialSetup ? await chrome.permissions.contains(NOTIFICATION_ACCESS) : granted;
    showSettingsResult(allowed ? "Chrome 알림을 켰어요." : "Chrome 알림을 허용하지 않았어요.", allowed);
  } else if (currentView !== "settings" || initialSetup || notificationLevel === "denied") showFeedback(message, false, "feedback", granted);
}

elements["disable-notifications"].addEventListener("click", async () => {
  if (await togglePermission(false, undefined, NOTIFICATION_ACCESS)) {
    if (currentView === "settings") showSettingsResult("Chrome 알림을 껐어요.");
    elements["allow-notifications"].focus();
  }
});

elements["first-later"].addEventListener("click", async () => {
  try {
    await chrome.storage.local.set({ firstNotificationSetup: "deferred" });
    firstNotificationSetup = "deferred";
    renderPermissionBanner();
    const next = elements["tour-offer"].hidden ? "allow-notifications" : "tour-start";
    (elements[next].hidden ? elements["nav-home"] : elements[next]).focus();
  } catch { showFeedback("알림 안내 설정을 저장할 수 없습니다.", true); }
});
elements["first-allow"].addEventListener("click", () => {
  void togglePermission(true, COMMUNITY_ACCESS, undefined, true);
});
elements.community.addEventListener("click", event => { if (changingPermission) event.preventDefault(); });
elements.community.addEventListener("change", () => {
  void togglePermission(elements.community.checked, COMMUNITY_ACCESS, { origins: COMMUNITY_ACCESS.origins });
});
elements["allow-notifications"].addEventListener("click", () => {
  if (firstNotificationSetup) void togglePermission(true, COMMUNITY_ACCESS, undefined, true);
  else void togglePermission(true, NOTIFICATION_ACCESS);
});
elements["allow-community"].addEventListener("click", () => {
  void togglePermission(true, COMMUNITY_ACCESS);
});
elements["notification-help"].addEventListener("click", () => {
  const guide = elements["notification-guide"];
  guide.hidden = !guide.hidden;
  elements["notification-help"].setAttribute("aria-expanded", String(!guide.hidden));
});
elements["activity-more"].addEventListener("click", () => {
  const previousScroll = document.scrollingElement.scrollTop;
  const list = elements["activity-list"];
  const visibleRows = () => [...list.querySelectorAll("li:not([hidden])")];
  const previousRows = new Set(visibleRows());
  activityLimit += pageSize;
  renderActivity();
  const revealed = visibleRows().filter(row => !previousRows.has(row));
  const firstNew = revealed[0];
  if (firstNew) {
    firstNew.tabIndex = -1;
    firstNew.focus({ preventScroll: true });
  }
  document.scrollingElement.scrollTop = previousScroll;
  if (matchMedia("(prefers-reduced-motion: no-preference)").matches) {
    for (const row of revealed) {
      row.animate([{ opacity: 0.35 }, { opacity: 1 }], { duration: 150, easing: "ease-out" });
    }
  }
});

function refreshPermissions() {
  void updateNotificationControls().catch(() => {});
}

let initializing = true;
const initialChanges = Object.create(null);
function applyStoredChanges(changes) {
  if (changes.tourPending) tourPending = changes.tourPending.newValue === true;
  if (changes.firstNotificationSetup) firstNotificationSetup = changes.firstNotificationSetup.newValue ?? false;
  if (changes.popupTheme) {
    themeStorageRevision++;
    setTheme(changes.popupTheme.newValue);
    confirmedTheme = popupTheme;
  }
  if (changes.settings) {
    setForm(changes.settings.newValue);
    void refreshAlarms();
  }
  if (changes.report) report = changes.report.newValue ?? {};
  if (changes.weekBroadcasts) weekBroadcasts = changes.weekBroadcasts.newValue ?? [];
  if (changes.communityReport) communityReport = changes.communityReport.newValue ?? {};
  for (const key of Object.keys(DISCORD_CHANNELS)) {
    if (changes[key + "Report"]) discordReports[key] = changes[key + "Report"].newValue ?? {};
  }
  if (changes.report || changes.communityReport) void refreshAlarms();
  if (changes.notificationRetrySchedule) notificationRetryAt = changes.notificationRetrySchedule.newValue?.retryAt;
  if (changes.pendingNotifications) pendingNotifications = changes.pendingNotifications.newValue ?? {};
  if (changes.scheduleRecovery) {
    scheduleRecovery = changes.scheduleRecovery.newValue ?? null;
    void refreshAlarms();
  }
  if (changes.activity) {
    renderActivity(changes.activity.newValue ?? []);
    if (notificationAccess) refreshPermissions();
  }
  render();
}
// Subscribe before reading. Changes received while the initial snapshot is in
// flight win per key, including deletion; an old snapshot never overwrites them.
chrome.runtime.onMessage.addListener(message => {
  if (message.type === "check-schedule-updated") void refreshAlarms();
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (initializing) Object.assign(initialChanges, changes);
  else applyStoredChanges(changes);
});
chrome.runtime.onMessage.addListener((message, sender) => {
  if (sender.id !== chrome.runtime.id || message?.type !== "live-opening-changed") return;
  ++openingRevision;
  automaticLiveOpening = message.opening === true;
  scheduleOpeningRead();
  render();
});
let openingTimer;
function scheduleOpeningRead() {
  clearTimeout(openingTimer);
  if (automaticLiveOpening) openingTimer = setTimeout(readLiveOpening, 1000);
}
function readLiveOpening() {
  const openingSnapshot = openingRevision;
  void chrome.runtime.sendMessage({ type: "live-opening-status" }).then((result) => {
    if (openingSnapshot !== openingRevision) return;
    automaticLiveOpening = result?.opening === true;
    render();
  }).catch(() => {}).finally(scheduleOpeningRead);
}
readLiveOpening();
try {
  // A Chrome permission prompt can close the toolbar popup. Restore its tab before waiting for data.
  const returnView = JSON.parse(localStorage.getItem("permissionReturn") || "null")?.view;
  if (["settings", "activity"].includes(returnView)) selectView(returnView);
  await chrome.runtime.sendMessage({ type: "ready" });
  const state = await chrome.storage.local.get({
    announcementsReport: {}, schoolReport: {},
    settings: {}, report: {}, communityReport: {}, activity: [], weekBroadcasts: [], popupTheme: "auto", notificationRetrySchedule: null, pendingNotifications: {}, scheduleRecovery: null, firstNotificationSetup: false, tourPending: false,
  });
  applyStoredChanges({ ...Object.fromEntries(Object.entries(state).map(([key, newValue]) => [key, { newValue }])), ...initialChanges });
  initializing = false;
  chrome.alarms.onAlarm.addListener(({ name }) => {
    if ([...Object.values(CHECK_ALARMS), COMMUNITY_RETRY_ALARM, RESUME_ALARM, RECOVERY_ALARM].includes(name)) void refreshAlarms();
  });
  chrome.permissions.onAdded.addListener(refreshPermissions);
  chrome.permissions.onRemoved.addListener(refreshPermissions);
  window.addEventListener("focus", refreshPermissions);
  await updateNotificationControls();
  loaded = true;
  render();
  await restorePermissionReturn();
  async function showGroup(id, options) {
    selectView("activity");
    await showNewsGroup(id, options);
  }
  if (!await chrome.tabs.getCurrent()) {
    const win = await chrome.windows.getCurrent();
    const key = "pendingNewsGroup:" + win.id;
    let shownId;
    async function showPending(id) {
      if (!id || id === shownId) return;
      shownId = id;
      try {
        await showGroup(id);
        await chrome.storage.session.remove(key);
      } finally {
        shownId = null;
      }
    }
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "session" && changes[key]?.newValue) void showPending(changes[key].newValue);
    });
    const group = (await chrome.storage.session.get(key))[key];
    if (group) {
      await showPending(group);
    } else if ((await chrome.runtime.sendMessage({ type: "take-missed-return", windowId: win.id }))?.restore && !shownId) {
      selectView("activity");
      selectedBasketButton().focus();
    }
  }
  const groupId = location.hash.slice(1);
  if (/^discord-group-(announcements|school)-[1-9]\d{16,19}$/.test(groupId)) {
    const win = await chrome.windows.getCurrent();
    await showGroup(groupId, { standalone: win.type === "popup" });
  }
  featureNoticePending = (await chrome.storage.local.get("newsBasketFeatureNotice")).newsBasketFeatureNotice === "pending";
  await showFeatureNotice();
} catch {
  elements.status.textContent = "설정을 불러오지 못했습니다.";
  showFeedback("팝업을 닫고 다시 열어 주세요.", true);
}
