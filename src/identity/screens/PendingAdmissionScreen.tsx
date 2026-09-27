import { useEffect, useState } from "react";
import type { AuthorizationService } from "../../auth/authorization";
import { encodeIdentityCode } from "../codes";
import { admitDeviceWithCredential, type DeviceIdentityRecord } from "../deviceIdentity";
import type { ArgusIdentityProvider } from "../identity";

export function PendingAdmissionScreen({
  publicIdentity,
  identity,
  record,
  onAdmitted,
  onLock,
}: {
  publicIdentity: string;
  identity: ArgusIdentityProvider;
  record: DeviceIdentityRecord;
  onAdmitted: (record: DeviceIdentityRecord, authorization: AuthorizationService) => void;
  onLock: () => void;
}) {
  const [identityCode, setIdentityCode] = useState("");
  const [copied, setCopied] = useState(false);
  const [credentialCode, setCredentialCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    encodeIdentityCode(publicIdentity).then((code) => {
      if (active) setIdentityCode(code);
    });
    return () => {
      active = false;
    };
  }, [publicIdentity]);

  const copy = async () => {
    await navigator.clipboard.writeText(identityCode);
    setCopied(true);
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const { record: updated, authorization } = await admitDeviceWithCredential(record, identity, credentialCode);
      onAdmitted(updated, authorization);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "This credential could not be accepted.");
      setBusy(false);
    }
  };

  return (
    <main className="loading-state" aria-live="polite">
      <div className="modal">
        <h2>Waiting for admission</h2>
        <p>
          This device has created its application identity and is waiting to be admitted by your unit&apos;s Master
          device. Share this device&apos;s identity code with your Master administrator.
        </p>
        <label className="field">
          YOUR IDENTITY CODE
          <textarea readOnly aria-label="Your identity code" value={identityCode} rows={3} />
        </label>
        <div className="modal-actions">
          <button type="button" onClick={() => void copy()}>
            {copied ? "Identity code copied ✓" : "Copy identity code"}
          </button>
        </div>
        <form aria-label="Enter your credential" onSubmit={submit}>
          <h3>Enter your credential</h3>
          <p>Once your Master admits you, paste the credential code they give you here.</p>
          <label className="field">
            CREDENTIAL CODE
            <textarea
              aria-label="Credential code"
              value={credentialCode}
              onChange={(event) => setCredentialCode(event.target.value)}
              rows={3}
              required
            />
          </label>
          {error && (
            <div className="workflow-error" role="alert">
              {error}
            </div>
          )}
          <div className="modal-actions">
            <button className="primary-button" type="submit" disabled={busy || !credentialCode}>
              Join with this credential
            </button>
          </div>
        </form>
        <div className="modal-actions">
          <button onClick={onLock}>Lock this device</button>
        </div>
      </div>
    </main>
  );
}
