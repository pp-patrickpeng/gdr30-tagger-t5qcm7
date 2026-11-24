/**
 * Pure roster and team identity helpers for the GD Ruse30 tagger.
 * Zero DOM dependencies; safe to import in Node and browser ES modules.
 */

export const OUR_TEAM = "GD RUSE30";
export const TEAM_PLAYER_NAME = "TEAM";

/**
 * Canonical 9-person GD Ruse30 roster from DECISIONS.md.
 * Jerseys are per-game defaults and can be overridden on a session roster.
 */
export const DEFAULT_ROSTER = Object.freeze([
  Object.freeze({ personId: "7",  jersey: "7",  pbpName: "H Guo",   boxName: "Hanze Guo",   active: true }),
  Object.freeze({ personId: "17", jersey: "17", pbpName: "R Zhang", boxName: "Ryan Zhang",  active: true }),
  Object.freeze({ personId: "19", jersey: "19", pbpName: "M Tan",   boxName: "Marcus Tan",  active: true }),
  Object.freeze({ personId: "23", jersey: "23", pbpName: "R Li",    boxName: "Roger Li",    active: true }),
  Object.freeze({ personId: "24", jersey: "24", pbpName: "A Peng",  boxName: "Alex Peng",   active: true }),
  Object.freeze({ personId: "30", jersey: "30", pbpName: "J Ren",   boxName: "Joel Ren",    active: true }),
  Object.freeze({ personId: "74", jersey: "74", pbpName: "E Sun",   boxName: "Elison Sun",  active: true }),
  Object.freeze({ personId: "15", jersey: "17", pbpName: "A Wang",  boxName: "Adrian Wang", active: false }),
  Object.freeze({ personId: "7L", jersey: "7",  pbpName: "L Tian",  boxName: "Luke Tian",   active: false }),
]);

/**
 * Return a mutable deep clone of DEFAULT_ROSTER for a new game session.
 * @returns {Array<{personId: string, jersey: string, pbpName: string, boxName: string, active: boolean}>}
 */
export function cloneDefaultRoster() {
  return DEFAULT_ROSTER.map((player) => ({ ...player }));
}

/**
 * Normalize a roster array, preserving per-game jerseys and active flags.
 * Falls back to DEFAULT_ROSTER if input is empty or invalid.
 * @param {Array<object>} roster
 */
export function normalizeRoster(roster) {
  if (!Array.isArray(roster) || roster.length === 0) {
    return cloneDefaultRoster();
  }
  return roster
    .filter((entry) => entry && entry.personId != null && String(entry.personId).trim() !== "")
    .map((entry) => {
      const personId = String(entry.personId).trim();
      const jersey = String(entry.jersey ?? "").trim();
      const pbpName = String(entry.pbpName ?? "").trim();
      const boxName = String(entry.boxName ?? pbpName).trim();
      return {
        personId,
        jersey,
        pbpName: pbpName || boxName || `#${jersey || personId}`,
        boxName: boxName || pbpName || `#${jersey || personId}`,
        active: Boolean(entry.active),
      };
    });
}

/**
 * Look up a GD Ruse30 player by stable personId.
 * @param {Array<object>} roster
 * @param {string|number} personId
 */
export function findPlayerByPersonId(roster, personId) {
  if (!Array.isArray(roster) || personId == null) return null;
  const target = String(personId).trim();
  if (!target) return null;
  return roster.find((p) => String(p.personId).trim() === target) || null;
}

/**
 * Look up a GD Ruse30 player by the jersey worn in this game.
 * Prefers active players when two squad members share a default jersey.
 * @param {Array<object>} roster
 * @param {string|number} jersey
 * @param {{activeOnly?: boolean, preferActive?: boolean}} [options]
 */
export function findPlayerByJersey(roster, jersey, options = {}) {
  if (!Array.isArray(roster) || jersey == null) return null;
  const target = String(jersey).trim();
  if (!target) return null;

  const { activeOnly = false, preferActive = true } = options;
  const activeMatch = roster.find((p) => p.active && String(p.jersey).trim() === target) || null;
  if (activeOnly) return activeMatch;
  if (preferActive && activeMatch) return activeMatch;
  return roster.find((p) => String(p.jersey).trim() === target) || null;
}

/**
 * Return a new roster array with one player's per-game fields updated.
 * @param {Array<object>} roster
 * @param {string} personId
 * @param {{jersey?: string|number, pbpName?: string, boxName?: string, active?: boolean}} patch
 */
