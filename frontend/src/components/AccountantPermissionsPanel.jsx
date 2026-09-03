import { useMemo, useState } from "react";
import { SecondaryButton } from "./ui";
import { defaultAccountantPermissions } from "../utils/accountantPermissions";
import {
  setAllEnabled,
  setTopicEnabled,
  toggleFeature,
  topicSummary as summarizeTopic,
} from "./accountantPermissionsState";
import { permissionTopicsFromNav } from "./layout/officeNavConfig";
import "./AccountantPermissionsPanel.css";

export default function AccountantPermissionsPanel({ value, onChange, readOnly = false }) {
  const topics = useMemo(() => permissionTopicsFromNav(), []);
  const permissions = value || defaultAccountantPermissions();
  const [openTopics, setOpenTopics] = useState(() =>
    Object.fromEntries(topics.map((t) => [t.id, true]))
  );

  function setPermission(key, enabled) {
    if (readOnly) return;
    onChange(toggleFeature(permissions, key, enabled));
  }

  function setTopicPermissions(topicId, enabled) {
    if (readOnly) return;
    const topic = topics.find((t) => t.id === topicId);
    if (!topic) return;
    onChange(setTopicEnabled(permissions, topic, enabled));
  }

  function setAllPermissions(enabled) {
    if (readOnly) return;
    onChange(setAllEnabled(enabled));
  }

  function topicSummary(topic) {
    return summarizeTopic(permissions, topic);
  }

  function toggleTopic(topicId) {
    setOpenTopics((prev) => ({ ...prev, [topicId]: !prev[topicId] }));
  }

  return (
    <div className="acct-perms">
      {readOnly ? null : (
        <div className="acct-perms__toolbar">
          <SecondaryButton type="button" onClick={() => setAllPermissions(true)}>
            تحديد الكل
          </SecondaryButton>
          <SecondaryButton type="button" onClick={() => setAllPermissions(false)}>
            إلغاء الكل
          </SecondaryButton>
        </div>
      )}

      <div className="acct-perms__topics">
        {topics.map((topic) => {
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
                  {readOnly ? null : (
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
                  )}
                  <ul className="acct-perms__features">
                    {topic.features.map((feature) => (
                      <li key={feature.key}>
                        <label className="acct-perms__feature">
                          <input
                            type="checkbox"
                            checked={!!permissions[feature.key]}
                            disabled={readOnly}
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
