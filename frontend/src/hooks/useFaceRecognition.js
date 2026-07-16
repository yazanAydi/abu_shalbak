import { useCallback, useEffect, useRef, useState } from "react";
import Human from "@vladmandic/human";

const MODEL_BASE = `${process.env.PUBLIC_URL || ""}/models/`;
const DEFAULT_MATCH_THRESHOLD = 0.6;
const MIN_FACE_SCORE = 0.5;
const MIN_LIVENESS = 0.3;
const MIN_ANTISPOOF = 0.3;

function buildHumanConfig() {
  return {
    backend: "webgl",
    modelBasePath: MODEL_BASE,
    debug: false,
    async: true,
    warmup: "none",
    cacheSensitivity: 0.01,
    face: {
      enabled: true,
      detector: { enabled: true, rotation: true, maxDetected: 1, minConfidence: 0.5 },
      mesh: { enabled: false },
      iris: { enabled: false },
      description: { enabled: true, minConfidence: 0.5 },
      emotion: { enabled: false },
      antispoof: { enabled: true, minConfidence: MIN_ANTISPOOF },
      liveness: { enabled: true, minConfidence: MIN_LIVENESS },
    },
    body: { enabled: false },
    hand: { enabled: false },
    object: { enabled: false },
    gesture: { enabled: false },
  };
}

/**
 * Flatten enrolled users into descriptor list for Human.match.find.
 * @param {Array<{ user_id: number, username: string, descriptors: number[][] }>} enrolled
 */
export function flattenEnrolledDescriptors(enrolled) {
  const flat = [];
  const indexToUser = [];
  for (const person of enrolled || []) {
    for (const desc of person.descriptors || []) {
      if (Array.isArray(desc) && desc.length >= 64) {
        flat.push(desc);
        indexToUser.push({
          user_id: person.user_id,
          username: person.username,
        });
      }
    }
  }
  return { flat, indexToUser };
}

/**
 * @param {number[]} live
 * @param {Array<{ user_id: number, username: string, descriptors: number[][] }>} enrolled
 * @param {import('@vladmandic/human').default} human
 * @param {number} threshold
 */
export function matchEnrolledFace(live, enrolled, human, threshold = DEFAULT_MATCH_THRESHOLD) {
  if (!live?.length || !human?.match?.find) return null;
  const { flat, indexToUser } = flattenEnrolledDescriptors(enrolled);
  if (!flat.length) return null;

  const result = human.match.find(live, flat, { order: 2, multiplier: 25 });
  if (result.index < 0 || result.similarity < threshold) return null;

  const user = indexToUser[result.index];
  return {
    user_id: user.user_id,
    username: user.username,
    similarity: result.similarity,
    distance: result.distance,
  };
}

export function isFaceLiveEnough(face) {
  if (!face?.embedding?.length) return false;
  if (face.score < MIN_FACE_SCORE) return false;
  const liveOk = face.live == null || face.live >= MIN_LIVENESS;
  const realOk = face.real == null || face.real >= MIN_ANTISPOOF;
  return liveOk && realOk;
}

export function useFaceRecognition() {
  const humanRef = useRef(null);
  const [ready, setReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const human = new Human(buildHumanConfig());
        await human.load();
        if (cancelled) return;
        humanRef.current = human;
        setReady(true);
        setError("");
      } catch (e) {
        if (!cancelled) {
          setError(e?.message || "فشل تحميل نماذج التعرف على الوجه");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const detectFace = useCallback(async (videoEl) => {
    const human = humanRef.current;
    if (!human || !videoEl) return null;
    const result = await human.detect(videoEl);
    const face = result?.face?.[0];
    if (!face || !isFaceLiveEnough(face)) return null;
    return face;
  }, []);

  const extractDescriptor = useCallback(async (videoEl) => {
    const face = await detectFace(videoEl);
    return face?.embedding || null;
  }, [detectFace]);

  const matchFace = useCallback(
    (descriptor, enrolled, threshold = DEFAULT_MATCH_THRESHOLD) => {
      const human = humanRef.current;
      if (!human || !descriptor) return null;
      return matchEnrolledFace(descriptor, enrolled, human, threshold);
    },
    []
  );

  return {
    ready,
    loading,
    error,
    detectFace,
    extractDescriptor,
    matchFace,
    human: humanRef.current,
  };
}
