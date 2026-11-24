/**
 * Core session state model, tag CRUD, 50-step undo stack, CSV/JSON I/O,
 * and localStorage autosave helpers for the GD Ruse30 tagger.
 * Pure ES module with zero DOM dependencies.
 */

import {
  OUR_TEAM,
  TEAM_PLAYER_NAME,
  cloneDefaultRoster,
  findPlayerByJersey,
  findPlayerByPersonId,
  isTeamActor,
  normalizeOppRoster,
  normalizeOppTeamCsv,
  normalizeRoster,
  syncOppRosterFromTags,
  upsertOppPlayer,
} from "./roster.js";
import {
  LEGAL_EVENT_SET,
  compareTags,
  formatVideoTime,
  parseVideoTime,
} from "./tally.js";

export const SCHEMA_VERSION = 1;
export const MAX_UNDO_STEPS = 50;
export const STORAGE_NAMESPACE = "gdr30_tagger_v1:";
export const STORAGE_KEYS = Object.freeze({
  activeCode: `${STORAGE_NAMESPACE}active_code`,
  gamesIndex: `${STORAGE_NAMESPACE}games_index`,
  defaultRoster: `${STORAGE_NAMESPACE}default_roster`,
  gamePrefix: `${STORAGE_NAMESPACE}game:`,
});

const sessionInternals = new WeakMap();

