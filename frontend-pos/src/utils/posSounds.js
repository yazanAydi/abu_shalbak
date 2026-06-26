import scanSuccessUrl from "../assets/sounds/scan-success.mp3";
import productNotFoundUrl from "../assets/sounds/product-not-found.mp3";
import checkoutDoneUrl from "../assets/sounds/checkout-done.mp3";

const URLS = {
  scanSuccess: scanSuccessUrl,
  productNotFound: productNotFoundUrl,
  checkoutDone: checkoutDoneUrl,
};

const MAX_MS = {
  scanSuccess: 650,
  productNotFound: 1300,
  checkoutDone: 1200,
};

const pools = {};
const buffers = {};
let audioCtx = null;
let unlocked = false;
let active = null;
let stopTimer = null;

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

export function unlockPosAudio() {
  warmPosSounds();
  const ctx = getAudioContext();
  if (ctx?.state === "suspended") ctx.resume().catch(() => {});
  if (unlocked) return;
  unlocked = true;
  unlockClip.volume = 0.01;
  unlockClip.play().catch(() => {});
}

function scheduleStop(handle, maxMs) {
  stopTimer = setTimeout(() => {
    if (active === handle) stopActive();
  }, maxMs);
}

function startPlayback(name) {
  const maxMs = MAX_MS[name];
  const maxSec = maxMs / 1000;
  const buffer = buffers[name];
  const ctx = getAudioContext();

  if (buffer && ctx) {
    if (ctx.state === "suspended") ctx.resume().catch(() => {});
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    source.onended = () => {
      if (active === source) stopActive();
    };
    active = source;
    const playLen = Math.min(maxSec, buffer.duration);
    source.start(0, 0, playLen);
    scheduleStop(source, maxMs);
    return source;
  }

  const audio = takeFromPool(name);
  active = audio;
  audio.onended = () => {
    if (active === audio) stopActive();
  };
  audio.play().catch(() => {});
  scheduleStop(audio, maxMs);
  return audio;
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

if (typeof window !== "undefined") {
  warmPosSounds();
  const opts = { once: true, capture: true };
  window.addEventListener("pointerdown", unlockPosAudio, opts);
  window.addEventListener("keydown", unlockPosAudio, opts);
}
