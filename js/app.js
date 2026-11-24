/**
 * Main UI controller for the GD Ruse30 tagger (`tag.html`).
 * Loaded as `<script type="module" src="js/app.js">` after the classic site `assets/app.js`.
 * Exports pure state/UI helpers so Node unit tests can import and verify controller logic.
 */

import {
  OUR_TEAM,
  TEAM_PLAYER_NAME,
  findOppPlayer,
  findPlayerByPersonId,
  normalizeOppTeamCsv,
  updateRosterPlayer,
  upsertOppPlayer,
} from "./roster.js";
import {
  LEGAL_EVENTS,
  compareTags,
  createZeroPlayerStats,
  exportBoxJson,
  exportPbpCsv,
  formatVideoTime,
  getScoreMismatch,
  parseVideoTime,
  tallyGame,
} from "./tally.js";
import {
  addTag,
  createSession,
  deleteTag,
  editTag,
  exportSessionJson,
  getUndoCount,
  importPbpCsv,
  importSessionJson,
  insertAssistBeforeLastShot,
  loadActiveSession,
  loadDefaultRoster,
  saveDefaultRoster,
  saveSessionToStorage,
  setPf,
  undo,
} from "./model.js";
import { createVideoController, formatPlaybackSpeed } from "./video.js";
import { attachHotkeys } from "./hotkeys.js";

const SHOT_FLIP_MAP = Object.freeze({
  "1 POINT": "1 POINT MISS",
  "1 POINT MISS": "1 POINT",
  "2 POINT": "2 POINT MISS",
  "2 POINT MISS": "2 POINT",
  "3 POINT": "3 POINT MISS",
  "3 POINT MISS": "3 POINT",
});

const MONTH_NAMES = Object.freeze([
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
]);

/**
 * Flip a shot event string between made and miss, or return null for non-shot events.
 * @param {string} event
 * @returns {string|null}
 */
export function flipShotEvent(event) {
  const key = String(event ?? "").trim().toUpperCase();
  return SHOT_FLIP_MAP[key] || null;
}

/**
 * Format an ISO `YYYY-MM-DD` date string into site short format (`23 Sep 2026`).
 * @param {string} isoDate
 * @returns {string}
 */
export function formatShortDate(isoDate) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(isoDate ?? "").trim());
  if (!match) return "";
  const year = match[1];
  const monthIdx = Number(match[2]) - 1;
  const day = Number(match[3]);
  if (monthIdx < 0 || monthIdx > 11 || day < 1 || day > 31) return "";
  return `${day} ${MONTH_NAMES[monthIdx]} ${year}`;
}

/**
 * Return any duplicate jersey numbers among currently active GD Ruse30 roster players.
 * @param {Array<object>} roster
 * @returns {Array<string>}
 */
export function findDuplicateActiveJerseys(roster) {
  const counts = new Map();
  for (const p of roster || []) {
    if (!p?.active) continue;
    const j = String(p.jersey ?? "").trim();
    if (!j) continue;
    counts.set(j, (counts.get(j) || 0) + 1);
  }
  return [...counts.entries()].filter(([, n]) => n > 1).map(([j]) => j);
}

/**
 * Resolve the target tag for `K` (prev, direction -1) or `L` (next, direction +1) navigation.
 * @param {Array<object>} tags
 * @param {string|null} activeTagId
 * @param {number} currentTimeSec
 * @param {-1|1} direction
 * @returns {object|null}
 */
export function findPrevNextTag(tags, activeTagId, currentTimeSec, direction) {
  if (!Array.isArray(tags) || tags.length === 0) return null;
  if (activeTagId) {
    const idx = tags.findIndex((t) => t.id === activeTagId);
    if (idx !== -1) {
      const nextIdx = direction < 0 ? Math.max(0, idx - 1) : Math.min(tags.length - 1, idx + 1);
      return tags[nextIdx];
    }
  }
  const now = Math.floor(Number(currentTimeSec) || 0);
  if (direction < 0) {
    for (let i = tags.length - 1; i >= 0; i -= 1) {
      if (tags[i].timeSec <= now) return tags[i];
    }
    return tags[0];
  }
  for (let i = 0; i < tags.length; i += 1) {
    if (tags[i].timeSec >= now) return tags[i];
  }
  return tags[tags.length - 1];
}

/**
 * Scroll a chronological PBP list container so `rowEl` is visible without scrolling the whole page.
 * @param {HTMLElement|object|null} listEl
 * @param {HTMLElement|object|null} rowEl
 */
export function scrollLogRowIntoView(listEl, rowEl) {
  if (!listEl || !rowEl) return;
  if (
    typeof listEl.scrollHeight === "number" &&
    typeof listEl.clientHeight === "number" &&
    typeof rowEl.offsetTop === "number" &&
    typeof rowEl.offsetHeight === "number"
  ) {
    const viewTop = Number(listEl.scrollTop) || 0;
    const viewBottom = viewTop + listEl.clientHeight;
    const rowTop = rowEl.offsetTop;
    const rowBottom = rowTop + rowEl.offsetHeight;
    if (rowTop < viewTop) {
      listEl.scrollTop = rowTop;
    } else if (rowBottom > viewBottom) {
      listEl.scrollTop = Math.max(0, rowBottom - listEl.clientHeight);
    }
    return;
  }
  rowEl.scrollIntoView?.({ block: "nearest" });
}

/**
 * Create the pure tag-pad interaction controller supporting both:
 *  - Player -> Event (1-tap when a jersey is selected)
 *  - Event -> Player with timestamp latching (2-tap when no jersey is selected)
 *  - Explicit G timestamp latch, Shift+A assist-before-last-FG, and M shot flip
 *
 * @param {object} deps
 */
