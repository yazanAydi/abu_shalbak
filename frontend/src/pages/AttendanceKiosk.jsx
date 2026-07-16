import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useCameraVideo } from "../hooks/useCameraVideo";
import { useFaceRecognition } from "../hooks/useFaceRecognition";
import { fetchKioskDescriptors, isKioskConfigured, postKioskPunch } from "../utils/kioskApi";
import { formatDateTimeAr } from "../utils/payrollHelpers";
import "./AttendanceKiosk.css";

const COOLDOWN_MS = 4000;
const FACE_POLL_MS = 600;

function nextPunchType(lastType) {
  return lastType === "in" ? "out" : "in";
}

function punchActionLabel(type) {
  return type === "in" ? "حضور" : "انصراف";
}

export default function AttendanceKiosk() {
  const { videoRef, active, error: cameraError, start } = useCameraVideo();
  const { ready, loading, error: modelError, detectFace, extractDescriptor, matchFace } =
    useFaceRecognition();

  const [enrolled, setEnrolled] = useState([]);
  const [lastPunchByUser, setLastPunchByUser] = useState({});
  const [loadErr, setLoadErr] = useState("");
  const [status, setStatus] = useState("جاري التحضير…");
  const [result, setResult] = useState(null);
  const [punching, setPunching] = useState(false);
  const [faceReady, setFaceReady] = useState(false);
  const [pendingMatch, setPendingMatch] = useState(null);
  const [cooldownUntil, setCooldownUntil] = useState(0);
  const [cooldownSecs, setCooldownSecs] = useState(0);
  const cooldownUntilRef = useRef(0);

  const loadDescriptors = useCallback(async () => {
    if (!isKioskConfigured()) {
      setLoadErr("مفتاح الكشك غير مُعدّ — أضف REACT_APP_KIOSK_API_KEY");
      return;
    }
    try {
      const rows = await fetchKioskDescriptors();
      setEnrolled(rows);
      setLastPunchByUser(
        Object.fromEntries(rows.map((r) => [r.user_id, r.last_punch_type || null]))
      );
      setLoadErr("");
      if (!rows.length) {
        setStatus("لا يوجد موظفون مسجّلون — سجّل الوجوه من لوحة الإدارة");
      } else {
        setStatus("انظر إلى الكاميرا ثم اضغط الزر");
      }
    } catch (e) {
      setLoadErr(e.message || "فشل تحميل بيانات الوجوه");
    }
  }, []);

  useEffect(() => {
    loadDescriptors();
  }, [loadDescriptors]);

  useEffect(() => {
    if (ready) start().catch(() => {});
  }, [ready, start]);

  useEffect(() => {
    if (!cooldownUntil) {
      setCooldownSecs(0);
      return undefined;
    }
    const tick = () => {
      const left = Math.max(0, Math.ceil((cooldownUntil - Date.now()) / 1000));
      setCooldownSecs(left);
      if (left <= 0) setCooldownUntil(0);
    };
    tick();
    const id = window.setInterval(tick, 250);
    return () => window.clearInterval(id);
  }, [cooldownUntil]);

  useEffect(() => {
    if (!ready || !active || punching || pendingMatch || cooldownUntil > Date.now()) {
      setFaceReady(false);
      return undefined;
    }

    let cancelled = false;
    const poll = async () => {
      const video = videoRef.current;
      if (!video || video.readyState < 2) {
        if (!cancelled) setFaceReady(false);
        return;
      }
      try {
        const face = await detectFace(video);
        if (!cancelled) setFaceReady(!!face);
      } catch {
        if (!cancelled) setFaceReady(false);
      }
    };

    poll();
    const id = window.setInterval(poll, FACE_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [ready, active, punching, pendingMatch, cooldownUntil, detectFace, videoRef]);

  const beginCooldown = useCallback((ms) => {
    const until = Date.now() + ms;
    cooldownUntilRef.current = until;
    setCooldownUntil(until);
  }, []);

  const handleIdentify = useCallback(async () => {
    if (punching || pendingMatch || Date.now() < cooldownUntilRef.current) return;

    const video = videoRef.current;
    if (!video || video.readyState < 2) {
      setStatus("بانتظار الكاميرا…");
      return;
    }

    setPunching(true);
    setResult(null);
    setPendingMatch(null);
    try {
      const descriptor = await extractDescriptor(video);
      if (!descriptor) {
        setStatus("انظر إلى الكاميرا…");
        return;
      }

      const match = matchFace(descriptor, enrolled);
      if (!match) {
        setStatus("لم يتم التعرف — تأكد من تسجيل وجهك مسبقاً");
        return;
      }

      const nextType = nextPunchType(lastPunchByUser[match.user_id]);
      setPendingMatch({
        user_id: match.user_id,
        username: match.username,
        nextType,
      });
      setStatus(`تأكيد التسجيل — ${match.username}`);
    } catch (e) {
      setResult({
        type: "error",
        message: e.message || "فشل التعرف على الوجه",
      });
      beginCooldown(2000);
      window.setTimeout(() => setResult(null), 3000);
    } finally {
      setPunching(false);
    }
  }, [
    punching,
    pendingMatch,
    videoRef,
    extractDescriptor,
    matchFace,
    enrolled,
    lastPunchByUser,
    beginCooldown,
  ]);

  const handleConfirmPunch = useCallback(async () => {
    if (!pendingMatch || punching) return;

    setPunching(true);
    try {
      const punchRes = await postKioskPunch(pendingMatch.user_id);
      beginCooldown(COOLDOWN_MS);
      const punchType = punchRes?.punch?.type === "out" ? "out" : "in";
      setLastPunchByUser((prev) => ({
        ...prev,
        [pendingMatch.user_id]: punchType,
      }));
      setResult({
        type: punchType,
        username: pendingMatch.username,
        message: punchRes?.message || "تم التسجيل",
        time: punchRes?.punch?.punch_time,
        duplicate: Boolean(punchRes?.duplicate),
      });
      setStatus("تم — انتظر الموظف التالي");
      setPendingMatch(null);
      window.setTimeout(() => setResult(null), 3500);
    } catch (e) {
      setResult({
        type: "error",
        message: e.message || "فشل تسجيل الحضور",
      });
      beginCooldown(2000);
      setPendingMatch(null);
      window.setTimeout(() => setResult(null), 3000);
    } finally {
      setPunching(false);
    }
  }, [pendingMatch, punching, beginCooldown]);

  const handleCancelConfirm = useCallback(() => {
    setPendingMatch(null);
    setStatus("انظر إلى الكاميرا ثم اضغط الزر");
  }, []);

  const blockingError = loadErr || modelError || cameraError;
  const isLoading = loading || (!ready && !modelError);
  const inCooldown = cooldownUntil > Date.now();
  const punchDisabled =
    punching || !!blockingError || !active || !enrolled.length || inCooldown || !!pendingMatch;

  const overlayLabel = useMemo(() => {
    if (!active) return "بانتظار الكاميرا…";
    if (faceReady) return "الوجه جاهز";
    return "ابحث عن الوجه في الإطار";
  }, [active, faceReady]);

  return (
    <div className="attendance-kiosk" dir="rtl" lang="ar">
      <h1 className="attendance-kiosk__title">تسجيل الحضور</h1>
      <p className="attendance-kiosk__subtitle">أبو شلبك — التعرف على الوجه</p>

      {isLoading ? (
        <p className="attendance-kiosk__loading">جاري تحميل نماذج التعرف على الوجه…</p>
      ) : (
        <>
          <div
            className={`attendance-kiosk__video-wrap${
              faceReady ? " attendance-kiosk__video-wrap--ready" : ""
            }`}
          >
            <video ref={videoRef} className="attendance-kiosk__video" playsInline muted />
            <div className="attendance-kiosk__overlay">
              <span
                className={
                  faceReady
                    ? "attendance-kiosk__face-indicator attendance-kiosk__face-indicator--ready"
                    : "attendance-kiosk__face-indicator"
                }
              >
                {overlayLabel}
              </span>
            </div>
          </div>

          {pendingMatch ? (
            <div className="attendance-kiosk__confirm">
              <div className="attendance-kiosk__confirm-title">أهلاً {pendingMatch.username}</div>
              <div className="attendance-kiosk__confirm-action">
                سيتم تسجيل: <strong>{punchActionLabel(pendingMatch.nextType)}</strong>
              </div>
              <div className="attendance-kiosk__confirm-actions">
                <button
                  type="button"
                  className="attendance-kiosk__confirm-btn attendance-kiosk__confirm-btn--primary"
                  onClick={handleConfirmPunch}
                  disabled={punching}
                >
                  {punching ? "جاري التسجيل…" : "تأكيد"}
                </button>
                <button
                  type="button"
                  className="attendance-kiosk__confirm-btn attendance-kiosk__confirm-btn--secondary"
                  onClick={handleCancelConfirm}
                  disabled={punching}
                >
                  إلغاء
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              className="attendance-kiosk__punch-btn"
              onClick={handleIdentify}
              disabled={punchDisabled}
            >
              {punching
                ? "جاري التعرف…"
                : inCooldown
                  ? `انتظر ${cooldownSecs} ث`
                  : "تسجيل الحضور والانصراف"}
            </button>
          )}

          {blockingError ? (
            <p className="attendance-kiosk__hint" style={{ color: "#fca5a5" }}>
              {blockingError}
            </p>
          ) : (
            <p className="attendance-kiosk__status">{status}</p>
          )}

          {result ? (
            <div
              className={`attendance-kiosk__result attendance-kiosk__result--${
                result.type === "error" ? "error" : result.type
              }`}
            >
              {result.username ? <div>أهلاً {result.username}</div> : null}
              <div>{result.message}</div>
              {result.time ? (
                <div style={{ fontSize: "0.95rem", marginTop: 6, fontWeight: 400 }}>
                  {formatDateTimeAr(result.time)}
                </div>
              ) : null}
            </div>
          ) : null}

          <p className="attendance-kiosk__hint">
            يتطلب HTTPS لتفعيل الكاميرا على الهاتف. للمتجر: استخدم Tailscale Serve أو شهادة محلية.
          </p>
        </>
      )}
    </div>
  );
}
