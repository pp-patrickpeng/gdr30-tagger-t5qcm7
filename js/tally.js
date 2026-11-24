/**
 * Pure basketball tally engine and CSV / Box JSON exporters.
 * Ports refs/pbp.py tally rules and matches refs/boxscore_shape.json.
 * Zero DOM dependencies; safe to run in Node and browsers.
 */

import {
  OUR_TEAM,
  TEAM_PLAYER_NAME,
  findPlayerByJersey,
  findPlayerByPersonId,
  isTeamActor,
} from "./roster.js";

/**
 * Exact 12 legal Hoops PBP event strings.
 * CLIP and FOUL are never legal PBP export events.
 */
export const LEGAL_EVENTS = Object.freeze([
  "1 POINT",
  "1 POINT MISS",
  "2 POINT",
  "2 POINT MISS",
  "3 POINT",
  "3 POINT MISS",
  "ASSIST",
  "BLOCK",
  "STEAL",
  "OFFENSIVE REBOUND",
  "DEFENSIVE REBOUND",
  "TURNOVER",
]);

export const LEGAL_EVENT_SET = new Set(LEGAL_EVENTS);

/** Exact 18 player keys from refs/boxscore_shape.json. */
export const PLAYER_STAT_KEYS = Object.freeze([
  "name",
  "PTS",
  "FGM",
  "FGA",
  "P2M",
  "P2A",
  "P3M",
  "P3A",
  "FTM",
  "FTA",
  "OREB",
  "DREB",
  "REB",
  "AST",
  "BLK",
  "STL",
  "TO",
  "PF",
]);

/** Exact 17 team keys from refs/boxscore_shape.json. */
export const TEAM_STAT_KEYS = Object.freeze([
  "PTS",
  "FGM",
  "FGA",
  "P2M",
  "P2A",
  "P3M",
  "P3A",
  "FTM",
  "FTA",
  "OREB",
  "DREB",
  "REB",
  "AST",
  "BLK",
  "STL",
  "TO",
  "PF",
]);

function toNonNegInt(value) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Format integer elapsed seconds as M:SS (no zero-padded minutes, e.g. "0:33", "10:36").
 * @param {number} timeSec
 * @returns {string}
 */