export function createPadController(deps) {
  let session = deps.getSession();
  const getTimeSec = deps.getTimeSec;
  const onCommit = deps.onCommit || (() => {});
  const onStateChange = deps.onStateChange || (() => {});

  let selectedTeamSide = "gd"; // "gd" | "opp"
  let selectedActor = null; // { isTeam, personId?, num, player } | null
  let pendingLatch = null; // { timeSec, event, assistBeforeLast? } | null
  let lastShotTagId = null;

  function syncSession(nextSession) {
    session = nextSession;
  }

  function resolveTeamCsv() {
    if (selectedTeamSide === "gd") return OUR_TEAM;
    return session.meta?.oppTeamCsv || normalizeOppTeamCsv(session.meta?.opp);
  }

  function actorEquals(a, b) {
    if (!a || !b) return false;
    if (a.isTeam || b.isTeam) return Boolean(a.isTeam && b.isTeam);
    if (a.personId || b.personId) return a.personId === b.personId;
    return String(a.num) === String(b.num);
  }

  function setTeamSide(side) {
    const normalized = side === "opp" ? "opp" : "gd";
    if (normalized === selectedTeamSide) return;
    selectedTeamSide = normalized;
    selectedActor = null;
    onStateChange(getSnapshot());
  }

  function toggleTeamSide() {
    setTeamSide(selectedTeamSide === "gd" ? "opp" : "gd");
  }

  function latchTime() {
    const timeSec = Math.max(0, Math.floor(Number(getTimeSec()) || 0));
    pendingLatch = {
      timeSec,
      event: pendingLatch?.event || null,
      assistBeforeLast: Boolean(pendingLatch?.assistBeforeLast),
    };
    onStateChange(getSnapshot());
    return pendingLatch;
  }

  function cancelLatch() {
    if (!pendingLatch) return false;
    pendingLatch = null;
    onStateChange(getSnapshot());
    return true;
  }

  function commitTag(event, actor, timeSec) {
    const tag = addTag(session, {
      timeSec,
      team: resolveTeamCsv(),
      isTeam: Boolean(actor.isTeam),
      personId: actor.personId,
      num: actor.num,
      player: actor.player,
      event,
    });
    if (flipShotEvent(tag.event)) {
      lastShotTagId = tag.id;
    }
    pendingLatch = null;
    onCommit({ action: "add", tag });
    onStateChange(getSnapshot());
    return tag;
  }

  function findLastMadeShotForTeam(teamCsv) {
    const tags = [...(session.tags || [])].sort(compareTags);
    for (let i = tags.length - 1; i >= 0; i -= 1) {
      const t = tags[i];
      if (t.event !== "2 POINT" && t.event !== "3 POINT") continue;
      if (teamCsv && t.team !== teamCsv) continue;
      return t;
    }
    return null;
  }

  function isSameActorAsTag(actor, tag) {
    if (!actor || !tag) return false;
    if (actor.isTeam) return !tag.num && String(tag.player ?? "").trim().toUpperCase() === TEAM_PLAYER_NAME;
    if (actor.personId && tag.personId) return String(actor.personId) === String(tag.personId);
    const actorNum = String(actor.num ?? "").trim();
    const tagNum = String(tag.num ?? "").trim();
    return Boolean(actorNum && tagNum && actorNum === tagNum);
  }

  function selectActor(actor) {
    if (pendingLatch?.assistBeforeLast) {
      const teamCsv = resolveTeamCsv();
      const lastShot = findLastMadeShotForTeam(teamCsv);
      if (lastShot && isSameActorAsTag(actor, lastShot)) {
        pendingLatch = {
          ...pendingLatch,
          scorerNum: lastShot.num,
          scorerPlayer: lastShot.player,
          selfAssistRejected: true,
        };
        selectedActor = null;
        onStateChange(getSnapshot());
        return { committed: false, reason: "self-assist", pendingLatch: { ...pendingLatch } };
      }

      const inserted = insertAssistBeforeLastShot(session, {
        team: teamCsv,
        isTeam: Boolean(actor.isTeam),
        personId: actor.personId,
        num: actor.num,
        player: actor.player,
        timeSec: pendingLatch.timeSec,
      });
      pendingLatch = null;
      selectedActor = null;
      if (inserted) {
        onCommit({ action: "assist-before-last", tag: inserted });
      }
      onStateChange(getSnapshot());
      return { committed: Boolean(inserted), tag: inserted };
    }

    if (pendingLatch?.event) {
      const latchedSec = pendingLatch.timeSec;
      const latchedEvent = pendingLatch.event;
      const tag = commitTag(latchedEvent, actor, latchedSec);
      selectedActor = null;
      onStateChange(getSnapshot());
      return { committed: true, tag };
    }

    selectedActor = actorEquals(selectedActor, actor) ? null : { ...actor };
    onStateChange(getSnapshot());
    return { committed: false, selectedActor };
  }

  function triggerEvent(event) {
    const timeSec = pendingLatch ? pendingLatch.timeSec : Math.max(0, Math.floor(Number(getTimeSec()) || 0));
    if (selectedActor) {
      const tag = commitTag(event, selectedActor, timeSec);
      return { committed: true, tag };
    }
    pendingLatch = { timeSec, event, assistBeforeLast: false };
    onStateChange(getSnapshot());
    return { committed: false, pendingLatch };
  }

  function triggerAssistBeforeLast() {
    const teamCsv = resolveTeamCsv();
    const lastShot = findLastMadeShotForTeam(teamCsv);
    if (!lastShot) {
      return { committed: false, reason: "no-made-fg" };
    }

    const timeSec = pendingLatch ? pendingLatch.timeSec : Math.max(0, Math.floor(Number(getTimeSec()) || 0));

    if (selectedActor) {
      if (isSameActorAsTag(selectedActor, lastShot)) {
        selectedActor = null;
        pendingLatch = {
          timeSec,
          event: "ASSIST",
          assistBeforeLast: true,
          scorerNum: lastShot.num,
          scorerPlayer: lastShot.player,
          selfAssistRejected: false,
        };
        onStateChange(getSnapshot());
        return { committed: false, reason: "self-assist-prompt", pendingLatch: { ...pendingLatch } };
      }

      const inserted = insertAssistBeforeLastShot(session, {
        team: teamCsv,
        isTeam: Boolean(selectedActor.isTeam),
        personId: selectedActor.personId,
        num: selectedActor.num,
        player: selectedActor.player,
        timeSec,
      });
      pendingLatch = null;
      if (inserted) {
        onCommit({ action: "assist-before-last", tag: inserted });
      }
      onStateChange(getSnapshot());
      return { committed: Boolean(inserted), tag: inserted };
    }

    pendingLatch = {
      timeSec,
      event: "ASSIST",
      assistBeforeLast: true,
      scorerNum: lastShot.num,
      scorerPlayer: lastShot.player,
      selfAssistRejected: false,
    };
    onStateChange(getSnapshot());
    return { committed: false, pendingLatch };
  }

  function flipShot() {
    if (pendingLatch?.event) {
      const flippedPending = flipShotEvent(pendingLatch.event);
      if (flippedPending) {
        pendingLatch = { ...pendingLatch, event: flippedPending };
        onStateChange(getSnapshot());
        return { flipped: "pending", event: flippedPending };
      }
    }

    const tags = session.tags || [];
    if (tags.length === 0) return { flipped: false };

    let candidate = lastShotTagId ? tags.find((t) => t.id === lastShotTagId) : null;
    if (!candidate) {
      candidate = tags[tags.length - 1];
    }
    const flipped = flipShotEvent(candidate?.event);
    if (!candidate || !flipped) return { flipped: false };

    const nowSec = Math.max(0, Math.floor(Number(getTimeSec()) || 0));
    if (Math.abs(nowSec - candidate.timeSec) > 3) {
      return { flipped: false, reason: "outside-3s" };
    }

    const updated = editTag(session, candidate.id, { event: flipped });
    if (updated) {
      lastShotTagId = updated.id;
      onCommit({ action: "flip", tag: updated });
      onStateChange(getSnapshot());
      return { flipped: "tag", tag: updated };
    }
    return { flipped: false };
  }

  function getSnapshot() {
    return {
      selectedTeamSide,
      selectedActor: selectedActor ? { ...selectedActor } : null,
      pendingLatch: pendingLatch ? { ...pendingLatch } : null,
    };
  }

  return {
    syncSession,
    setTeamSide,
    toggleTeamSide,
    selectActor,
    latchTime,
    cancelLatch,
    triggerEvent,
    triggerAssistBeforeLast,
    flipShot,
    getSnapshot,
  };
}

function showBanner(el, message) {
  if (!el) return;
  const textSpan = el.querySelector("span:last-child");
  if (!message) {
    el.hidden = true;
    if (textSpan) textSpan.textContent = "";
    return;
  }
  if (textSpan) textSpan.textContent = message;
  el.hidden = false;
}