function getInternals(session) {
  let state = sessionInternals.get(session);
  if (!state) {
    let maxSeq = 0;
    let maxTagIdNum = 0;
    if (Array.isArray(session?.tags)) {
      for (const t of session.tags) {
        if (Number.isFinite(Number(t?.seq))) {
          maxSeq = Math.max(maxSeq, Number(t.seq));
        }
        const match = /^tag_(\d+)$/.exec(String(t?.id ?? ""));
        if (match) {
          maxTagIdNum = Math.max(maxTagIdNum, Number(match[1]));
        }
      }
    }
    state = {
      undoStack: [],
      nextSeq: maxSeq + 1,
      nextTagNum: maxTagIdNum + 1,
    };
    sessionInternals.set(session, state);
  }
  return state;
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function sanitizeSource(source) {
  return source === "local-recording" ? "local-recording" : undefined;
}

function normalizeOptionalNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function normalizeMeta(meta = {}) {
  const opp = String(meta.opp ?? "").trim();
  const oppTeamCsv = meta.oppTeamCsv
    ? normalizeOppTeamCsv(meta.oppTeamCsv)
    : opp
      ? normalizeOppTeamCsv(opp)
      : "OPPONENT";

  const out = {
    code: String(meta.code ?? "").trim(),
    date: String(meta.date ?? "").trim(),
    short: String(meta.short ?? "").trim(),
    opp,
    oppTeamCsv,
    usOfficial: normalizeOptionalNumber(meta.usOfficial ?? meta.us),
    themOfficial: normalizeOptionalNumber(meta.themOfficial ?? meta.them),
    n: normalizeOptionalNumber(meta.n),
    season: String(meta.season ?? "").trim(),
    videoFileName: meta.videoFileName ? String(meta.videoFileName) : null,
    videoDurationSec: normalizeOptionalNumber(meta.videoDurationSec),
  };

  const source = sanitizeSource(meta.source);
  if (source) {
    out.source = source;
  }
  return out;
}

function toNonNegInt(value) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function normalizePfSidecar(pfSidecar, roster) {
  const gd = {};
  for (const player of roster) {
    if (player.active) {
      gd[player.personId] = 0;
    }
  }
  if (pfSidecar?.gd && typeof pfSidecar.gd === "object") {
    for (const [key, val] of Object.entries(pfSidecar.gd)) {
      const cleanKey = String(key).trim();
      if (cleanKey) gd[cleanKey] = toNonNegInt(val);
    }
  }

  const opp = {};
  if (pfSidecar?.opp && typeof pfSidecar.opp === "object") {
    for (const [key, val] of Object.entries(pfSidecar.opp)) {
      const cleanKey = String(key).trim();
      if (cleanKey) opp[cleanKey] = toNonNegInt(val);
    }
  }

  return { gd, opp };
}

function nextTagId(session) {
  const internals = getInternals(session);
  const existing = new Set((session.tags || []).map((t) => t.id));
  while (true) {
    const candidate = `tag_${String(internals.nextTagNum++).padStart(4, "0")}`;
    if (!existing.has(candidate)) return candidate;
  }
}

function nextSeq(session) {
  const internals = getInternals(session);
  let maxSeq = internals.nextSeq - 1;
  for (const t of session.tags || []) {
    if (Number.isFinite(Number(t?.seq))) {
      maxSeq = Math.max(maxSeq, Number(t.seq));
    }
  }
  internals.nextSeq = maxSeq + 2;
  return maxSeq + 1;
}

function pushUndo(session, type, description) {
  const internals = getInternals(session);
  internals.undoStack.push({
    type,
    description: String(description ?? type),
    tags: deepClone(session.tags),
    oppRoster: deepClone(session.oppRoster),
    pfSidecar: deepClone(session.pfSidecar),
  });
  if (internals.undoStack.length > MAX_UNDO_STEPS) {
    internals.undoStack.shift();
  }
}

function resolveTeamString(session, rawTeam) {
  const trimmed = String(rawTeam ?? OUR_TEAM).trim();
  const upper = trimmed.toUpperCase();
  if (!upper || upper === OUR_TEAM || upper === "GD") return OUR_TEAM;
  if (upper === "OPP" || upper === "OPPONENT") {
    return session.meta?.oppTeamCsv || "OPPONENT";
  }
  return upper;
}

function resolveTagIdentity(session, team, input) {
  const hasPersonId = input.personId != null && String(input.personId).trim() !== "";
  const isTeam =
    Boolean(input.isTeam) || (!hasPersonId && isTeamActor(input.num ?? "", input.player ?? ""));

  if (isTeam) {
    return { num: "", player: TEAM_PLAYER_NAME, personId: null };
  }

  if (team === OUR_TEAM) {
    let rosterPlayer = null;
    if (input.personId != null && String(input.personId).trim() !== "") {
      rosterPlayer = findPlayerByPersonId(session.roster, input.personId);
    } else if (input.num != null && String(input.num).trim() !== "") {
      rosterPlayer = findPlayerByJersey(session.roster, input.num, { preferActive: true });
    }

    if (rosterPlayer) {
      const num =
        input.num !== undefined && String(input.num).trim() !== ""
          ? String(input.num).trim()
          : rosterPlayer.jersey;
      const player =
        input.player !== undefined && String(input.player).trim() !== ""
          ? String(input.player).trim()
          : rosterPlayer.pbpName;
      return {
        num,
        player,
        personId: rosterPlayer.personId,
      };
    }

    const num = String(input.num ?? "").trim();
    const player = String(input.player ?? "").trim() || (num ? `#${num}` : TEAM_PLAYER_NAME);
    return {
      num,
      player,
      personId: null,
    };
  }

  // Opponent player
  const num = String(input.num ?? "").trim();
  const player = String(input.player ?? "").trim() || (num ? `#${num}` : TEAM_PLAYER_NAME);
  return { num, player, personId: null };
}

function normalizeEventOrThrow(rawEvent) {
  const event = String(rawEvent ?? "").trim().toUpperCase();
  if (!LEGAL_EVENT_SET.has(event)) {
    throw new Error(`Illegal PBP event: "${rawEvent}".`);
  }
  return event;
}

function resolveTimeSec(input) {
  if (input.timeSec !== undefined && input.timeSec !== null && input.timeSec !== "") {
    const n = Math.floor(Number(input.timeSec));
    if (!Number.isFinite(n) || n < 0) {
      throw new Error(`Invalid timeSec: "${input.timeSec}".`);
    }
    return n;
  }
  if (input.time !== undefined && input.time !== null) {
    const parsed = parseVideoTime(String(input.time));
    if (parsed !== null) return parsed;
  }
  throw new Error("A valid non-negative timeSec or M:SS time is required.");
}

/**
 * Create a new SessionState (schemaVersion: 1) seeded with the 9-person default roster.
 * @param {object} [meta]
 * @param {{roster?: Array<object>, oppRoster?: Array<object>}} [options]
 */
export function createSession(meta = {}, options = {}) {
  const roster = options.roster ? normalizeRoster(options.roster) : cloneDefaultRoster();
  const oppRoster = options.oppRoster ? normalizeOppRoster(options.oppRoster) : [];
  const session = {
    schemaVersion: SCHEMA_VERSION,
    meta: normalizeMeta(meta),
    roster,
    oppRoster,
    tags: [],
    pfSidecar: normalizePfSidecar(options.pfSidecar, roster),
  };
  getInternals(session);
  return session;
}

/**
 * Add a PBP tag to the session, maintaining (timeSec ASC, seq ASC) order and pushing undo.
 * @param {object} session
 * @param {object} input
 */
export function addTag(session, input) {
  const event = normalizeEventOrThrow(input?.event);
  const timeSec = resolveTimeSec(input);
  const team = resolveTeamString(session, input?.team);
  const identity = resolveTagIdentity(session, team, input);

  pushUndo(session, "ADD", `Add ${formatVideoTime(timeSec)} ${identity.player} ${event}`);

  const tag = {
    id: input?.id ? String(input.id) : nextTagId(session),
    timeSec,
    time: formatVideoTime(timeSec),
    team,
    num: identity.num,
    player: identity.player,
    event,
    seq: Number.isFinite(Number(input?.seq)) ? Number(input.seq) : nextSeq(session),
  };
  if (identity.personId) {
    tag.personId = identity.personId;
  }

  if (team !== OUR_TEAM && !isTeamActor(tag.num, tag.player)) {
    session.oppRoster = upsertOppPlayer(session.oppRoster, tag.num, tag.player);
  }

  session.tags.push(tag);
  session.tags.sort(compareTags);
  return tag;
}

/**
 * Edit an existing PBP tag by id, pushing an EDIT undo snapshot.
 * @param {object} session
 * @param {string} tagId
 * @param {object} patch
 */
export function editTag(session, tagId, patch = {}) {
  const idx = session.tags.findIndex((t) => t.id === tagId);
  if (idx === -1) return null;

  const prev = session.tags[idx];
  const event = patch.event !== undefined ? normalizeEventOrThrow(patch.event) : prev.event;
  const timeSec =
    patch.timeSec !== undefined || patch.time !== undefined
      ? resolveTimeSec(patch)
      : prev.timeSec;
  const team = patch.team !== undefined ? resolveTeamString(session, patch.team) : prev.team;

  const identityInput = {
    isTeam: patch.isTeam,
    personId:
      patch.personId !== undefined
        ? patch.personId
        : patch.num !== undefined && String(patch.num).trim() !== prev.num
          ? undefined
          : team === prev.team
            ? prev.personId
            : undefined,
    num: patch.num !== undefined ? patch.num : prev.num,
    player:
      patch.player !== undefined
        ? patch.player
        : patch.personId !== undefined || (patch.num !== undefined && String(patch.num).trim() !== prev.num)
          ? undefined
          : prev.player,
  };
  const identity = resolveTagIdentity(session, team, identityInput);

  pushUndo(session, "EDIT", `Edit ${prev.time} ${prev.player} ${prev.event}`);

  const updated = {
    ...prev,
    timeSec,
    time: formatVideoTime(timeSec),
    team,
    num: identity.num,
    player: identity.player,
    event,
    seq: patch.seq !== undefined && Number.isFinite(Number(patch.seq)) ? Number(patch.seq) : prev.seq,
  };
  if (identity.personId) {
    updated.personId = identity.personId;
  } else {
    delete updated.personId;
  }

  if (team !== OUR_TEAM && !isTeamActor(updated.num, updated.player)) {
    session.oppRoster = upsertOppPlayer(session.oppRoster, updated.num, updated.player);
  }

  session.tags[idx] = updated;
  session.tags.sort(compareTags);
  return updated;
}

/**
 * Delete a PBP tag by id, pushing a DELETE undo snapshot.
 * @param {object} session
 * @param {string} tagId
 */
export function deleteTag(session, tagId) {
  const idx = session.tags.findIndex((t) => t.id === tagId);
  if (idx === -1) return null;

  const removed = session.tags[idx];
  pushUndo(session, "DELETE", `Delete ${removed.time} ${removed.player} ${removed.event}`);
  session.tags.splice(idx, 1);
  return removed;
}

/**
 * Insert an ASSIST tag immediately before the last made 2 POINT or 3 POINT shot,
 * guaranteeing pbp.chains() pairs the assist with that basket.
 *
 * @param {object} session
 * @param {{personId?: string, num?: string|number, player?: string, team?: string, timeSec?: number}} input
 */
export function insertAssistBeforeLastShot(session, input = {}) {
  session.tags.sort(compareTags);
  const targetTeam = input.team ? resolveTeamString(session, input.team) : null;

  let shotIdx = -1;
  for (let i = session.tags.length - 1; i >= 0; i -= 1) {
    const t = session.tags[i];
    if (t.event !== "2 POINT" && t.event !== "3 POINT") continue;
    if (targetTeam && t.team !== targetTeam) continue;
    shotIdx = i;
    break;
  }
  if (shotIdx === -1) return null;

  const lastShot = session.tags[shotIdx];
  const team = targetTeam || lastShot.team;
  const identity = resolveTagIdentity(session, team, input);

  // Use lastShot.timeSec unless a valid earlier timeSec with no intervening tags was requested.
  let timeSec = lastShot.timeSec;
  if (input.timeSec !== undefined && input.timeSec !== null) {
    const requested = Math.max(0, Math.floor(Number(input.timeSec)));
    if (Number.isFinite(requested) && requested <= lastShot.timeSec) {
      const hasIntervening = session.tags.some(
        (t, idx) => idx < shotIdx && t.timeSec >= requested && t.timeSec < lastShot.timeSec
      );
      if (!hasIntervening) {
        timeSec = requested;
      }
    }
  }

  pushUndo(session, "ADD", `Insert ASSIST before ${lastShot.time} ${lastShot.player}`);

  const insertSeq = lastShot.seq;
  for (let i = 0; i < session.tags.length; i += 1) {
    const t = session.tags[i];
    if (t.timeSec === timeSec && t.seq >= insertSeq) {
      t.seq += 1;
    }
  }
  const internals = getInternals(session);
  internals.nextSeq = Math.max(internals.nextSeq, ...session.tags.map((t) => t.seq + 1), insertSeq + 2);

  const assistTag = {
    id: nextTagId(session),
    timeSec,
    time: formatVideoTime(timeSec),
    team,
    num: identity.num,
    player: identity.player,
    event: "ASSIST",
    seq: insertSeq,
  };
  if (identity.personId) {
    assistTag.personId = identity.personId;
  }

  if (team !== OUR_TEAM && !isTeamActor(assistTag.num, assistTag.player)) {
    session.oppRoster = upsertOppPlayer(session.oppRoster, assistTag.num, assistTag.player);
  }

  session.tags.push(assistTag);
  session.tags.sort(compareTags);
  return assistTag;
}

/**
 * Update a player's personal foul count in pfSidecar only (never creates a PBP row).
 * GD fouls are keyed by personId; opponent fouls may be keyed by jersey.
 *
 * @param {object} session
 * @param {string|number} personIdOrOppKey
 * @param {"gd"|"opp"|string} teamSide
 * @param {number} value
 */
export function setPf(session, personIdOrOppKey, teamSide, value) {
  const key = String(personIdOrOppKey ?? "").trim();
  if (!key) {
    throw new Error("A personId or opponent jersey key is required for setPf.");
  }
  const sideUpper = String(teamSide ?? "gd").trim().toUpperCase();
  const side = sideUpper === "GD" || sideUpper === OUR_TEAM ? "gd" : "opp";
  const nextVal = toNonNegInt(value);

  pushUndo(session, "SET_PF", `Set ${side} PF[${key}] = ${nextVal}`);

  if (!session.pfSidecar || typeof session.pfSidecar !== "object") {
    session.pfSidecar = { gd: {}, opp: {} };
  }
  if (!session.pfSidecar[side] || typeof session.pfSidecar[side] !== "object") {
    session.pfSidecar[side] = {};
  }
  session.pfSidecar[side][key] = nextVal;
  return nextVal;
}

/**
 * Revert the most recent ADD, EDIT, DELETE, SET_PF, or IMPORT_CSV mutation.
 * @param {object} session
 * @returns {{undone: boolean, type?: string, description?: string}}
 */
export function undo(session) {
  const internals = getInternals(session);
  if (internals.undoStack.length === 0) {
    return { undone: false };
  }
  const entry = internals.undoStack.pop();
  session.tags = entry.tags;
  session.oppRoster = entry.oppRoster;
  session.pfSidecar = entry.pfSidecar;
  return {
    undone: true,
    type: entry.type,
    description: entry.description,
  };
}

/**
 * Inspect how many undo steps are currently available for a session.
 * @param {object} session
 */
export function getUndoCount(session) {
  return getInternals(session).undoStack.length;
}

function parseCsvRows(csvText) {
  const text = String(csvText ?? "").replace(/^\uFEFF/, "");
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\r") {
      if (text[i + 1] === "\n") i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += ch;
    }
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0].trim() === ""));
}

