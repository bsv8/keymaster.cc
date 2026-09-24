import React, { useEffect, useState } from "react";
import { useOptionalCapability } from "webloom-framework/react";
import { Button, Modal } from "@keymaster/ui";
import { useI18n } from "@keymaster/runtime";
import { WEBRTC_SERVICE_CAPABILITY } from "./constants.js";
import { validateStunUrl, type WebrtcConfig } from "./webrtcConfig.js";
import type { StunDiagnosticResult, WebrtcService } from "./webrtcService.js";

export function WebrtcSettingsPage(): React.ReactElement {
  const { t } = useI18n();
  const service = useOptionalCapability(WEBRTC_SERVICE_CAPABILITY);
  if (!service) {
    return (
      <section className="km-webrtc-page" data-webrtc-settings="missing-service">
        <p>{t("webrtc.page.settings.desc", { defaultValue: "webrtc service is not available" })}</p>
      </section>
    );
  }
  return <WebrtcSettingsInner service={service} />;
}

interface WebrtcSettingsInnerProps {
  service: WebrtcService;
}

function WebrtcSettingsInner({ service }: WebrtcSettingsInnerProps): React.ReactElement {
  const { t } = useI18n();
  const [saved, setSaved] = useState<WebrtcConfig>(() => ({
    stunServers: [...service.getStunServers()]
  }));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [diagResults, setDiagResults] = useState<StunDiagnosticResult[] | null>(null);
  const [diagRunning, setDiagRunning] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorValue, setEditorValue] = useState("");
  const [editorError, setEditorError] = useState<string | null>(null);
  const [editorTesting, setEditorTesting] = useState(false);
  const [editorTestResult, setEditorTestResult] = useState<StunDiagnosticResult | null>(null);

  useEffect(() => {
    setSaved({ stunServers: [...service.getStunServers()] });
  }, [service]);

  async function commitConfig(nextServers: string[]): Promise<string | null> {
    setSaving(true);
    setError(null);
    try {
      await service.applyStunServers(nextServers);
      setSaved({ stunServers: [...service.getStunServers()] });
      setDiagResults(null);
      return null;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      return message;
    } finally {
      setSaving(false);
    }
  }

  function openAddEditor() {
    if (saving) return;
    setEditorValue("");
    setEditorError(null);
    setEditorTestResult(null);
    setEditorOpen(true);
  }

  function closeAddEditor() {
    if (saving || editorTesting) return;
    setEditorOpen(false);
    setEditorValue("");
    setEditorError(null);
    setEditorTestResult(null);
  }

  function changeEditorValue(value: string) {
    setEditorValue(value);
    setEditorError(null);
    setEditorTestResult(null);
  }

  async function testEditorServer() {
    const check = validateStunUrl(editorValue);
    if (!check.ok || check.value === undefined) {
      setEditorTestResult(null);
      setEditorError(t("webrtc.page.settings.invalid", {
        defaultValue: check.error ?? "invalid"
      }));
      return;
    }
    if (saved.stunServers.includes(check.value)) {
      setEditorTestResult(null);
      setEditorError(t("webrtc.page.settings.stun.duplicate", {
        defaultValue: "This STUN server is already in the list."
      }));
      return;
    }

    setEditorTesting(true);
    setEditorError(null);
    setEditorTestResult(null);
    try {
      setEditorTestResult(await service.testStunServer(check.value));
    } catch (err) {
      setEditorError(err instanceof Error ? err.message : String(err));
    } finally {
      setEditorTesting(false);
    }
  }

  async function saveEditorServer() {
    const check = validateStunUrl(editorValue);
    const testedUrl = editorTestResult?.status === "ok" ? editorTestResult.url : null;
    if (!check.ok || check.value === undefined || testedUrl !== check.value) return;
    const failure = await commitConfig([...saved.stunServers, check.value]);
    if (failure) {
      setEditorError(failure);
      return;
    }
    closeAddEditor();
  }

  async function removeServer(server: string) {
    await commitConfig(saved.stunServers.filter((item) => item !== server));
  }

  async function runAllDiagnostics() {
    setDiagRunning(true);
    setDiagResults(null);
    setError(null);
    try {
      setDiagResults(await service.runStunDiagnostics());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDiagRunning(false);
    }
  }

  const normalizedEditorValue = validateStunUrl(editorValue);
  const saveEnabled =
    normalizedEditorValue.ok &&
    normalizedEditorValue.value !== undefined &&
    editorTestResult?.status === "ok" &&
    editorTestResult.url === normalizedEditorValue.value;

  return (
    <section className="km-webrtc-page" data-webrtc-settings="main">
      <div className="km-webrtc-page__section-header">
        <h3>{t("webrtc.page.settings.field.stun.label", { defaultValue: "STUN servers" })}</h3>
        <Button size="sm" onClick={openAddEditor} disabled={saving}>
          {t("webrtc.page.settings.stun.add", { defaultValue: "Add STUN server" })}
        </Button>
      </div>

      <div className="km-webrtc-page__stun-list">
        {saved.stunServers.map((server) => (
          <div key={server} className="km-webrtc-page__stun-row">
            <code>{server}</code>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void removeServer(server)}
              disabled={saving}
            >
              {t("webrtc.page.settings.field.stun.remove", { defaultValue: "Remove" })}
            </Button>
          </div>
        ))}
      </div>

      {error ? <div className="km-webrtc-page__error" role="alert">{error}</div> : null}

      <div className="km-webrtc-page__diagnostics">
        <Button
          variant="secondary"
          onClick={() => void runAllDiagnostics()}
          disabled={diagRunning}
          loading={diagRunning}
        >
          {diagRunning
            ? t("webrtc.page.settings.actions.testAll.running", { defaultValue: "Testing…" })
            : t("webrtc.page.settings.actions.testAll", { defaultValue: "Test all STUN" })}
        </Button>
        {diagResults ? (
          <div className="km-webrtc-page__diagnostic-results">
            <table className="km-webrtc-page__stun-table">
              <tbody>
                {diagResults.map((result) => (
                  <tr key={result.url}>
                    <td className="km-webrtc-page__stun-row__url"><code>{result.url}</code></td>
                    <td className={`km-webrtc-page__stun-row__status km-webrtc-page__stun-row__status--${result.status}`}>
                      {t(`webrtc.page.settings.diag.${result.status}`, { defaultValue: result.status })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="km-webrtc-page__hint">
              {t("webrtc.page.settings.diag.note", {
                defaultValue: "This only verifies STUN availability locally."
              })}
            </p>
          </div>
        ) : null}
      </div>

      <Modal
        open={editorOpen}
        title={t("webrtc.page.settings.stun.add", { defaultValue: "Add STUN server" })}
        onClose={closeAddEditor}
        data-testid="webrtc-stun-editor"
        footer={
          <>
            <Button variant="ghost" onClick={closeAddEditor} disabled={saving || editorTesting}>
              {t("common.action.cancel", { defaultValue: "Cancel" })}
            </Button>
            <Button
              onClick={() => void saveEditorServer()}
              disabled={!saveEnabled || saving || editorTesting}
              loading={saving}
            >
              {t("webrtc.page.settings.stun.save", { defaultValue: "Save STUN server" })}
            </Button>
          </>
        }
      >
        <p className="webrtc-stun-editor__description">
          {t("webrtc.page.settings.stun.description", {
            defaultValue: "Enter a STUN server URL and test it before saving."
          })}
        </p>
        <label className="webrtc-stun-editor__field">
          <span>{t("webrtc.page.settings.stun.url", { defaultValue: "STUN server URL" })}</span>
          <input
            className="km-webrtc-page__input"
            aria-label={t("webrtc.page.settings.stun.url", { defaultValue: "STUN server URL" })}
            placeholder={t("webrtc.page.settings.field.stun.placeholder", { defaultValue: "stun:host:port" })}
            value={editorValue}
            disabled={saving || editorTesting}
            autoFocus
            onChange={(event) => changeEditorValue(event.currentTarget.value)}
          />
        </label>
        <Button
          variant="secondary"
          onClick={() => void testEditorServer()}
          disabled={saving || editorTesting}
          loading={editorTesting}
        >
          {editorTesting
            ? t("webrtc.page.settings.actions.test.running", { defaultValue: "Testing…" })
            : t("webrtc.page.settings.actions.test", { defaultValue: "Test STUN server" })}
        </Button>
        {editorTestResult ? (
          <div
            className={`webrtc-stun-editor__result webrtc-stun-editor__result--${editorTestResult.status}`}
            role="status"
          >
            {t(`webrtc.page.settings.diag.${editorTestResult.status}`, {
              defaultValue: editorTestResult.status
            })}
          </div>
        ) : null}
        {editorError ? <p className="webrtc-stun-editor__error" role="alert">{editorError}</p> : null}
      </Modal>
    </section>
  );
}
