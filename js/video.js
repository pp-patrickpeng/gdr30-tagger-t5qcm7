/**
 * Local MP4 <video> controller for the GD Ruse30 tagger.
 * Never touches global DOM objects at import time; all element/URL/event targets are passed in.
 * Videos stay strictly local via URL.createObjectURL and are revoked on replace/pagehide.
 */

import { formatVideoTime } from "./tally.js";

export const SPEED_STEPS = Object.freeze([0.5, 0.75, 1.0, 1.25, 1.5, 2.0]);

/**
 * Integer elapsed seconds for tag timestamps (`Math.floor(video.currentTime)`).
 * @param {{currentTime?: number}|null} videoEl
 * @returns {number}
 */
export function getVideoTimeSec(videoEl) {
  const raw = Number(videoEl?.currentTime);
  if (!Number.isFinite(raw) || raw < 0) return 0;
  return Math.floor(raw);
}

/**
 * Clamp a seek target within `[0, duration]` when duration is known.
 * @param {number} targetSec
 * @param {number} [duration]
 * @returns {number}
 */
export function clampSeekTime(targetSec, duration) {
  const safeTarget = Number.isFinite(Number(targetSec)) ? Math.max(0, Number(targetSec)) : 0;
  if (Number.isFinite(Number(duration)) && Number(duration) > 0) {
    return Math.min(safeTarget, Number(duration));
  }
  return safeTarget;
}

/**
 * Step playback rate along `SPEED_STEPS` in direction `-1` (slower) or `+1` (faster).
 * @param {number} currentRate
 * @param {number} direction
 * @returns {number}
 */
export function stepPlaybackSpeed(currentRate, direction) {
  const rate = Number(currentRate) || 1.0;
  let nearestIdx = 0;
  let bestDiff = Infinity;
  for (let i = 0; i < SPEED_STEPS.length; i += 1) {
    const diff = Math.abs(SPEED_STEPS[i] - rate);
    if (diff < bestDiff) {
      bestDiff = diff;
      nearestIdx = i;
    }
  }
  const dir = direction < 0 ? -1 : 1;
  const nextIdx = Math.min(SPEED_STEPS.length - 1, Math.max(0, nearestIdx + dir));
  return SPEED_STEPS[nextIdx];
}

/**
 * Format playback rate as `1.0x`, `0.75x`, `1.25x`, `2.0x`.
 * @param {number} rate
 * @returns {string}
 */
export function formatPlaybackSpeed(rate) {
  const n = Number(rate);
  if (!Number.isFinite(n) || n <= 0) return "1.0x";
  return Number.isInteger(n) ? `${n.toFixed(1)}x` : `${n}x`;
}

/**
 * Return a helpful amber-banner message when <video> fires a MediaError.
 * @param {{code?: number, message?: string}|null} mediaError
 * @returns {string}
 */
export function describeMediaError(mediaError) {
  const code = Number(mediaError?.code);
  switch (code) {
    case 1:
      return "Video loading was aborted. Choose the local MP4 file again.";
    case 2:
      return "Could not read the local video file. Make sure the file is still accessible on this device.";
    case 3:
      return "Browser could not decode this video. An H.264/AAC MP4 recording is recommended.";
    case 4:
      return "This video format is not supported by your browser. Choose an H.264/AAC MP4 recording you own.";
    default:
      return "Could not load this local video file. Choose an H.264/AAC MP4 recording you own.";
  }
}

/**
 * Create a video controller bound to a `<video>` element.
 *
 * @param {HTMLVideoElement} videoEl
 * @param {object} [options]
 */
