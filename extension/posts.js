import { DISCORD_CHANNELS, discordPostUrl, discordTime } from "./config.js";

// Bookmarks and tabs from 1.9.3 still reach the same in-extension picker.
if (location.pathname === "/posts.html") location.replace("popup.html" + location.hash);

const clock = new Intl.DateTimeFormat("ko-KR", {
  timeZone: "Asia/Seoul", month: "long", day: "numeric", year: "numeric",
  hour: "numeric", minute: "2-digit", second: "2-digit",
});

const groupDialog = document.getElementById("news-group-dialog");
let groupDismissed = false;
let standaloneGroupWindow = false;

function focusActivityAfterDismissal() {
  if (groupDismissed) return;
  groupDismissed = true;
  document.getElementById("nav-activity").focus({ preventScroll: true });
}

if (groupDialog) {
  window.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || event.isComposing || event.defaultPrevented) return;
    if (groupDialog.open && groupDialog.contains(document.activeElement)) {
      event.preventDefault();
      groupDialog.close();
      focusActivityAfterDismissal();
    } else if (groupDismissed && event.repeat) {
      // Holding the first press must not dismiss the toolbar popup as well.
      event.preventDefault();
    } else if (groupDismissed && standaloneGroupWindow && !document.querySelector("dialog[open]")) {
      // Let Chrome cancel the pending choice and return focus to the select.
      if (CSS.supports("selector(select:open)") && document.querySelector("select:open")) return;
      event.preventDefault();
      window.close();
    }
  });
}

export async function showNewsGroup(groupId, { standalone = false } = {}) {
  standaloneGroupWindow = standalone;
  groupDismissed = false;
  const dialog = document.getElementById("news-group-dialog");
  const heading = document.getElementById("news-group-title");
  const status = document.getElementById("news-group-status");
  const list = document.getElementById("news-group-list");
  const match = /^discord-group-(announcements|school)-([1-9]\d{16,19})$/.exec(groupId);
  const { discordGroups = {} } = await chrome.storage.local.get("discordGroups");
  const group = match && discordGroups[groupId];
  const ids = group?.source === match?.[1] && Array.isArray(group?.ids)
    ? [...new Set(group.ids)].filter(id => discordPostUrl(group.source, id)).sort((a, b) => b.length - a.length || b.localeCompare(a))
    : [];
  heading.textContent = match ? DISCORD_CHANNELS[match[1]].name : "디스코드 새 글";
  status.textContent = ids.length ? `새 글 ${ids.length}건 · 최신순 · 한국시간` : "이 묶음의 보관 기간이 지났거나 글 목록을 찾을 수 없어요. 최근 활동을 확인해 주세요.";
  list.replaceChildren();
  for (const [index, id] of ids.entries()) {
    const link = document.createElement("a");
    link.href = discordPostUrl(group.source, id);
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    const label = document.createElement("strong");
    label.textContent = `${index + 1}번 글${index === 0 ? " · 최신" : ""}`;
    const time = document.createElement("time");
    const date = new Date(discordTime(id));
    time.dateTime = date.toISOString();
    time.textContent = clock.format(date);
    const item = document.createElement("li");
    link.append(label, time);
    item.append(link);
    list.append(item);
  }
  if (!dialog.open) {
    // Chrome's toolbar popup can reserve a scrollbar gutter even with overflow hidden.
    const centerInWindow = () => dialog.style.setProperty("--picker-center", `${window.innerWidth / 2}px`);
    centerInWindow();
    window.addEventListener("resize", centerInWindow);
    dialog.addEventListener("close", () => window.removeEventListener("resize", centerInWindow), { once: true });
    dialog.addEventListener("close", focusActivityAfterDismissal, { once: true });
    dialog.showModal();
  }
  list.scrollTop = 0;
}