export function updateRosterPlayer(roster, personId, patch = {}) {
  const target = String(personId ?? "").trim();
  return normalizeRoster(roster).map((player) => {
    if (player.personId !== target) return player;
    return {
      ...player,
      jersey: patch.jersey !== undefined ? String(patch.jersey).trim() : player.jersey,
      pbpName: patch.pbpName !== undefined ? String(patch.pbpName).trim() : player.pbpName,
      boxName: patch.boxName !== undefined ? String(patch.boxName).trim() : player.boxName,
      active: patch.active !== undefined ? Boolean(patch.active) : player.active,
    };
  });
}

/**
 * Create a Team/unassigned tag identity (empty jersey number, player "TEAM").
 * @returns {{personId: null, num: string, player: string}}
 */
export function createTeamActor() {
  return {
    personId: null,
    num: "",
    player: TEAM_PLAYER_NAME,
  };
}

/**
 * Determine whether a tag represents a team-level event (empty num or "TEAM").
 * @param {string|number} num
 * @param {string} [player]
 * @returns {boolean}
 */
export function isTeamActor(num, player = "") {
  const cleanNum = String(num ?? "").trim();
  const cleanPlayer = String(player ?? "").trim().toUpperCase();
  return cleanNum === "" || cleanPlayer === TEAM_PLAYER_NAME;
}

/**
 * Normalize an opponent team name into the uppercase CSV team column format.
 * @param {string} oppName
 * @returns {string}
 */
export function normalizeOppTeamCsv(oppName) {
  const cleaned = String(oppName ?? "").trim().toUpperCase();
  return cleaned || "OPPONENT";
}

/**
 * Normalize an opponent roster list.
 * @param {Array<object>} oppRoster
 */
export function normalizeOppRoster(oppRoster) {
  if (!Array.isArray(oppRoster)) return [];
  const seen = new Set();
  const out = [];
  for (const entry of oppRoster) {
    if (!entry) continue;
    const num = String(entry.num ?? "").trim();
    if (!num || seen.has(num)) continue;
    seen.add(num);
    const fallback = `#${num}`;
    const pbpName = String(entry.pbpName ?? entry.boxName ?? fallback).trim() || fallback;
    const boxName = String(entry.boxName ?? pbpName).trim() || pbpName;
    out.push({ num, pbpName, boxName });
  }
  return out;
}

/**
 * Find an opponent player in oppRoster by jersey number.
 * @param {Array<object>} oppRoster
 * @param {string|number} num
 */
export function findOppPlayer(oppRoster, num) {
  if (!Array.isArray(oppRoster) || num == null) return null;
  const target = String(num).trim();
  if (!target) return null;
  return oppRoster.find((p) => String(p.num).trim() === target) || null;
}

/**
 * Add or update an opponent player by jersey number, returning a new oppRoster array.
 * Ignores team-level (empty num / TEAM) entries.
 * @param {Array<object>} oppRoster
 * @param {string|number} num
 * @param {string} [name]
 */
export function upsertOppPlayer(oppRoster, num, name = "") {
  const cleanNum = String(num ?? "").trim();
  const cleanName = String(name ?? "").trim();
  const base = normalizeOppRoster(oppRoster);
  if (!cleanNum || cleanName.toUpperCase() === TEAM_PLAYER_NAME) {
    return base;
  }

  const placeholder = `#${cleanNum}`;
  const displayName = cleanName || placeholder;
  const idx = base.findIndex((p) => p.num === cleanNum);
  if (idx === -1) {
    return [...base, { num: cleanNum, pbpName: displayName, boxName: displayName }];
  }

  const existing = base[idx];
  const isIncomingPlaceholder = !cleanName || cleanName === placeholder;
  if (isIncomingPlaceholder && existing.pbpName !== placeholder) {
    return base;
  }
  if (existing.pbpName === displayName && existing.boxName === displayName) {
    return base;
  }

  const next = [...base];
  next[idx] = { num: cleanNum, pbpName: displayName, boxName: displayName };
  return next;
}

/**
 * Collect opponent players from an array of tags into an oppRoster list.
 * @param {Array<object>} tags
 * @param {Array<object>} [initialOppRoster]
 * @param {string} [ourTeam]
 */
export function syncOppRosterFromTags(tags, initialOppRoster = [], ourTeam = OUR_TEAM) {
  let result = normalizeOppRoster(initialOppRoster);
  if (!Array.isArray(tags)) return result;

  const ourUpper = String(ourTeam).trim().toUpperCase();
  for (const tag of tags) {
    if (!tag) continue;
    const teamUpper = String(tag.team ?? "").trim().toUpperCase();
    if (!teamUpper || teamUpper === ourUpper) continue;
    if (isTeamActor(tag.num, tag.player)) continue;
    result = upsertOppPlayer(result, tag.num, tag.player);
  }
  return result;
}