export function createVideoController(videoEl, options = {}) {
  if (!videoEl) {
    throw new Error("createVideoController requires a <video> element.");
  }

  const {
    placeholderEl = null,
    fileInputEl = null,
    urlApi = typeof globalThis !== "undefined" ? globalThis.URL : null,
    eventTarget = typeof globalThis !== "undefined" && typeof globalThis.addEventListener === "function"
      ? globalThis
      : null,
    onTimeChange = null,
    onPlayStateChange = null,
    onSpeedChange = null,
    onFileLoaded = null,
    onError = null,
  } = options;

  let currentObjectUrl = null;
  let currentFileName = null;

  function emitTime() {
    const timeSec = getVideoTimeSec(videoEl);
    onTimeChange?.(timeSec, formatVideoTime(timeSec));
  }

  function emitPlayState() {
    const isPlaying = Boolean(!videoEl.paused && !videoEl.ended);
    onPlayStateChange?.(isPlaying);
  }

  function emitSpeed() {
    onSpeedChange?.(Number(videoEl.playbackRate) || 1.0);
  }

  function revokeObjectUrl() {
    if (currentObjectUrl && urlApi && typeof urlApi.revokeObjectURL === "function") {
      try {
        urlApi.revokeObjectURL(currentObjectUrl);
      } catch {
        // Ignore revocation errors on teardown
      }
    }
    currentObjectUrl = null;
  }

  function loadFile(file) {
    if (!file) return null;
    if (!urlApi || typeof urlApi.createObjectURL !== "function") {
      onError?.("Local object URLs are unavailable in this environment.", null);
      return null;
    }

    revokeObjectUrl();
    const nextUrl = urlApi.createObjectURL(file);
    currentObjectUrl = nextUrl;
    currentFileName = file.name ? String(file.name) : null;

    onError?.(null, null);
    videoEl.src = nextUrl;
    if (videoEl.style) {
      videoEl.style.display = "block";
    }
    if (placeholderEl) {
      placeholderEl.hidden = true;
    }
    if (typeof videoEl.load === "function") {
      videoEl.load();
    }
    emitTime();
    emitPlayState();
    emitSpeed();
    onFileLoaded?.({
      fileName: currentFileName,
      durationSec: Number.isFinite(Number(videoEl.duration)) ? Math.round(Number(videoEl.duration)) : null,
    });
    return nextUrl;
  }

  function play() {
    if (typeof videoEl.play === "function") {
      try {
        const res = videoEl.play();
        if (res && typeof res.catch === "function") {
          res.catch(() => {});
        }
      } catch {
        // Ignore autoplay policy rejection
      }
    }
  }

  function pause() {
    if (typeof videoEl.pause === "function") {
      videoEl.pause();
    }
  }

  function togglePlay() {
    if (videoEl.paused || videoEl.ended) {
      play();
    } else {
      pause();
    }
  }

  function seekTo(timeSec) {
    const nextTime = clampSeekTime(timeSec, videoEl.duration);
    videoEl.currentTime = nextTime;
    emitTime();
    return Math.floor(nextTime);
  }

  function seekBy(deltaSec) {
    const base = Number(videoEl.currentTime) || 0;
    return seekTo(base + Number(deltaSec || 0));
  }

  function setSpeed(rate) {
    const clamped = Math.min(
      SPEED_STEPS[SPEED_STEPS.length - 1],
      Math.max(SPEED_STEPS[0], Number(rate) || 1.0)
    );
    videoEl.playbackRate = clamped;
    emitSpeed();
    return clamped;
  }

  function slower() {
    return setSpeed(stepPlaybackSpeed(videoEl.playbackRate, -1));
  }

  function faster() {
    return setSpeed(stepPlaybackSpeed(videoEl.playbackRate, 1));
  }

  function cycleSpeed() {
    const current = Number(videoEl.playbackRate) || 1.0;
    const idx = SPEED_STEPS.findIndex((s) => Math.abs(s - current) < 0.01);
    const nextIdx = idx === -1 ? 2 : (idx + 1) % SPEED_STEPS.length;
    return setSpeed(SPEED_STEPS[nextIdx]);
  }

  function handleLoadedMetadata() {
    emitTime();
    onFileLoaded?.({
      fileName: currentFileName,
      durationSec: Number.isFinite(Number(videoEl.duration)) ? Math.round(Number(videoEl.duration)) : null,
    });
  }

  function handleError() {
    onError?.(describeMediaError(videoEl.error), videoEl.error || null);
  }

  function handleFileChange() {
    const file = fileInputEl?.files?.[0];
    if (file) {
      loadFile(file);
    }
    if (fileInputEl && typeof fileInputEl.blur === "function") {
      fileInputEl.blur();
    }
  }

  function handlePageHide() {
    revokeObjectUrl();
  }

  const videoListeners = [
    ["timeupdate", emitTime],
    ["seeked", emitTime],
    ["loadedmetadata", handleLoadedMetadata],
    ["play", emitPlayState],
    ["pause", emitPlayState],
    ["ended", emitPlayState],
    ["ratechange", emitSpeed],
    ["error", handleError],
  ];

  for (const [evt, fn] of videoListeners) {
    videoEl.addEventListener?.(evt, fn);
  }
  fileInputEl?.addEventListener?.("change", handleFileChange);
  eventTarget?.addEventListener?.("pagehide", handlePageHide);

  function destroy() {
    for (const [evt, fn] of videoListeners) {
      videoEl.removeEventListener?.(evt, fn);
    }
    fileInputEl?.removeEventListener?.("change", handleFileChange);
    eventTarget?.removeEventListener?.("pagehide", handlePageHide);
    revokeObjectUrl();
  }

  return {
    loadFile,
    revokeObjectUrl,
    play,
    pause,
    togglePlay,
    seekTo,
    seekBy,
    setSpeed,
    slower,
    faster,
    cycleSpeed,
    getCurrentTimeSec: () => getVideoTimeSec(videoEl),
    getFormattedTime: () => formatVideoTime(getVideoTimeSec(videoEl)),
    getSpeed: () => Number(videoEl.playbackRate) || 1.0,
    getObjectUrl: () => currentObjectUrl,
    hasVideo: () => Boolean(currentObjectUrl || videoEl.currentSrc || videoEl.src),
    destroy,
  };
}
