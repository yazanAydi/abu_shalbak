import { useState } from "react";
import { SecondaryButton } from "./ui";
import {
  ACCOUNTANT_PERMISSION_TOPICS,
  allAccountantPermissionKeys,
  defaultAccountantPermissions,
} from "../utils/accountantPermissions";
import "./AccountantPermissionsPanel.css";

export default function AccountantPermissionsPanel({ value, onChange }) {
  const permissions = value || defaultAccountantPermissions();
  const [openTopics, setOpenTopics] = useState(() =>
    Object.fromEntries(ACCOUNTANT_PERMISSION_TOPICS.map((t) => [t.id, true]))
  );

  function setPermission(key, enabled) {
    onChange({ ...permissions, [key]: enabled });
  }

  function setTopicPermissions(topicId, enabled) {
    const topic = ACCOUNTANT_PERMISSION_TOPICS.find((t) => t.id === topicId);
    if (!topic) return;
    const next = { ...permissions };
    for (const feature of topic.features) {
      next[feature.key] = enabled;
    }
    onChange(next);
  }

  function setAllPermissions(enabled) {
    onChange(defaultAccountantPermissions());
    if (!enabled) {
      const cleared = {};
      for (const key of allAccountantPermissionKeys()) {
        cleared[key] = false;
      }
      onChange(cleared);
    }
  }

  function topicSummary(topic) {
    const enabled = topic.features.filter((f) => permissions[f.key]).length;
    return `${enabled}/${topic.features.length}`;
  }

  function toggleTopic(topicId) {
    setOpenTopics((prev) => ({ ...prev, [topicId]: !prev[topicId] }));
  }

  return (
    <div className="acct-perms">
      <div className="acct-perms__toolbar">
        <SecondaryButton type="button" onClick={() => setAllPermissions(true)}>
          تحديد الكل
        </SecondaryButton>
        <SecondaryButton type="button" onClick={() => setAllPermissions(false)}>
          إلغاء الكل
        </SecondaryButton>
      </div>

      <div className="acct-perms__topics">
        {ACCOUNTANT_PERMISSION_TOPICS.map((topic) => {
          const isOpen = openTopics[topic.id];
          return (
            <div key={topic.id} className="acct-perms__topic">
              <button
                type="button"
                className="acct-perms__topic-header"
                onClick={() => toggleTopic(topic.id)}
                aria-expanded={isOpen}
              >
                <span className="acct-perms__topic-title">{topic.labelAr}</span>
                <span className="acct-perms__topic-meta">{topicSummary(topic)}</span>
                <span className="acct-perms__topic-chevron" aria-hidden>
                  {isOpen ? "▾" : "◂"}
                </span>
              </button>

              {isOpen ? (
                <div className="acct-perms__topic-body">
                  <div className="acct-perms__topic-actions">
                    <button
                      type="button"
                      className="acct-perms__link-btn"
                      onClick={() => setTopicPermissions(topic.id, true)}
                    >
                      تحديد الكل
                    </button>
                    <button
                      type="button"
                      className="acct-perms__link-btn"
                      onClick={() => setTopicPermissions(topic.id, false)}
                    >
                      إلغاء الكل
                    </button>
                  </div>
                  <ul className="acct-perms__features">
                    {topic.features.map((feature) => (
                      <li key={feature.key}>
                        <label className="acct-perms__feature">
                          <input
                            type="checkbox"
                            checked={!!permissions[feature.key]}
                            onChange={(e) => setPermission(feature.key, e.target.checked)}
                          />
                          <span>{feature.labelAr}</span>
                        </label>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