/**
 * Import an existing Hoops/Glory PBP CSV (`time,team,num,player,event`) into a session.
 * Drops CLIP, FOUL, and any unknown events. Does NOT invent PF from CSV.
 *
 * Accepts either `importPbpCsv(session, csvText, options?)` or `importPbpCsv(csvText, options?)`.
 */
export function importPbpCsv(sessionOrCsv, csvOrOptions, maybeOptions) {
  let session;
  let csvText;
  let options;

  if (typeof sessionOrCsv === "string") {
    options = csvOrOptions || {};
    session = createSession(options.meta || {}, { roster: options.roster });
    csvText = sessionOrCsv;
  } else {
    session = sessionOrCsv;
    csvText = csvOrOptions;
    options = maybeOptions || {};
  }

  const rows = parseCsvRows(csvText);
  if (rows.length === 0) {
    throw new Error("CSV is empty.");
  }

  const header = rows[0].map((h) => h.trim().toLowerCase());
  const colIdx = {
    time: header.indexOf("time"),
    team: header.indexOf("team"),
    num: header.indexOf("num"),
    player: header.indexOf("player"),
    event: header.indexOf("event"),
  };
  if (Object.values(colIdx).some((i) => i === -1)) {
    throw new Error("CSV header must contain time,team,num,player,event.");
  }

  pushUndo(session, "IMPORT_CSV", "Import PBP CSV");

  const importedTags = [];
  let seq = 1;
  let detectedOppCsv = "";

  for (let i = 1; i < rows.length; i += 1) {
    const r = rows[i];
    const event = String(r[colIdx.event] ?? "").trim().toUpperCase();
    if (!LEGAL_EVENT_SET.has(event)) continue;

    const timeSec = parseVideoTime(String(r[colIdx.time] ?? ""));
    if (timeSec === null) continue;

    const team = String(r[colIdx.team] ?? "").trim().toUpperCase();
    if (!team) continue;
    if (team !== OUR_TEAM && !detectedOppCsv) {
      detectedOppCsv = team;
    }

    const rawNum = String(r[colIdx.num] ?? "").trim();
    const rawPlayer = String(r[colIdx.player] ?? "").trim();
    const isTeam = isTeamActor(rawNum, rawPlayer);

    const tag = {
      id: `tag_${String(seq).padStart(4, "0")}`,
      timeSec,
      time: formatVideoTime(timeSec),
      team,
      num: isTeam ? "" : rawNum,
      player: isTeam ? TEAM_PLAYER_NAME : rawPlayer,
      event,
      seq,
    };

    if (!isTeam && team === OUR_TEAM) {
      const rosterPlayer = findPlayerByJersey(session.roster, rawNum, { preferActive: true });
      if (rosterPlayer) {
        tag.personId = rosterPlayer.personId;
      }
    }

    importedTags.push(tag);
    seq += 1;
  }

  importedTags.sort(compareTags);
  session.tags = importedTags;
  session.oppRoster = syncOppRosterFromTags(importedTags, [], OUR_TEAM);

  if (detectedOppCsv && (!session.meta.oppTeamCsv || session.meta.oppTeamCsv === "OPPONENT")) {
    session.meta.oppTeamCsv = detectedOppCsv;
  }

  // Never invent PF from CSV; reset sidecar to 0 unless caller explicitly preserves it.
  if (!options.preservePf) {
    session.pfSidecar = normalizePfSidecar(null, session.roster);
  }

  const internals = getInternals(session);
  internals.nextSeq = seq;
  internals.nextTagNum = seq;

  return session;
}

