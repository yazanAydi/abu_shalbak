import { useCallback, useEffect, useRef, useState } from "react";
import { BrowserMultiFormatReader } from "@zxing/browser";
import { normalizeBarcode } from "../../utils/barcode";

const DEBOUNCE_MS = 2000;
const START_TIMEOUT_MS = 15000;

const BARCODE_FORMATS = [
  "ean_13",
  "ean_8",
  "upc_a",
  "upc_e",
  "code_128",
  "code_39",
];

const MEDIA_ATTEMPTS = [
  { video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } } },
  { video: { facingMode: "environment" } },
  { video: true },
];

async function openCameraStream() {
  let lastErr;
  for (const constraints of MEDIA_ATTEMPTS) {
    try {
      return await navigator.mediaDevices.getUserMedia(constraints);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("تعذّر فتح الكاميرا");
}

function waitForVideoReady(video, timeoutMs) {
  if (video.readyState >= 2 && !video.paused) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("انتهت مهلة تشغيل الكاميرا — أعد المحاولة"));
    }, timeoutMs);

    const onReady = () => {
      cleanup();
      resolve();
    };

    const cleanup = () => {
      clearTimeout(timer);
      video.removeEventListener("loadedmetadata", onReady);
      video.removeEventListener("playing", onReady);
    };

    video.addEventListener("loadedmetadata", onReady, { once: true });
    video.addEventListener("playing", onReady, { once: true });
  });
}

function supportsBarcodeDetector() {
  return typeof window !== "undefined" && "BarcodeDetector" in window;
}

function startBarcodeDetectorLoop(video, onCode) {
  let active = true;
  let busy = false;
  const detector = new window.BarcodeDetector({ formats: BARCODE_FORMATS });

  const tick = async () => {
    if (!active || busy || video.readyState < 2) {
      if (active) requestAnimationFrame(tick);
      return;
    }
    busy = true;
    try {
      const codes = await detector.detect(video);
      if (codes?.length) {
        onCode(normalizeBarcode(codes[0].rawValue));
      }
    } catch {
      /* next frame */
    } finally {
      busy = false;
      if (active) requestAnimationFrame(tick);
    }
  };

  requestAnimationFrame(tick);
  return () => {
    active = false;
  };
}

function cameraErrorMessage(err) {
  if (err?.name === "NotAllowedError") {
    return "تم رفض إذن الكاميرا — فعّله من إعدادات المتصفح";
  }
  if (err?.name === "NotFoundError") {
    return "لم يُعثر على كاميرا في هذا الجهاز";
  }
  if (err?.name === "NotReadableError") {
    return "الكاميرا مستخدمة من تطبيق آخر — أغلقه ثم أعد المحاولة";
  }
  return err?.message || "تعذّر فتح الكاميرا";
}

export function useCameraBarcode({ active, onScan, onError }) {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const stopScanRef = useRef(null);
  const zxingControlsRef = useRef(null);
  const lastScanRef = useRef({ code: "", at: 0 });
  const onScanRef = useRef(onScan);
  const onErrorRef = useRef(onError);
  const [starting, setStarting] = useState(false);

  onScanRef.current = onScan;
  onErrorRef.current = onError;

  const emitScan = useCallback((raw) => {
    const code = normalizeBarcode(raw);
    if (!code) return;
    const now = Date.now();
    const last = lastScanRef.current;
    if (last.code === code && now - last.at < DEBOUNCE_MS) return;
    lastScanRef.current = { code, at: now };
    onScanRef.current?.(code);
  }, []);

  const stop = useCallback(() => {
    stopScanRef.current?.();
    stopScanRef.current = null;
    try {
      zxingControlsRef.current?.stop();
    } catch {
      /* ignore */
    }
    zxingControlsRef.current = null;
    const stream = streamRef.current;
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    const video = videoRef.current;
    if (video) {
      video.srcObject = null;
    }
  }, []);

  useEffect(() => {
    if (!active) {
      stop();
      setStarting(false);
      return undefined;
    }

    let cancelled = false;
    setStarting(true);
    lastScanRef.current = { code: "", at: 0 };

    const start = async () => {
      // Wait for modal video element to mount.
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      if (cancelled) return;

      const video = videoRef.current;
      if (!video) {
        throw new Error("تعذّر تهيئة الكاميرا — أعد المحاولة");
      }

      const stream = await openCameraStream();
      if (cancelled) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }

      streamRef.current = stream;
      video.setAttribute("playsinline", "true");
      video.setAttribute("webkit-playsinline", "true");
      video.muted = true;
      video.playsInline = true;
      video.srcObject = stream;

      await video.play().catch(() => {});
      await waitForVideoReady(video, START_TIMEOUT_MS);
      if (cancelled) return;

      setStarting(false);

      if (supportsBarcodeDetector()) {
        stopScanRef.current = startBarcodeDetectorLoop(video, emitScan);
        return;
      }

      const reader = new BrowserMultiFormatReader(undefined, undefined, {
        delayBetweenScanAttempts: 150,
        tryPlayVideoTimeout: START_TIMEOUT_MS,
      });
      zxingControlsRef.current = await reader.decodeFromVideoElement(
        video,
        (result) => {
          if (cancelled || !result) return;
          emitScan(result.getText());
        }
      );
    };

    start().catch((e) => {
      if (cancelled) return;
      stop();
      setStarting(false);
      onErrorRef.current?.(cameraErrorMessage(e));
    });

    return () => {
      cancelled = true;
      stop();
    };
  }, [active, stop, emitScan]);

  return { videoRef, starting, stop };
}
