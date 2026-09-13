import scanSuccessUrl from "../assets/sounds/scan-success.mp3";
import productNotFoundUrl from "../assets/sounds/product-not-found.mp3";
import checkoutDoneUrl from "../assets/sounds/checkout-done.mp3";
import approvalDecisionUrl from "../assets/sounds/approval-decision.mp3";

const URLS = {
  scanSuccess: scanSuccessUrl,
  productNotFound: productNotFoundUrl,
  checkoutDone: checkoutDoneUrl,
  approvalDecision: approvalDecisionUrl,
};

const MAX_MS = {
  scanSuccess: 650,
  productNotFound: 1300,
  checkoutDone: 1200,
  approvalDecision: 1200,
};

const pools = {};
const buffers = {};
let audioCtx = null;
let unlocked = false;
let active = null;
let stopTimer = null;
let pendingPlayback = null;

const unlockClip = new Audio(
  "data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA"
);

function getAudioContext() {
  if (!audioCtx && typeof window !== "undefined") {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (Ctx) audioCtx = new Ctx();
  }
  return audioCtx;
}

function initPool(name) {
  if (pools[name]) return pools[name];
  const pool = [0, 1].map(() => {
    const audio = new Audio(URLS[name]);
    audio.preload = "auto";
    audio.load();
    return audio;
  });
  pool.idx = 0;
  pools[name] = pool;
  return pool;
}

async function decodeSound(name) {
  if (buffers[name]) return buffers[name];
  const ctx = getAudioContext();
  if (!ctx) return null;
  const response = await fetch(URLS[name]);
  const data = await response.arrayBuffer();
  buffers[name] = await ctx.decodeAudioData(data);
  return buffers[name];
}

export function warmPosSounds() {
  initPool("scanSuccess");
  initPool("productNotFound");
  initPool("checkoutDone");
  initPool("approvalDecision");
  const ctx = getAudioContext();
  if (ctx?.state === "suspended") ctx.resume().catch(() => {});
  return Promise.all(Object.keys(URLS).map((name) => decodeSound(name))).catch(() => {});
}

function takeFromPool(name) {
  const pool = initPool(name);
  const audio = pool[pool.idx % 2];
  pool.idx += 1;
  audio.pause();
  audio.currentTime = 0;
  return audio;
}

function stopActive() {
  if (stopTimer) {
    clearTimeout(stopTimer);
    stopTimer = null;
  }
  if (!active) return;
  try {
    if (active.stop) active.stop(0);
    else active.pause();
  } catch {
    // ignore already stopped
  }
  active.onended = null;
  active = null;
}

function primePools() {
  for (const name of Object.keys(URLS)) {
    const pool = initPool(name);
    for (const audio of [pool[0], pool[1]]) {
      audio.muted = true;
      audio.volume = 0;
      audio
        .play()
        .then(() => {
          audio.pause();
          audio.currentTime = 0;
          audio.muted = false;
          audio.volume = 1;
        })
        .catch(() => {
          audio.muted = false;
          audio.volume = 1;
        });
    }
  }
}

export function unlockPosAudio() {
  warmPosSounds();
  const ctx = getAudioContext();
  if (ctx?.state === "suspended") ctx.resume().catch(() => {});
  if (!unlocked) {
    unlocked = true;
    unlockClip.volume = 0.01;
    unlockClip.play().catch(() => {});
    primePools();
  }
  if (pendingPlayback) {
    const name = pendingPlayback;
    pendingPlayback = null;
    play(name);
  }
}

function scheduleStop(handle, maxMs) {
  stopTimer = setTimeout(() => {
    if (active === handle) stopActive();
  }, maxMs);
}

function startHtml(name) {
  const maxMs = MAX_MS[name];
  const audio = takeFromPool(name);
  audio.muted = false;
  audio.volume = 1;
  active = audio;
  audio.onended = () => {
    if (active === audio) stopActive();
  };
  const started = audio.play();
  if (started && typeof started.catch === "function") {
    started.catch(() => {
      pendingPlayback = name;
    });
  }
  scheduleStop(audio, maxMs);
  return audio;
}

function startBuffer(name) {
  const maxMs = MAX_MS[name];
  const maxSec = maxMs / 1000;
  const buffer = buffers[name];
  const ctx = getAudioContext();
  if (!buffer || !ctx || ctx.state !== "running") return startHtml(name);

  const source = ctx.createBufferSource();
  const gain = ctx.createGain();
  gain.gain.value = name === "approvalDecision" ? 2.2 : 1;
  source.buffer = buffer;
  source.connect(gain);
  gain.connect(ctx.destination);
  source.onended = () => {
    if (active === source) stopActive();
  };
  active = source;
  const playLen = Math.min(maxSec, buffer.duration);
  source.start(0, 0, playLen);
  scheduleStop(source, maxMs);
  return source;
}

function startPlayback(name) {
  const buffer = buffers[name];
  const ctx = getAudioContext();
  if (buffer && ctx) {
    if (ctx.state === "suspended") {
      ctx.resume()
        .then(() => startBuffer(name))
        .catch(() => startHtml(name));
      return null;
    }
    return startBuffer(name);
  }
  return startHtml(name);
}

function play(name) {
  stopActive();
  unlockPosAudio();
  startPlayback(name);
}

/** Start error sound immediately (e.g. on scan Enter). Call cancel() on success. */
export function beginProductNotFound() {
  stopActive();
  unlockPosAudio();
  const handle = startPlayback("productNotFound");
  return () => {
    if (active === handle) stopActive();
  };
}

export function playScanSuccess() {
  play("scanSuccess");
}

export function playProductNotFound() {
  play("productNotFound");
}

export function playCheckoutDone() {
  play("checkoutDone");
}

const announcedDecisions = new Set();

function decisionKey(kind, id) {
  if (kind == null || id == null || id === "") return null;
  return `${kind}:${id}`;
}

/** Play the Telegram/admin decision chime once per request (سلف / ذمم / استرجاع). */
export function playApprovalDecision(kind, id) {
  const key = decisionKey(kind, id);
  if (key) {
    if (announcedDecisions.has(key)) return;
    announcedDecisions.add(key);
  }
  delete buffers.approvalDecision;
  decodeSound("approvalDecision").finally(() => {
    play("approvalDecision");
  });
}

if (typeof window !== "undefined") {
  warmPosSounds();
  const opts = { capture: true };
  window.addEventListener("pointerdown", unlockPosAudio, opts);
  window.addEventListener("keydown", unlockPosAudio, opts);
}