/**
 * Serialize a SessionState backup JSON string (schemaVersion: 1).
 * @param {object} session
 * @param {{pretty?: boolean}} [options]
 * @returns {string}
 */
export function exportSessionJson(session, { pretty = true } = {}) {
  const payload = {
    schemaVersion: SCHEMA_VERSION,
    meta: normalizeMeta(session?.meta),
    roster: normalizeRoster(session?.roster),
    oppRoster: normalizeOppRoster(session?.oppRoster),
    tags: Array.isArray(session?.tags) ? deepClone(session.tags).sort(compareTags) : [],
    pfSidecar: normalizePfSidecar(session?.pfSidecar, normalizeRoster(session?.roster)),
  };
  return JSON.stringify(payload, null, pretty ? 2 : 0);
}

/**
 * Parse and validate a SessionState backup JSON string or object (schemaVersion: 1).
 * @param {string|object} jsonInput
 */
export function importSessionJson(jsonInput) {
  const raw = typeof jsonInput === "string" ? JSON.parse(jsonInput) : jsonInput;
  if (!raw || typeof raw !== "object") {
    throw new Error("Invalid session JSON.");
  }
  if (raw.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(`Unsupported session schemaVersion: ${raw.schemaVersion}.`);
  }
  if (!Array.isArray(raw.tags)) {
    throw new Error("Session JSON is missing a tags array.");
  }

  const roster = normalizeRoster(raw.roster);
  const meta = normalizeMeta(raw.meta);
  const tags = [];
  let seqFallback = 1;

  for (const rawTag of raw.tags) {
    if (!rawTag) continue;
    const event = String(rawTag.event ?? "").trim().toUpperCase();
    if (!LEGAL_EVENT_SET.has(event)) continue;

    const timeSec =
      rawTag.timeSec !== undefined && rawTag.timeSec !== null
        ? Math.max(0, Math.floor(Number(rawTag.timeSec)))
        : parseVideoTime(String(rawTag.time ?? ""));
    if (timeSec === null || !Number.isFinite(timeSec)) continue;

    const team = String(rawTag.team ?? "").trim().toUpperCase();
    const isTeam = isTeamActor(rawTag.num, rawTag.player);
    const num = isTeam ? "" : String(rawTag.num ?? "").trim();
    const player = isTeam ? TEAM_PLAYER_NAME : String(rawTag.player ?? "").trim();
    const seq = Number.isFinite(Number(rawTag.seq)) ? Number(rawTag.seq) : seqFallback;

    const cleanTag = {
      id: rawTag.id ? String(rawTag.id) : `tag_${String(seqFallback).padStart(4, "0")}`,
      timeSec,
      time: formatVideoTime(timeSec),
      team,
      num,
      player,
      event,
      seq,
    };

    if (!isTeam && team === OUR_TEAM) {
      if (rawTag.personId) {
        cleanTag.personId = String(rawTag.personId).trim();
      } else {
        const match = findPlayerByJersey(roster, num, { preferActive: true });
        if (match) cleanTag.personId = match.personId;
      }
    }

    tags.push(cleanTag);
    seqFallback += 1;
  }

  tags.sort(compareTags);
  const oppRoster = syncOppRosterFromTags(tags, normalizeOppRoster(raw.oppRoster), OUR_TEAM);

  const session = {
    schemaVersion: SCHEMA_VERSION,
    meta,
    roster,
    oppRoster,
    tags,
    pfSidecar: normalizePfSidecar(raw.pfSidecar, roster),
  };
  getInternals(session);
  return session;
}