export function formatVideoTime(timeSec) {
  const sec = Math.max(0, Math.floor(Number(timeSec) || 0));
  const minutes = Math.floor(sec / 60);
  const seconds = sec % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/**
 * Parse a "M:SS" (or "H:MM:SS") timestamp string into integer seconds, or null if invalid.
 * @param {string} timeStr
 * @returns {number|null}
 */
export function parseVideoTime(timeStr) {
  if (typeof timeStr !== "string") return null;
  const trimmed = timeStr.trim();
  if (!trimmed) return null;
  const parts = trimmed.split(":");
  if (parts.length === 2) {
    const [mStr, sStr] = parts;
    if (!/^\d+$/.test(mStr) || !/^[0-5]\d$/.test(sStr)) return null;
    return Number(mStr) * 60 + Number(sStr);
  }
  if (parts.length === 3) {
    const [hStr, mStr, sStr] = parts;
    if (!/^\d+$/.test(hStr) || !/^[0-5]\d$/.test(mStr) || !/^[0-5]\d$/.test(sStr)) return null;
    return Number(hStr) * 3600 + Number(mStr) * 60 + Number(sStr);
  }
  return null;
}

/**
 * Canonical chronological comparator: (timeSec ASC, seq ASC).
 * @param {object} a
 * @param {object} b
 * @returns {number}
 */
export function compareTags(a, b) {
  const timeDiff = (Number(a?.timeSec) || 0) - (Number(b?.timeSec) || 0);
  if (timeDiff !== 0) return timeDiff;
  const seqDiff = (Number(a?.seq) || 0) - (Number(b?.seq) || 0);
  if (seqDiff !== 0) return seqDiff;
  return String(a?.id ?? "").localeCompare(String(b?.id ?? ""));
}

/**
 * Create a zeroed 17-key team stat object.
 */
export function createZeroTeamStats() {
  return {
    PTS: 0,
    FGM: 0,
    FGA: 0,
    P2M: 0,
    P2A: 0,
    P3M: 0,
    P3A: 0,
    FTM: 0,
    FTA: 0,
    OREB: 0,
    DREB: 0,
    REB: 0,
    AST: 0,
    BLK: 0,
    STL: 0,
    TO: 0,
    PF: 0,
  };
}

/**
 * Create a zeroed 18-key player stat object.
 * @param {string} name
 * @param {number} [pf]
 */
export function createZeroPlayerStats(name, pf = 0) {
  return {
    name: String(name ?? ""),
    PTS: 0,
    FGM: 0,
    FGA: 0,
    P2M: 0,
    P2A: 0,
    P3M: 0,
    P3A: 0,
    FTM: 0,
    FTA: 0,
    OREB: 0,
    DREB: 0,
    REB: 0,
    AST: 0,
    BLK: 0,
    STL: 0,
    TO: 0,
    PF: toNonNegInt(pf),
  };
}

function applyEvent(counts, event) {
  switch (event) {
    case "1 POINT":
      counts.PTS += 1;
      counts.FTM += 1;
      counts.FTA += 1;
      break;
    case "2 POINT":
      counts.PTS += 2;
      counts.P2M += 1;
      counts.P2A += 1;
      break;
    case "3 POINT":
      counts.PTS += 3;
      counts.P3M += 1;
      counts.P3A += 1;
      break;
    case "1 POINT MISS":
      counts.FTA += 1;
      break;
    case "2 POINT MISS":
      counts.P2A += 1;
      break;
    case "3 POINT MISS":
      counts.P3A += 1;
      break;
    case "OFFENSIVE REBOUND":
      counts.OREB += 1;
      break;
    case "DEFENSIVE REBOUND":
      counts.DREB += 1;
      break;
    case "ASSIST":
      counts.AST += 1;
      break;
    case "STEAL":
      counts.STL += 1;
      break;
    case "BLOCK":
      counts.BLK += 1;
      break;
    case "TURNOVER":
      counts.TO += 1;
      break;
    default:
      break;
  }
}

function finalizeDerived(counts) {
  counts.FGM = counts.P2M + counts.P3M;
  counts.FGA = counts.P2A + counts.P3A;
  counts.REB = counts.OREB + counts.DREB;
  return counts;
}

/**
 * Resolve a GD tag to its canonical personId and boxName.
 * Uses tag.personId when present, otherwise matches tag.num against the session roster.
 */
function resolveGdPlayer(tag, roster) {
  const num = String(tag?.num ?? "").trim();
  const player = String(tag?.player ?? "").trim();

  if (tag?.personId != null && String(tag.personId).trim() !== "") {
    const pid = String(tag.personId).trim();
    const rosterEntry = findPlayerByPersonId(roster, pid);
    return {
      key: pid,
      name: rosterEntry?.boxName || player || `#${num || pid}`,
    };
  }

  const byJersey = findPlayerByJersey(roster, num, { preferActive: true });
  if (byJersey) {
    return {
      key: byJersey.personId,
      name: byJersey.boxName,
    };
  }

  return {
    key: num,
    name: player || `#${num}`,
  };
}

/**
 * Tally PBP tags and PF sidecar counts for both GD RUSE30 and Opponent.
 * Exact JS port of refs/pbp.py tally() rules, plus active-roster zero rows and pfSidecar.
 *
 * @param {Array<object>} tags
 * @param {Array<object>} [roster]
 * @param {{gd?: Record<string, number>, opp?: Record<string, number>}} [pfSidecar]
 */
export function tallyGame(tags = [], roster = [], pfSidecar = { gd: {}, opp: {} }) {
  const safeRoster = Array.isArray(roster) ? roster : [];
  const gdPfMap = pfSidecar?.gd || {};
  const oppPfMap = pfSidecar?.opp || {};

  const gdPlayers = {};
  const gdTeam = createZeroTeamStats();
  const oppPlayers = {};
  const oppTeam = createZeroTeamStats();

  // Seed every active GD roster player so zero-stat active players are always present.
  for (const player of safeRoster) {
    if (!player || !player.active) continue;
    const pid = String(player.personId).trim();
    if (!pid) continue;
    gdPlayers[pid] = createZeroPlayerStats(player.boxName || player.pbpName, gdPfMap[pid] ?? 0);
  }

  if (Array.isArray(tags)) {
    for (const tag of tags) {
      if (!tag) continue;
      const event = String(tag.event ?? "").trim().toUpperCase();
      if (!LEGAL_EVENT_SET.has(event)) continue;

      const team = String(tag.team ?? "").trim().toUpperCase();
      const num = String(tag.num ?? "").trim();
      const player = String(tag.player ?? "").trim();
      const isTeam = isTeamActor(num, player);

      if (team === OUR_TEAM) {
        applyEvent(gdTeam, event);
        if (!isTeam) {
          const resolved = resolveGdPlayer(tag, safeRoster);
          if (!gdPlayers[resolved.key]) {
            gdPlayers[resolved.key] = createZeroPlayerStats(
              resolved.name,
              gdPfMap[resolved.key] ?? 0
            );
          }
          applyEvent(gdPlayers[resolved.key], event);
        }
      } else if (team) {
        applyEvent(oppTeam, event);
        if (!isTeam) {
          if (!oppPlayers[num]) {
            oppPlayers[num] = createZeroPlayerStats(player || `#${num}`, oppPfMap[num] ?? 0);
          } else if (player && oppPlayers[num].name === `#${num}`) {
            oppPlayers[num].name = player;
          }
          applyEvent(oppPlayers[num], event);
        }
      }
    }
  }

  // Ensure opponent PF entries with non-zero fouls appear even before a PBP tag exists for them.
  for (const [oppNum, pfVal] of Object.entries(oppPfMap)) {
    const cleanNum = String(oppNum).trim();
    const pf = toNonNegInt(pfVal);
    if (!cleanNum || pf === 0) continue;
    if (!oppPlayers[cleanNum]) {
      oppPlayers[cleanNum] = createZeroPlayerStats(`#${cleanNum}`, pf);
    }
  }

  let gdPfSum = 0;
  for (const p of Object.values(gdPlayers)) {
    finalizeDerived(p);
    gdPfSum += p.PF;
  }
  finalizeDerived(gdTeam);
  gdTeam.PF = gdPfSum;

  let oppPfSum = 0;
  for (const p of Object.values(oppPlayers)) {
    finalizeDerived(p);
    oppPfSum += p.PF;
  }
  finalizeDerived(oppTeam);
  oppTeam.PF = oppPfSum;

  return {
    gd: { players: gdPlayers, team: gdTeam },
    opp: { players: oppPlayers, team: oppTeam },
  };
}

function escapeCsvField(value) {
  const str = String(value ?? "");
  if (str.includes(",") || str.includes('"') || str.includes("\n") || str.includes("\r")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Export tags to Glory/Hoops PBP CSV (`time,team,num,player,event`).
 * Drops CLIP, FOUL, and any event outside the 12 legal strings.
 * Sorts chronologically by (timeSec ASC, seq ASC). UTF-8 LF with trailing newline.
 *
 * @param {Array<object>|object} tagsOrState
 * @returns {string}
 */
export function exportPbpCsv(tagsOrState) {
  const rawTags = Array.isArray(tagsOrState) ? tagsOrState : tagsOrState?.tags || [];
  const validRows = [];

  for (const tag of rawTags) {
    if (!tag) continue;
    const event = String(tag.event ?? "").trim().toUpperCase();
    if (!LEGAL_EVENT_SET.has(event)) continue;

    let timeSec = tag.timeSec;
    if (timeSec == null || !Number.isFinite(Number(timeSec))) {
      timeSec = parseVideoTime(String(tag.time ?? ""));
    }
    if (timeSec == null || !Number.isFinite(Number(timeSec))) continue;

    const cleanTimeSec = Math.max(0, Math.floor(Number(timeSec)));
    const team = String(tag.team ?? "").trim().toUpperCase();
    const isTeam = isTeamActor(tag.num, tag.player);
    const num = isTeam ? "" : String(tag.num ?? "").trim();
    const player = isTeam ? TEAM_PLAYER_NAME : String(tag.player ?? "").trim();

    validRows.push({
      id: tag.id,
      timeSec: cleanTimeSec,
      seq: Number(tag.seq) || 0,
      time: formatVideoTime(cleanTimeSec),
      team,
      num,
      player,
      event,
    });
  }

  validRows.sort(compareTags);

  const lines = ["time,team,num,player,event"];
  for (const r of validRows) {
    lines.push(
      [
        escapeCsvField(r.time),
        escapeCsvField(r.team),
        escapeCsvField(r.num),
        escapeCsvField(r.player),
        escapeCsvField(r.event),
      ].join(",")
    );
  }
  return `${lines.join("\n")}\n`;
}

function serializeJerseyNumber(jersey) {
  const clean = String(jersey ?? "").trim();
  if (/^(0|[1-9]\d*)$/.test(clean)) return Number(clean);
  return clean;
}

/**
 * Export a Hoops-compatible box-score JSON fragment (`meta`, `players`, `team`).
 * Players are keyed by personId; `meta.numbers` maps personId -> this-game jersey.
 * Official `us`/`them` are preserved when set; `meta.box_pts` is added if PBP PTS differs.
 *
 * @param {object} state
 * @returns {object}
 */
export function exportBoxJson(state) {
  const metaIn = state?.meta || {};
  const roster = Array.isArray(state?.roster) ? state.roster : [];
  const tallied = tallyGame(state?.tags || [], roster, state?.pfSidecar || { gd: {}, opp: {} });

  const hasOfficialUs =
    metaIn.usOfficial !== null &&
    metaIn.usOfficial !== undefined &&
    metaIn.usOfficial !== "" &&
    Number.isFinite(Number(metaIn.usOfficial));

  const hasOfficialThem =
    metaIn.themOfficial !== null &&
    metaIn.themOfficial !== undefined &&
    metaIn.themOfficial !== "" &&
    Number.isFinite(Number(metaIn.themOfficial));

  const us = hasOfficialUs ? Number(metaIn.usOfficial) : tallied.gd.team.PTS;
  const them = hasOfficialThem ? Number(metaIn.themOfficial) : tallied.opp.team.PTS;

  const numbers = {};
  for (const pid of Object.keys(tallied.gd.players)) {
    const rosterPlayer = findPlayerByPersonId(roster, pid);
    if (rosterPlayer) {
      numbers[pid] = serializeJerseyNumber(rosterPlayer.jersey);
    } else if (pid !== "") {
      numbers[pid] = serializeJerseyNumber(pid);
    }
  }

  const meta = {
    date: String(metaIn.date ?? ""),
    short: String(metaIn.short ?? ""),
    code: String(metaIn.code ?? ""),
    opp: String(metaIn.opp ?? ""),
    us,
    them,
  };

  if (metaIn.n !== null && metaIn.n !== undefined && metaIn.n !== "") {
    meta.n = Number(metaIn.n);
  }
  if (metaIn.source === "local-recording") {
    meta.source = "local-recording";
  }
  if (metaIn.season) {
    meta.season = String(metaIn.season);
  }
  if (hasOfficialUs && tallied.gd.team.PTS !== us) {
    meta.box_pts = tallied.gd.team.PTS;
  }
  meta.numbers = numbers;

  return {
    meta,
    players: tallied.gd.players,
    team: tallied.gd.team,
  };
}

/**
 * Compute score mismatch details between PBP-tallied points and typed official scores.
 * @param {object} state
 * @param {object} [tallied]
 */
export function getScoreMismatch(state, tallied = null) {
  const t = tallied || tallyGame(state?.tags || [], state?.roster || [], state?.pfSidecar);
  const meta = state?.meta || {};

  const hasUs =
    meta.usOfficial !== null &&
    meta.usOfficial !== undefined &&
    meta.usOfficial !== "" &&
    Number.isFinite(Number(meta.usOfficial));
  const hasThem =
    meta.themOfficial !== null &&
    meta.themOfficial !== undefined &&
    meta.themOfficial !== "" &&
    Number.isFinite(Number(meta.themOfficial));

  const usDiff = hasUs ? t.gd.team.PTS - Number(meta.usOfficial) : 0;
  const themDiff = hasThem ? t.opp.team.PTS - Number(meta.themOfficial) : 0;

  return {
    usPbp: t.gd.team.PTS,
    usOfficial: hasUs ? Number(meta.usOfficial) : null,
    usDiff,
    themPbp: t.opp.team.PTS,
    themOfficial: hasThem ? Number(meta.themOfficial) : null,
    themDiff,
    hasMismatch: usDiff !== 0 || themDiff !== 0,
  };
}
