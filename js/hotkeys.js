/**
 * Locked keyboard shortcut map and capture-phase listener for the GD Ruse30 tagger.
 * Matches DECISIONS.md exactly (notably S = STEAL, D = DEFENSIVE REBOUND, [ ] = speed, G = latch).
 * Zero global DOM access at import time.
 */

const EDITABLE_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);

/**
 * Return true when keyboard focus is inside an editable form field or contenteditable region.
 * @param {EventTarget|null} target
 * @returns {boolean}
 */
export function isEditableTarget(target) {
  if (!target || typeof target !== "object") return false;
  const tagName = String(target.tagName || "").toUpperCase();
  if (EDITABLE_TAGS.has(tagName)) return true;
  if (target.isContentEditable === true) return true;
  if (typeof target.getAttribute === "function") {
    const ce = target.getAttribute("contenteditable");
    if (ce !== null && ce !== "false") return true;
  }
  return false;
}

/**
 * Return true for the Ctrl+Z / Cmd+Z undo combo (also allowed inside editable fields).
 * @param {KeyboardEvent|object} event
 * @returns {boolean}
 */
export function isUndoCombo(event) {
  if (!event) return false;
  const hasPrimaryModifier = Boolean(event.ctrlKey || event.metaKey);
  if (!hasPrimaryModifier || event.altKey || event.shiftKey) return false;
  return String(event.key || "").toLowerCase() === "z";
}

/**
 * Determine whether `Tab` should toggle GD RUSE30 / Opponent rather than move focus.
 * Leaves Tab untouched inside inputs, header/footer nav, meta form, and non-tagging panels.
 * @param {KeyboardEvent|object} event
 * @returns {boolean}
 */
export function shouldToggleTeamOnTab(event) {
  if (!event || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) {
    return false;
  }
  const target = event.target;
  if (isEditableTarget(target)) return false;

  if (target && typeof target.closest === "function") {
    if (
      target.closest(
        "header.topbar, nav.tabbar, footer, .tagger-meta, .tagger-box, .tagger-export, details.howinfo"
      )
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Pure key-to-action resolver implementing the locked DECISIONS.md hotkey map.
 * Returns `null` when the key should be ignored or left to browser defaults.
 *
 * @param {KeyboardEvent|object} event
 * @returns {object|null}
 */
export function resolveHotkeyAction(event) {
  if (!event || event.defaultPrevented) return null;

  const target = event.target || null;
  const undoCombo = isUndoCombo(event);

  if (isEditableTarget(target)) {
    return undoCombo ? { type: "UNDO", viaCombo: true } : null;
  }

  if (undoCombo) {
    return { type: "UNDO", viaCombo: true };
  }

  // Ignore any other Ctrl/Cmd/Alt combinations so browser shortcuts (Ctrl+C, Cmd+R, etc.) work.
  if (event.ctrlKey || event.metaKey || event.altKey) {
    return null;
  }

  const key = String(event.key || "");
  const code = String(event.code || "");
  const keyLower = key.toLowerCase();
  const shift = Boolean(event.shiftKey);

  if (key === " " || code === "Space") {
    return { type: "PLAY_PAUSE" };
  }
  if (key === "ArrowLeft") {
    return { type: "SEEK", deltaSec: -3 };
  }
  if (key === "ArrowRight") {
    return { type: "SEEK", deltaSec: 3 };
  }
  if (key === "," || key === "<") {
    return { type: "SEEK", deltaSec: -1 };
  }
  if (key === "." || key === ">") {
    return { type: "SEEK", deltaSec: 1 };
  }
  if (key === "[" || code === "BracketLeft") {
    return { type: "SPEED", delta: -1 };
  }
  if (key === "]" || code === "BracketRight") {
    return { type: "SPEED", delta: 1 };
  }
  if (key === "Tab") {
    return shouldToggleTeamOnTab(event) ? { type: "TOGGLE_TEAM" } : null;
  }
  if (key === "Escape") {
    return { type: "ESCAPE" };
  }
  if (key === "Delete") {
    return { type: "DELETE_SELECTED" };
  }

  // Shot shortcuts: 1 / 2 / 3 made; Shift+1 / Shift+2 / Shift+3 missed
  if (code === "Digit1" || code === "Numpad1" || key === "1" || key === "!") {
    return { type: "EVENT", event: shift || key === "!" ? "1 POINT MISS" : "1 POINT" };
  }
  if (code === "Digit2" || code === "Numpad2" || key === "2" || key === "@") {
    return { type: "EVENT", event: shift || key === "@" ? "2 POINT MISS" : "2 POINT" };
  }
  if (code === "Digit3" || code === "Numpad3" || key === "3" || key === "#") {
    return { type: "EVENT", event: shift || key === "#" ? "3 POINT MISS" : "3 POINT" };
  }

  if (keyLower === "a") {
    return shift ? { type: "ASSIST_BEFORE_LAST" } : { type: "EVENT", event: "ASSIST" };
  }

  if (shift) {
    return null;
  }

  switch (keyLower) {
    case "k":
      return { type: "PREV_TAG" };
    case "l":
      return { type: "NEXT_TAG" };
    case "y":
      return { type: "EDIT_TAG" };
    case "g":
      return { type: "LATCH" };
    case "s":
      return { type: "EVENT", event: "STEAL" };
    case "d":
      return { type: "EVENT", event: "DEFENSIVE REBOUND" };
    case "o":
      return { type: "EVENT", event: "OFFENSIVE REBOUND" };
    case "b":
      return { type: "EVENT", event: "BLOCK" };
    case "t":
      return { type: "EVENT", event: "TURNOVER" };
    case "m":
      return { type: "FLIP_SHOT" };
    case "z":
      return { type: "UNDO", viaCombo: false };
    case "c":
      return { type: "CLIP_TOAST" };
    default:
      return null;
  }
}

/**
 * Attach capture-phase keyboard shortcuts to `target` (e.g. the page root).
 * Returns a detach function.
 *
 * @param {EventTarget} target
 * @param {(action: object, event: KeyboardEvent) => boolean|void} onAction
 * @returns {() => void}
 */
export function attachHotkeys(target, onAction) {
  if (!target || typeof target.addEventListener !== "function") {
    throw new Error("attachHotkeys requires an EventTarget.");
  }

  function handleKeyDown(event) {
    const action = resolveHotkeyAction(event);
    if (!action) return;

    const handled = onAction?.(action, event);
    if (handled === false) return;

    event.preventDefault?.();

    // Stop native <video controls> from also handling Space/Arrows after a click on the video.
    if (
      action.type === "PLAY_PAUSE" ||
      action.type === "SEEK" ||
      String(event.target?.tagName || "").toUpperCase() === "VIDEO"
    ) {
      event.stopPropagation?.();
      if (String(event.target?.tagName || "").toUpperCase() === "VIDEO") {
        event.target.blur?.();
      }
    }
  }

  target.addEventListener("keydown", handleKeyDown, { capture: true });

  return () => {
    target.removeEventListener("keydown", handleKeyDown, { capture: true });
  };
}