function downloadTextFile(filename, content, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function deriveDateInputValue(meta) {
  const rawDate = String(meta?.date ?? "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(rawDate)) return rawDate;
  const code = String(meta?.code ?? "").trim();
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(code);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return "";
}

/**
 * Boot the full M3 tagger controller on `tag.html`.
 */
export function initTaggerApp(doc = document, win = window) {
  const videoEl = doc.getElementById("tagger-video");
  if (!videoEl) return null;

  // Origin warning when opened via file:// (localStorage is unreliable under file://)
  const originBanner = doc.getElementById("tagger-origin-banner");
  if (win.location?.protocol === "file:") {
    showBanner(
      originBanner,
      "Opened over file:// — browser autosave may not persist. Run `python3 -m http.server` in the tagger folder and open http://127.0.0.1:8765/tag.html."
    );
  }

  let session = loadActiveSession() || createSession({}, { roster: loadDefaultRoster() });

  // DOM refs
  const storageBanner = doc.getElementById("tagger-storage-banner");
  const videoErrorBanner = doc.getElementById("tagger-video-error");
  const fileInputEl = doc.getElementById("tagger-video-file");
  const placeholderEl = doc.getElementById("tagger-video-placeholder");
  const playBtn = doc.getElementById("tagger-play");
  const speedBtn = doc.getElementById("tagger-speed");
  const timeDisplayEl = doc.getElementById("tagger-time");
  const prevTagBtn = doc.getElementById("tagger-prev-tag");
  const nextTagBtn = doc.getElementById("tagger-next-tag");
  const seekButtons = [...doc.querySelectorAll(".tagger-transport [data-seek]")];

  const metaForm = doc.getElementById("tagger-meta");
  const dateInput = doc.getElementById("tagger-date");
  const codeInput = doc.getElementById("tagger-code");
  const oppInput = doc.getElementById("tagger-opp");
  const usInput = doc.getElementById("tagger-us");
  const themInput = doc.getElementById("tagger-them");

  const teamGroup = doc.getElementById("tagger-team");
  const jerseysContainer = doc.getElementById("tagger-jerseys");
  const oppEntryForm = doc.getElementById("tagger-opp-entry");
  const oppNumInput = doc.getElementById("tagger-opp-num");
  const oppNameInput = doc.getElementById("tagger-opp-name");
  const eventsContainer = doc.getElementById("tagger-events");
  const padStatusEl = doc.getElementById("tagger-pad-status");
  const undoBtn = doc.getElementById("tagger-undo");
  const latchBtn = doc.getElementById("tagger-latch");
  const astBeforeBtn = doc.getElementById("tagger-ast-before");

  const pbpListEl = doc.getElementById("tagger-pbp-list");
  const pbpCountEl = doc.getElementById("tagger-pbp-count");
  const toastEl = doc.getElementById("tagger-toast");
  const toastTextEl = doc.getElementById("tagger-toast-text");
  const toastUndoBtn = doc.getElementById("tagger-toast-undo");

  const boxTeamSwitch = doc.getElementById("tagger-box-team");
  const boxTableEl = doc.getElementById("tagger-box-table");
  const boxBodyEl = doc.getElementById("tagger-box-body");
  const boxFootEl = doc.getElementById("tagger-box-foot");
  const mismatchBanner = doc.getElementById("tagger-score-mismatch");

  const rosterListEl = doc.getElementById("tagger-roster-list");
  const rosterDupBanner = doc.getElementById("tagger-roster-dup");
  const saveDefaultRosterBtn = doc.getElementById("tagger-save-default-roster");

  const exportCsvBtn = doc.getElementById("tagger-export-csv");
  const exportBoxBtn = doc.getElementById("tagger-export-box");
  const exportSessionBtn = doc.getElementById("tagger-export-session");
  const importSessionBtn = doc.getElementById("tagger-import-session");
  const importCsvBtn = doc.getElementById("tagger-import-csv");
  const importSessionFile = doc.getElementById("tagger-import-session-file");
  const importCsvFile = doc.getElementById("tagger-import-csv-file");

  let activeTagId = null;
  let editingTagId = null;
  let flashTagId = null;
  let flashTimer = null;
  let toastTimer = null;
  let statusFlashMessage = "";
  let statusFlashTone = "";
  let statusFlashTimer = null;
  let boxViewSide = "gd";
  let codeManuallyEdited = Boolean(session.meta?.code);

  function autosave() {
    const res = saveSessionToStorage(session);
    if (!res.ok) {
      showBanner(
        storageBanner,
        res.quotaExceeded
          ? "Browser storage is full. Export Session JSON now and clear old games."
          : res.message || "Could not autosave to localStorage."
      );
    } else {
      showBanner(storageBanner, null);
    }
  }

  function showToast(message, { allowUndo = false, durationMs = 5000 } = {}) {
    if (!toastEl || !toastTextEl) return;
    if (toastTimer) clearTimeout(toastTimer);
    toastTextEl.textContent = message;
    if (toastUndoBtn) {
      toastUndoBtn.hidden = !allowUndo || getUndoCount(session) === 0;
    }
    toastEl.hidden = false;
    toastTimer = setTimeout(() => {
      toastEl.hidden = true;
    }, durationMs);
  }

  function flashStatus(message, tone = "ok") {
    statusFlashMessage = message;
    statusFlashTone = tone;
    if (statusFlashTimer) clearTimeout(statusFlashTimer);
    renderPadStatus();
    statusFlashTimer = setTimeout(() => {
      statusFlashMessage = "";
      statusFlashTone = "";
      renderPadStatus();
    }, 2200);
  }

  function triggerRowHighlight(tagId) {
    flashTagId = tagId;
    if (flashTimer) clearTimeout(flashTimer);
    flashTimer = setTimeout(() => {
      flashTagId = null;
      const row = pbpListEl?.querySelector(`[data-tag-id="${tagId}"]`);
      row?.classList.remove("is-new");
    }, 1500);
  }

  const videoCtrl = createVideoController(videoEl, {
    placeholderEl,
    fileInputEl,
    onTimeChange(timeSec, formatted) {
      if (timeDisplayEl) timeDisplayEl.textContent = formatted;
    },
    onPlayStateChange(isPlaying) {
      if (playBtn) {
        playBtn.textContent = isPlaying ? "Pause" : "Play";
        playBtn.setAttribute("aria-pressed", String(isPlaying));
      }
    },
    onSpeedChange(rate) {
      if (speedBtn) speedBtn.textContent = formatPlaybackSpeed(rate);
    },
    onFileLoaded({ fileName, durationSec }) {
      if (fileName) session.meta.videoFileName = fileName;
      if (Number.isFinite(durationSec)) session.meta.videoDurationSec = durationSec;
      session.meta.source = "local-recording";
      autosave();
    },
    onError(message) {
      showBanner(videoErrorBanner, message);
    },
  });

  const padCtrl = createPadController({
    getSession: () => session,
    getTimeSec: () => videoCtrl.getCurrentTimeSec(),
    onCommit({ action, tag }) {
      activeTagId = tag.id;
      triggerRowHighlight(tag.id);
      autosave();
      renderAll({ scrollToTagId: tag.id });
      const label = `${tag.time} ${tag.num ? `#${tag.num} ` : ""}${tag.player} ${tag.event}`;
      flashStatus(action === "flip" ? `Flipped: ${label}` : `Logged: ${label}`, "ok");
    },
    onStateChange() {
      renderPad();
    },
  });

  function syncMetaInputsFromSession() {
    if (dateInput) dateInput.value = deriveDateInputValue(session.meta);
    if (codeInput) codeInput.value = session.meta.code || "";
    if (oppInput) oppInput.value = session.meta.opp || "";
    if (usInput) usInput.value = session.meta.usOfficial ?? "";
    if (themInput) themInput.value = session.meta.themOfficial ?? "";
    codeManuallyEdited = Boolean(session.meta?.code);
  }

  function renderPadStatus() {
    if (!padStatusEl) return;
    const { pendingLatch, selectedActor } = padCtrl.getSnapshot();
    if (pendingLatch) {
      const timeStr = formatVideoTime(pendingLatch.timeSec);
      if (pendingLatch.assistBeforeLast) {
        const scorerLabel = pendingLatch.scorerNum
          ? `#${pendingLatch.scorerNum}${pendingLatch.scorerPlayer ? ` ${pendingLatch.scorerPlayer}` : ""}`
          : pendingLatch.scorerPlayer || "last FG";
        if (pendingLatch.selfAssistRejected) {
          padStatusEl.textContent = `Cannot self-assist ${scorerLabel} — tap a different passer # (Esc to cancel)`;
        } else {
          padStatusEl.textContent = `Latched @ ${timeStr} · +AST before ${scorerLabel} — tap passer # (Esc to cancel)`;
        }
      } else if (pendingLatch.event) {
        padStatusEl.textContent = `Latched @ ${timeStr} · ${pendingLatch.event} — tap jersey # (Esc to cancel)`;
      } else {
        padStatusEl.textContent = `Time latched @ ${timeStr} — tap event & jersey (Esc to cancel)`;
      }
      padStatusEl.className = "tagger-status is-latched";
      return;
    }

    if (statusFlashMessage) {
      padStatusEl.textContent = statusFlashMessage;
      padStatusEl.className = `tagger-status ${statusFlashTone === "ok" ? "is-ok" : "is-latched"}`;
      return;
    }

    if (selectedActor) {
      const label = selectedActor.isTeam
        ? "Team"
        : `#${selectedActor.num} ${selectedActor.player}`;
      padStatusEl.textContent = `Selected: ${label} — tap event for 1-tap tag`;
      padStatusEl.className = "tagger-status is-ok";
      return;
    }

    padStatusEl.textContent = "Tap a player for 1-tap, or tap an event first to latch timestamp.";
    padStatusEl.className = "tagger-status";
  }

  function renderPad() {
    const { selectedTeamSide, selectedActor, pendingLatch } = padCtrl.getSnapshot();

    // Team toggle (strict single-select)
    if (teamGroup) {
      const gdBtn = teamGroup.querySelector('[data-team-side="gd"]');
      const oppBtn = teamGroup.querySelector('[data-team-side="opp"]');
      if (gdBtn) gdBtn.setAttribute("aria-pressed", String(selectedTeamSide === "gd"));
      if (oppBtn) {
        oppBtn.setAttribute("aria-pressed", String(selectedTeamSide === "opp"));
        oppBtn.textContent = session.meta.opp ? session.meta.opp : "Opponent";
      }
    }

    // Jersey chips rendered dynamically from active session roster or oppRoster
    if (jerseysContainer) {
      jerseysContainer.innerHTML = "";

      if (selectedTeamSide === "gd") {
        const activePlayers = (session.roster || []).filter((p) => p.active);
        for (const p of activePlayers) {
          const btn = doc.createElement("button");
          btn.type = "button";
          btn.className = "chip2";
          const isSelected = Boolean(
            selectedActor && !selectedActor.isTeam && selectedActor.personId === p.personId
          );
          btn.setAttribute("aria-pressed", String(isSelected));
          btn.dataset.personId = p.personId;
          btn.dataset.num = p.jersey;
          btn.innerHTML = `#${escapeHtml(p.jersey)} <small>${escapeHtml(p.pbpName)}</small>`;
          btn.addEventListener("click", () => {
            padCtrl.selectActor({
              isTeam: false,
              personId: p.personId,
              num: p.jersey,
              player: p.pbpName,
            });
          });
          jerseysContainer.appendChild(btn);
        }
      } else {
        for (const op of session.oppRoster || []) {
          const btn = doc.createElement("button");
          btn.type = "button";
          btn.className = "chip2";
          const isSelected = Boolean(
            selectedActor && !selectedActor.isTeam && String(selectedActor.num) === String(op.num)
          );
          btn.setAttribute("aria-pressed", String(isSelected));
          btn.dataset.num = op.num;
          const shortLabel = op.pbpName && op.pbpName !== `#${op.num}` ? ` <small>${escapeHtml(op.pbpName)}</small>` : "";
          btn.innerHTML = `#${escapeHtml(op.num)}${shortLabel}`;
          btn.addEventListener("click", () => {
            padCtrl.selectActor({
              isTeam: false,
              num: op.num,
              player: op.pbpName || `#${op.num}`,
            });
          });
          jerseysContainer.appendChild(btn);
        }
      }

      // Team chip (single-select)
      const teamChip = doc.createElement("button");
      teamChip.type = "button";
      teamChip.className = "chip2";
      teamChip.dataset.team = "1";
      teamChip.setAttribute("aria-pressed", String(Boolean(selectedActor?.isTeam)));
      teamChip.textContent = "Team";
      teamChip.addEventListener("click", () => {
        padCtrl.selectActor({
          isTeam: true,
          num: "",
          player: TEAM_PLAYER_NAME,
        });
      });
      jerseysContainer.appendChild(teamChip);
    }

    if (oppEntryForm) {
      oppEntryForm.hidden = selectedTeamSide !== "opp";
    }

    // Event chips latched highlight
    if (eventsContainer) {
      for (const btn of eventsContainer.querySelectorAll("[data-event]")) {
        const isLatched = Boolean(pendingLatch?.event === btn.dataset.event);
        btn.setAttribute("aria-pressed", String(isLatched));
      }
    }

    // Undo button state
    if (undoBtn) {
      const count = getUndoCount(session);
      undoBtn.disabled = count === 0;
      undoBtn.textContent = count > 0 ? `Undo (${count})` : "Undo";
    }

    renderPadStatus();
  }

  function buildInlineEditor(tag) {
    const li = doc.createElement("li");
    li.className = "tagger-pbp-edit";
    li.dataset.tagId = tag.id;

    const grid = doc.createElement("div");
    grid.className = "tagger-pbp-edit__grid";

    // Time field with -1s / +1s / Video helpers
    const timeLabel = doc.createElement("label");
    timeLabel.textContent = "Time (M:SS)";
    const timeRow = doc.createElement("div");
    timeRow.className = "tagger-pbp-edit__time";
    const timeInput = doc.createElement("input");
    timeInput.type = "text";
    timeInput.value = tag.time;
    timeInput.setAttribute("aria-label", "Tag time M:SS");

    const minus1Btn = doc.createElement("button");
    minus1Btn.type = "button";
    minus1Btn.textContent = "-1s";
    minus1Btn.addEventListener("click", () => {
      const sec = parseVideoTime(timeInput.value) ?? tag.timeSec;
      timeInput.value = formatVideoTime(Math.max(0, sec - 1));
    });

    const plus1Btn = doc.createElement("button");
    plus1Btn.type = "button";
    plus1Btn.textContent = "+1s";
    plus1Btn.addEventListener("click", () => {
      const sec = parseVideoTime(timeInput.value) ?? tag.timeSec;
      timeInput.value = formatVideoTime(sec + 1);
    });

    const useVidBtn = doc.createElement("button");
    useVidBtn.type = "button";
    useVidBtn.textContent = "Now";
    useVidBtn.title = "Use current video time";
    useVidBtn.addEventListener("click", () => {
      timeInput.value = videoCtrl.getFormattedTime();
    });

    timeRow.append(timeInput, minus1Btn, plus1Btn, useVidBtn);
    timeLabel.appendChild(timeRow);

    // Event select
    const evLabel = doc.createElement("label");
    evLabel.textContent = "Event";
    const evSelect = doc.createElement("select");
    for (const ev of LEGAL_EVENTS) {
      const opt = doc.createElement("option");
      opt.value = ev;
      opt.textContent = ev;
      if (ev === tag.event) opt.selected = true;
      evSelect.appendChild(opt);
    }
    evLabel.appendChild(evSelect);

    // Team select
    const teamLabel = doc.createElement("label");
    teamLabel.textContent = "Team";
    const teamSelect = doc.createElement("select");
    const oppCsv = session.meta?.oppTeamCsv || normalizeOppTeamCsv(session.meta?.opp);
    for (const [val, text] of [
      [OUR_TEAM, OUR_TEAM],
      [oppCsv, session.meta?.opp || oppCsv],
    ]) {
      const opt = doc.createElement("option");
      opt.value = val;
      opt.textContent = text;
      if ((tag.team === OUR_TEAM && val === OUR_TEAM) || (tag.team !== OUR_TEAM && val !== OUR_TEAM)) {
        opt.selected = true;
      }
      teamSelect.appendChild(opt);
    }
    teamLabel.appendChild(teamSelect);

    // Player select
    const playerLabel = doc.createElement("label");
    playerLabel.textContent = "Player";
    const playerSelect = doc.createElement("select");
    playerLabel.appendChild(playerSelect);

    const customNumLabel = doc.createElement("label");
    customNumLabel.textContent = "Custom #";
    const customNumInput = doc.createElement("input");
    customNumInput.type = "text";
    customNumInput.value = tag.num || "";
    customNumLabel.appendChild(customNumInput);

    const customNameLabel = doc.createElement("label");
    customNameLabel.textContent = "Custom name";
    const customNameInput = doc.createElement("input");
    customNameInput.type = "text";
    customNameInput.value = tag.player || "";
    customNameLabel.appendChild(customNameInput);

    function populatePlayersForTeam(teamVal) {
      playerSelect.innerHTML = "";
      if (teamVal === OUR_TEAM) {
        for (const p of session.roster || []) {
          const opt = doc.createElement("option");
          opt.value = `gd:${p.personId}`;
          opt.textContent = `#${p.jersey} ${p.pbpName}${p.active ? "" : " (inactive)"}`;
          if (tag.personId === p.personId || (!tag.personId && tag.num === p.jersey && p.active)) {
            opt.selected = true;
          }
          playerSelect.appendChild(opt);
        }
      } else {
        for (const op of session.oppRoster || []) {
          const opt = doc.createElement("option");
          opt.value = `opp:${op.num}`;
          opt.textContent = `#${op.num} ${op.pbpName}`;
          if (tag.team !== OUR_TEAM && String(tag.num) === String(op.num)) {
            opt.selected = true;
          }
          playerSelect.appendChild(opt);
        }
      }
      const teamOpt = doc.createElement("option");
      teamOpt.value = "team";
      teamOpt.textContent = "TEAM";
      if (tag.player === TEAM_PLAYER_NAME && tag.num === "") {
        teamOpt.selected = true;
      }
      playerSelect.appendChild(teamOpt);

      const customOpt = doc.createElement("option");
      customOpt.value = "custom";
      customOpt.textContent = "Custom # / name";
      if (playerSelect.selectedIndex === -1) {
        customOpt.selected = true;
      }
      playerSelect.appendChild(customOpt);
      toggleCustomFields();
    }

    function toggleCustomFields() {
      const isCustom = playerSelect.value === "custom";
      customNumLabel.hidden = !isCustom;
      customNameLabel.hidden = !isCustom;
    }

    populatePlayersForTeam(teamSelect.value);
    teamSelect.addEventListener("change", () => populatePlayersForTeam(teamSelect.value));
    playerSelect.addEventListener("change", toggleCustomFields);

    grid.append(timeLabel, evLabel, teamLabel, playerLabel, customNumLabel, customNameLabel);

    const errLine = doc.createElement("div");
    errLine.className = "tagger-status is-latched";
    errLine.hidden = true;

    const foot = doc.createElement("div");
    foot.className = "tagger-pbp-edit__foot";

    // Same-second order nudge buttons
    const idx = session.tags.findIndex((t) => t.id === tag.id);
    const prevTag = idx > 0 ? session.tags[idx - 1] : null;
    const nextTag = idx !== -1 && idx < session.tags.length - 1 ? session.tags[idx + 1] : null;

    const nudgeGroup = doc.createElement("div");
    nudgeGroup.className = "tagger-pbp-edit__btns";

    if (prevTag && prevTag.timeSec === tag.timeSec) {
      const upBtn = doc.createElement("button");
      upBtn.type = "button";
      upBtn.className = "btn ghost";
      upBtn.textContent = "Move up";
      upBtn.addEventListener("click", () => {
        const mySeq = tag.seq;
        const prevSeq = prevTag.seq;
        editTag(session, tag.id, { seq: prevSeq });
        editTag(session, prevTag.id, { seq: mySeq });
        autosave();
        renderAll({ scrollToTagId: tag.id });
      });
      nudgeGroup.appendChild(upBtn);
    }
    if (nextTag && nextTag.timeSec === tag.timeSec) {
      const downBtn = doc.createElement("button");
      downBtn.type = "button";
      downBtn.className = "btn ghost";
      downBtn.textContent = "Move down";
      downBtn.addEventListener("click", () => {
        const mySeq = tag.seq;
        const nextSeq = nextTag.seq;
        editTag(session, tag.id, { seq: nextSeq });
        editTag(session, nextTag.id, { seq: mySeq });
        autosave();
        renderAll({ scrollToTagId: tag.id });
      });
      nudgeGroup.appendChild(downBtn);
    }

    const actionGroup = doc.createElement("div");
    actionGroup.className = "tagger-pbp-edit__btns";

    const saveBtn = doc.createElement("button");
    saveBtn.type = "button";
    saveBtn.className = "btn";
    saveBtn.textContent = "Save";

    const cancelBtn = doc.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "btn ghost";
    cancelBtn.textContent = "Cancel";

    function commitEdit() {
      const parsedSec = parseVideoTime(timeInput.value);
      if (parsedSec === null) {
        errLine.textContent = "Enter time as M:SS (for example 0:33 or 34:42).";
        errLine.hidden = false;
        timeInput.focus();
        return;
      }

      const patch = {
        timeSec: parsedSec,
        team: teamSelect.value,
        event: evSelect.value,
      };
      const choice = playerSelect.value;
      if (choice === "team") {
        patch.isTeam = true;
      } else if (choice.startsWith("gd:")) {
        const pid = choice.slice(3);
        const rp = findPlayerByPersonId(session.roster, pid);
        if (rp) {
          patch.personId = rp.personId;
          patch.num = rp.jersey;
          patch.player = rp.pbpName;
        }
      } else if (choice.startsWith("opp:")) {
        const num = choice.slice(4);
        const op = findOppPlayer(session.oppRoster, num);
        patch.num = num;
        patch.player = op?.pbpName || `#${num}`;
      } else {
        const num = customNumInput.value.trim();
        const player = customNameInput.value.trim();
        if (!num && !player) {
          patch.isTeam = true;
        } else {
          patch.num = num;
          patch.player = player || `#${num}`;
        }
      }

      const updated = editTag(session, tag.id, patch);
      editingTagId = null;
      if (updated) {
        activeTagId = updated.id;
        triggerRowHighlight(updated.id);
      }
      autosave();
      renderAll({ scrollToTagId: updated?.id || null });
    }

    function cancelEdit() {
      editingTagId = null;
      renderPbpLog();
    }

    saveBtn.addEventListener("click", commitEdit);
    cancelBtn.addEventListener("click", cancelEdit);
    li.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        cancelEdit();
      } else if (e.key === "Enter" && e.target.tagName !== "BUTTON") {
        e.preventDefault();
        commitEdit();
      }
    });

    actionGroup.append(saveBtn, cancelBtn);
    foot.append(nudgeGroup, actionGroup);
    li.append(grid, errLine, foot);
    return li;
  }

  function removeTagWithUndoToast(tagId) {
    const removed = deleteTag(session, tagId);
    if (!removed) return;
    if (editingTagId === tagId) editingTagId = null;
    if (activeTagId === tagId) activeTagId = null;
    autosave();
    renderAll();
    const who = removed.num ? `#${removed.num} ${removed.player}` : removed.player;
    showToast(`Deleted: ${removed.time} ${who} ${removed.event}`, { allowUndo: true });
  }

  function renderPbpLog({ scrollToTagId = null } = {}) {
    if (!pbpListEl) return;
    const tags = [...(session.tags || [])].sort(compareTags);
    session.tags = tags;

    if (pbpCountEl) {
      pbpCountEl.textContent = `(${tags.length})`;
    }

    pbpListEl.innerHTML = "";
    if (tags.length === 0) {
      const empty = doc.createElement("li");
      empty.className = "tagger-empty";
      empty.innerHTML = "<b>No tags yet</b><span>Tags appear here in chronological order.</span>";
      pbpListEl.appendChild(empty);
      return;
    }

    let scrollRow = null;
    for (const tag of tags) {
      if (editingTagId === tag.id) {
        const editRow = buildInlineEditor(tag);
        pbpListEl.appendChild(editRow);
        if (scrollToTagId === tag.id) scrollRow = editRow;
        continue;
      }

      const li = doc.createElement("li");
      li.className = "tagger-pbp-row";
      if (tag.id === activeTagId) li.classList.add("is-active");
      if (tag.id === flashTagId) li.classList.add("is-new");
      li.dataset.tagId = tag.id;
      li.tabIndex = 0;

      const timeSpan = doc.createElement("span");
      timeSpan.className = "tagger-pbp-time";
      timeSpan.textContent = tag.time;

      const mainDiv = doc.createElement("div");
      mainDiv.className = "tagger-pbp-main";

      if (tag.team !== OUR_TEAM) {
        const teamBadge = doc.createElement("span");
        teamBadge.className = "tagger-pbp-team is-opp";
        teamBadge.textContent = tag.team;
        mainDiv.appendChild(teamBadge);
      }

      const whoSpan = doc.createElement("span");
      whoSpan.innerHTML = tag.num
        ? `<b>#${escapeHtml(tag.num)}</b> ${escapeHtml(tag.player)}`
        : `<b>${escapeHtml(tag.player)}</b>`;
      mainDiv.appendChild(whoSpan);

      const evBadge = doc.createElement("span");
      const isMiss = tag.event.endsWith("MISS") || tag.event === "TURNOVER";
      evBadge.className = `tagger-pbp-ev${isMiss ? " is-miss" : ""}`;
      evBadge.textContent = tag.event;
      mainDiv.appendChild(evBadge);

      const actionsDiv = doc.createElement("div");
      actionsDiv.className = "tagger-pbp-actions";

      const editBtn = doc.createElement("button");
      editBtn.type = "button";
      editBtn.title = "Edit tag (Y)";
      editBtn.setAttribute("aria-label", `Edit ${tag.time} ${tag.event}`);
      editBtn.textContent = "✎";
      editBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        activeTagId = tag.id;
        editingTagId = tag.id;
        renderPbpLog({ scrollToTagId: tag.id });
      });

      const delBtn = doc.createElement("button");
      delBtn.type = "button";
      delBtn.title = "Delete tag (Del)";
      delBtn.setAttribute("aria-label", `Delete ${tag.time} ${tag.event}`);
      delBtn.textContent = "×";
      delBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        removeTagWithUndoToast(tag.id);
      });

      actionsDiv.append(editBtn, delBtn);
      li.append(timeSpan, mainDiv, actionsDiv);

      li.addEventListener("click", () => {
        activeTagId = tag.id;
        videoCtrl.seekTo(tag.timeSec);
        for (const r of pbpListEl.querySelectorAll(".tagger-pbp-row")) {
          r.classList.toggle("is-active", r.dataset.tagId === activeTagId);
        }
      });

      pbpListEl.appendChild(li);
      if (scrollToTagId === tag.id) {
        scrollRow = li;
      }
    }

    if (scrollRow) {
      scrollLogRowIntoView(pbpListEl, scrollRow);
    }
  }

  function renderBoxScore() {
    if (!boxBodyEl || !boxFootEl) return;
    const tallied = tallyGame(session.tags, session.roster, session.pfSidecar);
    const mismatch = getScoreMismatch(session, tallied);
    if (mismatchBanner) {
      if (mismatch.hasMismatch) {
        const parts = [];
        if (mismatch.usDiff !== 0) {
          parts.push(`GD RUSE30 PBP ${mismatch.usPbp} vs official ${mismatch.usOfficial}`);
        }
        if (mismatch.themDiff !== 0) {
          parts.push(`Opponent PBP ${mismatch.themPbp} vs official ${mismatch.themOfficial}`);
        }
        showBanner(mismatchBanner, `Score mismatch: ${parts.join(" · ")}.`);
      } else {
        showBanner(mismatchBanner, null);
      }
    }

    if (boxTeamSwitch) {
      for (const btn of boxTeamSwitch.querySelectorAll("[data-box-side]")) {
        const isOpp = btn.dataset.boxSide === "opp";
        btn.setAttribute("aria-pressed", String(btn.dataset.boxSide === boxViewSide));
        if (isOpp) {
          btn.textContent = session.meta.opp ? session.meta.opp : "Opponent";
        }
      }
    }

    boxBodyEl.innerHTML = "";
    const sideData = boxViewSide === "opp" ? tallied.opp : tallied.gd;

    if (boxViewSide === "gd") {
      const renderedKeys = new Set();
      for (const player of session.roster || []) {
        const stats = sideData.players[player.personId];
        if (!stats) continue;
        renderedKeys.add(player.personId);
        boxBodyEl.appendChild(buildBoxRow(player.jersey, stats, player.personId, "gd"));
      }
      for (const [key, stats] of Object.entries(sideData.players)) {
        if (renderedKeys.has(key)) continue;
        boxBodyEl.appendChild(buildBoxRow(key, stats, key, "gd"));
      }
    } else {
      const renderedOppNums = new Set();
      for (const [num, stats] of Object.entries(sideData.players)) {
        renderedOppNums.add(num);
        const op = findOppPlayer(session.oppRoster, num);
        const oppName = op?.boxName || op?.pbpName;
        const resolvedStats =
          stats.name === `#${num}` && oppName ? { ...stats, name: oppName } : stats;
        boxBodyEl.appendChild(buildBoxRow(num, resolvedStats, num, "opp"));
      }
      for (const op of session.oppRoster || []) {
        if (!op?.num || renderedOppNums.has(op.num)) continue;
        renderedOppNums.add(op.num);
        const pfVal = session.pfSidecar?.opp?.[op.num] ?? 0;
        const zeroStats = createZeroPlayerStats(op.boxName || op.pbpName || `#${op.num}`, pfVal);
        boxBodyEl.appendChild(buildBoxRow(op.num, zeroStats, op.num, "opp"));
      }
    }

    // Preserve active column sort from site sortable table headers across live updates
    const ths = boxTableEl?.tHead?.rows?.[0]?.cells;
    if (ths) {
      for (let ci = 0; ci < ths.length; ci += 1) {
        const dir = ths[ci].getAttribute("aria-sort");
        if (dir !== "ascending" && dir !== "descending") continue;
        const rows = [...boxBodyEl.rows];
        rows.sort((a, b) => {
          const x = a.cells[ci]?.getAttribute("data-s") ?? "";
          const y = b.cells[ci]?.getAttribute("data-s") ?? "";
          let nx = parseFloat(x);
          let ny = parseFloat(y);
          let r;
          if (!Number.isNaN(nx) || !Number.isNaN(ny)) {
            nx = Number.isNaN(nx) ? -1e9 : nx;
            ny = Number.isNaN(ny) ? -1e9 : ny;
            r = nx - ny;
          } else {
            r = String(x).localeCompare(String(y));
          }
          return dir === "ascending" ? r : -r;
        });
        for (const r of rows) {
          boxBodyEl.appendChild(r);
        }
        break;
      }
    }

    const t = sideData.team;
    boxFootEl.innerHTML = `<tr><td>Team</td><td>${t.PTS}</td><td>${t.FGM}-${t.FGA}</td><td>${t.P2M}-${t.P2A}</td><td>${t.P3M}-${t.P3A}</td><td>${t.FTM}-${t.FTA}</td><td>${t.REB}</td><td>${t.AST}</td><td>${t.STL}</td><td>${t.BLK}</td><td>${t.TO}</td><td>${t.PF}</td></tr>`;
  }

  function buildBoxRow(jersey, stats, pfKey, side) {
    const tr = doc.createElement("tr");
    const cleanJersey = String(jersey ?? "").trim();
    const playerSortKey = /^(0|[1-9]\d*)$/.test(cleanJersey) ? cleanJersey : stats.name;
    const fgSort = stats.FGM + stats.FGA * 0.001;
    const p2Sort = stats.P2M + stats.P2A * 0.001;
    const p3Sort = stats.P3M + stats.P3A * 0.001;
    const ftSort = stats.FTM + stats.FTA * 0.001;

    tr.innerHTML = `<td data-s="${escapeHtml(playerSortKey)}"><span class="jn">${escapeHtml(jersey)}</span>${escapeHtml(stats.name)}</td><td data-s="${stats.PTS}">${stats.PTS}</td><td data-s="${fgSort}">${stats.FGM}-${stats.FGA}</td><td data-s="${p2Sort}">${stats.P2M}-${stats.P2A}</td><td data-s="${p3Sort}">${stats.P3M}-${stats.P3A}</td><td data-s="${ftSort}">${stats.FTM}-${stats.FTA}</td><td data-s="${stats.REB}">${stats.REB}</td><td data-s="${stats.AST}">${stats.AST}</td><td data-s="${stats.STL}">${stats.STL}</td><td data-s="${stats.BLK}">${stats.BLK}</td><td data-s="${stats.TO}">${stats.TO}</td>`;

    const pfTd = doc.createElement("td");
    pfTd.setAttribute("data-s", String(stats.PF));
    const stepper = doc.createElement("span");
    stepper.className = "tagger-pf";
    stepper.setAttribute("aria-label", `Personal fouls for ${stats.name}`);

    const minusBtn = doc.createElement("button");
    minusBtn.type = "button";
    minusBtn.title = "PF minus";
    minusBtn.setAttribute("aria-label", `Decrease PF for ${stats.name}`);
    minusBtn.textContent = "-";
    minusBtn.disabled = stats.PF <= 0;
    minusBtn.addEventListener("click", () => {
      if (stats.PF <= 0) return;
      setPf(session, pfKey, side, Math.max(0, stats.PF - 1));
      autosave();
      renderBoxScore();
      renderPad();
    });

    const valSpan = doc.createElement("span");
    valSpan.textContent = String(stats.PF);

    const plusBtn = doc.createElement("button");
    plusBtn.type = "button";
    plusBtn.title = "PF plus";
    plusBtn.setAttribute("aria-label", `Increase PF for ${stats.name}`);
    plusBtn.textContent = "+";
    plusBtn.addEventListener("click", () => {
      setPf(session, pfKey, side, stats.PF + 1);
      autosave();
      renderBoxScore();
      renderPad();
    });

    stepper.append(minusBtn, valSpan, plusBtn);
    pfTd.appendChild(stepper);
    tr.appendChild(pfTd);
    return tr;
  }

  function renderRosterEditor() {
    if (!rosterListEl) return;
    rosterListEl.innerHTML = "";

    const dups = findDuplicateActiveJerseys(session.roster);
    showBanner(
      rosterDupBanner,
      dups.length > 0
        ? `Duplicate active jersey #${dups.join(", #")}. Change one player's jersey number for tonight.`
        : null
    );

    for (const player of session.roster || []) {
      const row = doc.createElement("div");
      row.className = "tagger-roster-row";

      const checkLabel = doc.createElement("label");
      checkLabel.className = "tagger-roster-check";

      const checkbox = doc.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = Boolean(player.active);
      checkbox.setAttribute("aria-label", `Active: ${player.boxName}`);
      checkbox.addEventListener("change", () => {
        session.roster = updateRosterPlayer(session.roster, player.personId, {
          active: checkbox.checked,
        });
        if (checkbox.checked && session.pfSidecar?.gd?.[player.personId] === undefined) {
          session.pfSidecar.gd[player.personId] = 0;
        }
        autosave();
        renderAll();
      });

      const nameSpan = doc.createElement("span");
      nameSpan.textContent = `${player.boxName} (${player.pbpName})`;
      checkLabel.append(checkbox, nameSpan);

      const idHint = doc.createElement("span");
      idHint.className = "muted small";
      idHint.textContent = `ID ${player.personId}`;

      const jerseyInput = doc.createElement("input");
      jerseyInput.type = "text";
      jerseyInput.value = player.jersey;
      jerseyInput.maxLength = 4;
      jerseyInput.setAttribute("aria-label", `Jersey for ${player.boxName}`);
      jerseyInput.addEventListener("input", () => {
        session.roster = updateRosterPlayer(session.roster, player.personId, {
          jersey: jerseyInput.value,
        });
        autosave();
        renderPad();
        renderBoxScore();
        const nextDups = findDuplicateActiveJerseys(session.roster);
        showBanner(
          rosterDupBanner,
          nextDups.length > 0
            ? `Duplicate active jersey #${nextDups.join(", #")}. Change one player's jersey number for tonight.`
            : null
        );
      });

      row.append(checkLabel, idHint, jerseyInput);
      rosterListEl.appendChild(row);
    }
  }

  function renderAll({ scrollToTagId = null } = {}) {
    renderPad();
    renderPbpLog({ scrollToTagId });
    renderBoxScore();
    renderRosterEditor();
  }

  function performUndo() {
    const res = undo(session);
    if (!res.undone) {
      flashStatus("Nothing to undo.", "warn");
      return false;
    }
    editingTagId = null;
    if (activeTagId && !session.tags.some((t) => t.id === activeTagId)) {
      activeTagId = null;
    }
    autosave();
    renderAll();
    flashStatus(`Undid: ${res.description}`, "ok");
    if (toastEl && !toastEl.hidden) {
      toastEl.hidden = true;
    }
    return true;
  }

  function stepSelectedTag(direction) {
    const target = findPrevNextTag(
      session.tags,
      activeTagId,
      videoCtrl.getCurrentTimeSec(),
      direction
    );
    if (!target) {
      flashStatus("No tags in PBP log yet.", "warn");
      return false;
    }
    activeTagId = target.id;
    videoCtrl.seekTo(target.timeSec);
    renderPbpLog({ scrollToTagId: target.id });
    return true;
  }

  // Wire transport controls
  playBtn?.addEventListener("click", () => videoCtrl.togglePlay());
  for (const btn of seekButtons) {
    btn.addEventListener("click", () => {
      videoCtrl.seekBy(Number(btn.dataset.seek) || 0);
    });
  }
  speedBtn?.addEventListener("click", () => videoCtrl.cycleSpeed());
  prevTagBtn?.addEventListener("click", () => stepSelectedTag(-1));
  nextTagBtn?.addEventListener("click", () => stepSelectedTag(1));

  // Wire meta inputs
  dateInput?.addEventListener("input", () => {
    const val = dateInput.value.trim();
    session.meta.date = val;
    session.meta.short = formatShortDate(val) || val;
    if (val && (!codeManuallyEdited || !session.meta.code)) {
      const derivedCode = val.replace(/-/g, "");
      session.meta.code = derivedCode;
      if (codeInput) codeInput.value = derivedCode;
    }
    autosave();
  });

  codeInput?.addEventListener("input", () => {
    const val = codeInput.value.trim();
    session.meta.code = val;
    codeManuallyEdited = Boolean(val);
    autosave();
  });

  oppInput?.addEventListener("input", () => {
    const val = oppInput.value.trim();
    session.meta.opp = val;
    session.meta.oppTeamCsv = normalizeOppTeamCsv(val);
    autosave();
    renderPad();
    renderBoxScore();
  });

  usInput?.addEventListener("input", () => {
    const raw = usInput.value.trim();
    session.meta.usOfficial = raw === "" ? null : Number(raw);
    autosave();
    renderBoxScore();
  });

  themInput?.addEventListener("input", () => {
    const raw = themInput.value.trim();
    session.meta.themOfficial = raw === "" ? null : Number(raw);
    autosave();
    renderBoxScore();
  });

  metaForm?.addEventListener("submit", (e) => e.preventDefault());

  // Wire team toggle
  teamGroup?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-team-side]");
    if (!btn) return;
    padCtrl.setTeamSide(btn.dataset.teamSide);
  });

  // Wire opponent quick jersey entry
  oppEntryForm?.addEventListener("submit", (e) => {
    e.preventDefault();
    const num = oppNumInput?.value.trim() || "";
    if (!num) return;
    const name = oppNameInput?.value.trim() || "";
    session.oppRoster = upsertOppPlayer(session.oppRoster, num, name);
    const entry = findOppPlayer(session.oppRoster, num);
    if (oppNumInput) oppNumInput.value = "";
    if (oppNameInput) oppNameInput.value = "";
    oppNumInput?.blur();
    oppNameInput?.blur();
    autosave();
    padCtrl.selectActor({
      isTeam: false,
      num,
      player: entry?.pbpName || `#${num}`,
    });
    renderPad();
  });

  // Wire event chips
  eventsContainer?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-event]");
    if (!btn) return;
    padCtrl.triggerEvent(btn.dataset.event);
  });

  // Wire pad buttons
  undoBtn?.addEventListener("click", performUndo);
  toastUndoBtn?.addEventListener("click", performUndo);
  latchBtn?.addEventListener("click", () => padCtrl.latchTime());
  astBeforeBtn?.addEventListener("click", () => {
    const res = padCtrl.triggerAssistBeforeLast();
    if (res.reason === "no-made-fg") {
      flashStatus("No made 2PT or 3PT shot in PBP log yet.", "warn");
    }
  });

  // Wire box team switch
  boxTeamSwitch?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-box-side]");
    if (!btn) return;
    boxViewSide = btn.dataset.boxSide === "opp" ? "opp" : "gd";
    renderBoxScore();
  });

  // Wire roster default saver
  saveDefaultRosterBtn?.addEventListener("click", () => {
    const res = saveDefaultRoster(session.roster);
    flashStatus(
      res.ok ? "Saved as default roster for future games." : "Could not save default roster.",
      res.ok ? "ok" : "warn"
    );
  });

  // Wire exports and imports
  exportCsvBtn?.addEventListener("click", () => {
    const code = session.meta.code || "draft";
    downloadTextFile(`glory_pbp_${code}.csv`, exportPbpCsv(session), "text/csv;charset=utf-8");
  });

  exportBoxBtn?.addEventListener("click", () => {
    const code = session.meta.code || "draft";
    const json = JSON.stringify(exportBoxJson(session), null, 2);
    downloadTextFile(`boxscore_${code}.json`, json, "application/json;charset=utf-8");
  });

  exportSessionBtn?.addEventListener("click", () => {
    const code = session.meta.code || "draft";
    downloadTextFile(
      `gdr30_session_${code}.json`,
      exportSessionJson(session),
      "application/json;charset=utf-8"
    );
  });

  importSessionBtn?.addEventListener("click", () => importSessionFile?.click());
  importCsvBtn?.addEventListener("click", () => importCsvFile?.click());

  importSessionFile?.addEventListener("change", async () => {
    const file = importSessionFile.files?.[0];
    importSessionFile.value = "";
    if (!file) return;
    try {
      const text = await file.text();
      session = importSessionJson(text);
      padCtrl.syncSession(session);
      activeTagId = null;
      editingTagId = null;
      syncMetaInputsFromSession();
      autosave();
      renderAll();
      flashStatus(`Imported session (${session.tags.length} tags).`, "ok");
    } catch (err) {
      showToast(`Import failed: ${err?.message || "Invalid session JSON"}`);
    }
  });

  importCsvFile?.addEventListener("change", async () => {
    const file = importCsvFile.files?.[0];
    importCsvFile.value = "";
    if (!file) return;
    try {
      const text = await file.text();
      importPbpCsv(session, text);
      activeTagId = null;
      editingTagId = null;
      autosave();
      renderAll();
      flashStatus(`Imported ${session.tags.length} PBP rows from CSV.`, "ok");
    } catch (err) {
      showToast(`CSV import failed: ${err?.message || "Invalid PBP CSV"}`);
    }
  });

  // Wire locked keyboard shortcuts (capture phase)
  const detachHotkeys = attachHotkeys(doc, (action) => {
    switch (action.type) {
      case "PLAY_PAUSE":
        videoCtrl.togglePlay();
        return true;
      case "SEEK":
        videoCtrl.seekBy(action.deltaSec);
        return true;
      case "SPEED":
        if (action.delta < 0) videoCtrl.slower();
        else videoCtrl.faster();
        return true;
      case "PREV_TAG":
        stepSelectedTag(-1);
        return true;
      case "NEXT_TAG":
        stepSelectedTag(1);
        return true;
      case "EDIT_TAG": {
        if (session.tags.length === 0) {
          flashStatus("No tags to edit.", "warn");
          return true;
        }
        const targetId =
          (activeTagId && session.tags.some((t) => t.id === activeTagId) && activeTagId) ||
          session.tags[session.tags.length - 1].id;
        activeTagId = targetId;
        editingTagId = targetId;
        renderPbpLog({ scrollToTagId: targetId });
        return true;
      }
      case "LATCH":
        padCtrl.latchTime();
        return true;
      case "EVENT":
        padCtrl.triggerEvent(action.event);
        return true;
      case "ASSIST_BEFORE_LAST": {
        const res = padCtrl.triggerAssistBeforeLast();
        if (res.reason === "no-made-fg") {
          flashStatus("No made 2PT or 3PT shot in PBP log yet.", "warn");
        }
        return true;
      }
      case "FLIP_SHOT": {
        const res = padCtrl.flipShot();
        if (!res.flipped) {
          flashStatus("No pending shot or recent shot within 3s to flip.", "warn");
        }
        return true;
      }
      case "TOGGLE_TEAM":
        padCtrl.toggleTeamSide();
        return true;
      case "UNDO":
        performUndo();
        return true;
      case "ESCAPE":
        if (editingTagId) {
          editingTagId = null;
          renderPbpLog();
          return true;
        }
        return padCtrl.cancelLatch();
      case "DELETE_SELECTED":
        if (!activeTagId || editingTagId) return false;
        removeTagWithUndoToast(activeTagId);
        return true;
      case "CLIP_TOAST":
        showToast("Clips are out of MVP (Hoops PBP export omits CLIP rows).");
        return true;
      default:
        return false;
    }
  });

  // Initial sync & render
  syncMetaInputsFromSession();
  renderAll();

  return {
    getSession: () => session,
    videoCtrl,
    padCtrl,
    destroy() {
      detachHotkeys();
      videoCtrl.destroy();
    },
  };
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

if (typeof document !== "undefined" && typeof window !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => initTaggerApp(document, window), {
      once: true,
    });
  } else {
    initTaggerApp(document, window);
  }
}