// ---------------------------------------------------------------------------
// localStorage autosave helpers (storage-injectable for Node unit tests)
// ---------------------------------------------------------------------------

function getDefaultStorage() {
  try {
    if (typeof globalThis !== "undefined" && globalThis.localStorage) {
      return globalThis.localStorage;
    }
  } catch {
    return null;
  }
  return null;
}

function isQuotaError(err) {
  if (!err) return false;
  const name = String(err.name || "");
  const code = Number(err.code);
  return (
    name === "QuotaExceededError" ||
    name === "NS_ERROR_DOM_QUOTA_REACHED" ||
    code === 22 ||
    code === 1014 ||
    /quota/i.test(String(err.message || ""))
  );
}

function safeSetItem(storage, key, value) {
  if (!storage || typeof storage.setItem !== "function") {
    return {
      ok: false,
      quotaExceeded: false,
      unavailable: true,
      message: "Storage is unavailable.",
    };
  }
  try {
    storage.setItem(key, String(value));
    return { ok: true, quotaExceeded: false };
  } catch (error) {
    return {
      ok: false,
      quotaExceeded: isQuotaError(error),
      error,
      message: error?.message || "Failed to write to storage.",
    };
  }
}

function safeGetItem(storage, key) {
  if (!storage || typeof storage.getItem !== "function") return null;
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function safeRemoveItem(storage, key) {
  if (!storage || typeof storage.removeItem !== "function") return;
  try {
    storage.removeItem(key);
  } catch {
    // ignore cleanup failures
  }
}

/**
 * List saved game index entries from storage.
 * @param {object} [storage]
 */
export function listSavedGames(storage = getDefaultStorage()) {
  const raw = safeGetItem(storage, STORAGE_KEYS.gamesIndex);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Save a SessionState under `gdr30_tagger_v1:game:<code>`, update `active_code`
 * and `games_index`. Returns `{ ok, quotaExceeded?, message? }`.
 *
 * @param {object} session
 * @param {object} [storage]
 */
export function saveSessionToStorage(session, storage = getDefaultStorage()) {
  const code = String(session?.meta?.code ?? "").trim() || "draft";
  const gameKey = `${STORAGE_KEYS.gamePrefix}${code}`;
  const serialized = exportSessionJson(session, { pretty: false });

  const writeGame = safeSetItem(storage, gameKey, serialized);
  if (!writeGame.ok) return writeGame;

  const writeActive = safeSetItem(storage, STORAGE_KEYS.activeCode, code);
  if (!writeActive.ok) return writeActive;

  const currentIndex = listSavedGames(storage).filter((entry) => entry && entry.code !== code);
  currentIndex.unshift({
    code,
    short: String(session?.meta?.short ?? ""),
    opp: String(session?.meta?.opp ?? ""),
    updatedAt: new Date().toISOString(),
    tagCount: Array.isArray(session?.tags) ? session.tags.length : 0,
  });

  const writeIndex = safeSetItem(storage, STORAGE_KEYS.gamesIndex, JSON.stringify(currentIndex));
  if (!writeIndex.ok) return writeIndex;

  return { ok: true, code, key: gameKey, quotaExceeded: false };
}

/**
 * Load a saved SessionState by game code.
 * @param {string} code
 * @param {object} [storage]
 */
export function loadSessionFromStorage(code, storage = getDefaultStorage()) {
  const cleanCode = String(code ?? "").trim();
  if (!cleanCode) return null;
  const raw = safeGetItem(storage, `${STORAGE_KEYS.gamePrefix}${cleanCode}`);
  if (!raw) return null;
  try {
    return importSessionJson(raw);
  } catch {
    return null;
  }
}

/**
 * Load the currently active game session from storage (`active_code`), if any.
 * @param {object} [storage]
 */
export function loadActiveSession(storage = getDefaultStorage()) {
  const code = safeGetItem(storage, STORAGE_KEYS.activeCode);
  if (!code) return null;
  return loadSessionFromStorage(code, storage);
}

/**
 * Delete a saved game session from storage and update `games_index` / `active_code`.
 * @param {string} code
 * @param {object} [storage]
 */
export function deleteSavedGame(code, storage = getDefaultStorage()) {
  const cleanCode = String(code ?? "").trim();
  if (!cleanCode) return { ok: true };

  safeRemoveItem(storage, `${STORAGE_KEYS.gamePrefix}${cleanCode}`);
  if (safeGetItem(storage, STORAGE_KEYS.activeCode) === cleanCode) {
    safeRemoveItem(storage, STORAGE_KEYS.activeCode);
  }
  const updatedIndex = listSavedGames(storage).filter((entry) => entry && entry.code !== cleanCode);
  return safeSetItem(storage, STORAGE_KEYS.gamesIndex, JSON.stringify(updatedIndex));
}

/**
 * Persist default GD Ruse30 roster overrides under `gdr30_tagger_v1:default_roster`.
 * @param {Array<object>} roster
 * @param {object} [storage]
 */
export function saveDefaultRoster(roster, storage = getDefaultStorage()) {
  const normalized = normalizeRoster(roster);
  return safeSetItem(storage, STORAGE_KEYS.defaultRoster, JSON.stringify(normalized));
}

/**
 * Load saved default GD Ruse30 roster overrides, falling back to DEFAULT_ROSTER.
 * @param {object} [storage]
 */
export function loadDefaultRoster(storage = getDefaultStorage()) {
  const raw = safeGetItem(storage, STORAGE_KEYS.defaultRoster);
  if (!raw) return cloneDefaultRoster();
  try {
    return normalizeRoster(JSON.parse(raw));
  } catch {
    return cloneDefaultRoster();
  }
}

/**
 * Optional OOP wrapper over a SessionState for callers preferring class methods.
 */
export class Session {
  constructor(meta = {}, options = {}) {
    this.state = createSession(meta, options);
  }
  addTag(input) {
    return addTag(this.state, input);
  }
  editTag(tagId, patch) {
    return editTag(this.state, tagId, patch);
  }
  deleteTag(tagId) {
    return deleteTag(this.state, tagId);
  }
  insertAssistBeforeLastShot(input) {
    return insertAssistBeforeLastShot(this.state, input);
  }
  setPf(personIdOrOppKey, teamSide, value) {
    return setPf(this.state, personIdOrOppKey, teamSide, value);
  }
  undo() {
    return undo(this.state);
  }
  importPbpCsv(csvText, options) {
    return importPbpCsv(this.state, csvText, options);
  }
  exportJson(options) {
    return exportSessionJson(this.state, options);
  }
  save(storage) {
    return saveSessionToStorage(this.state, storage);
  }
}
