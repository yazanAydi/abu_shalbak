import { useCallback, useEffect, useRef, useState } from "react";

const MEDIA_ATTEMPTS = [
  { video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } } },
  { video: { facingMode: "user" } },
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

export function useCameraVideo() {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const [active, setActive] = useState(false);
  const [error, setError] = useState("");

  const stop = useCallback(() => {
    if (streamRef.current) {
      for (const track of streamRef.current.getTracks()) {
        track.stop();
      }
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    setActive(false);
  }, []);

  const start = useCallback(async () => {
    setError("");
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error("المتصفح لا يدعم الكاميرا — استخدم HTTPS");
      }
      stop();
      const stream = await openCameraStream();
      streamRef.current = stream;
      const video = videoRef.current;
      if (!video) {
        throw new Error("عنصر الفيديو غير جاهز");
      }
      video.srcObject = stream;
      await video.play();
      setActive(true);
    } catch (e) {
      const msg =
        e?.name === "NotAllowedError"
          ? "يجب السماح بالوصول إلى الكاميرا"
          : e?.message || "فشل تشغيل الكاميرا";
      setError(msg);
      setActive(false);
      throw e;
    }
  }, [stop]);

  useEffect(() => () => stop(), [stop]);

  return { videoRef, active, error, start, stop };
}
