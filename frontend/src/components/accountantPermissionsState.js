import {
  allAccountantPermissionsDisabled,
  allAccountantPermissionsEnabled,
} from "../utils/accountantPermissions";

/** Pure state helpers behind AccountantPermissionsPanel (kept separate so they are testable). */

export function toggleFeature(permissions, key, enabled) {
  return { ...permissions, [key]: enabled === true };
}

/** تحديد الكل / إلغاء الكل for one nav group: only that group's leaves change. */
export function setTopicEnabled(permissions, topic, enabled) {
  if (!topic) return permissions;
  const next = { ...permissions };
  for (const feature of topic.features) {
    next[feature.key] = enabled === true;
  }
  return next;
}

/** Global تحديد الكل / إلغاء الكل across every permission in the catalog. */
export function setAllEnabled(enabled) {
  return enabled ? allAccountantPermissionsEnabled() : allAccountantPermissionsDisabled();
}

export function topicSummary(permissions, topic) {
  const enabled = topic.features.filter((f) => permissions?.[f.key] === true).length;
  return `${enabled}/${topic.features.length}`;
}
