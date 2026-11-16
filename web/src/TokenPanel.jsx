import React, { useState } from 'react';
import { sendJson } from './api.js';

const sourceDescriptions = {
  entered: 'token entered here',
  environment: 'GITHUB_TOKEN from the environment',
  'github-cli': 'token from the gh CLI',
};

function describeAccess(tokenStatus) {
  if (!tokenStatus) return 'Checking GitHub access…';
  if (tokenStatus.source === 'none') return 'No GitHub token. Only public repositories can be listed.';
  if (tokenStatus.error) return tokenStatus.error;
  return `Signed in to GitHub as ${tokenStatus.login} (${sourceDescriptions[tokenStatus.source]}).`;
}

export default function TokenPanel({ tokenStatus, onTokenStatusChange }) {
  const [isEditing, setIsEditing] = useState(false);
  const [tokenInput, setTokenInput] = useState('');
  const [saveError, setSaveError] = useState(null);
  const hasToken = tokenStatus && tokenStatus.source !== 'none';
  const hasProblem = Boolean(tokenStatus?.error);

  async function saveToken(event) {
    event.preventDefault();
    try {
      onTokenStatusChange(await sendJson('POST', '/api/token', { token: tokenInput }));
      setTokenInput('');
      setSaveError(null);
      setIsEditing(false);
    } catch (error) {
      setSaveError(error.message);
    }
  }

  async function removeToken() {
    onTokenStatusChange(await sendJson('DELETE', '/api/token'));
  }

  return (
    <div className="token">
      <p className={hasProblem ? 'problem' : 'access'} role={hasProblem ? 'alert' : undefined}>
        {describeAccess(tokenStatus)}
      </p>
      {!isEditing && (
        <div className="actions">
          <button type="button" className="quiet" onClick={() => setIsEditing(true)}>
            {hasToken ? 'Change token' : 'Add token'}
          </button>
          {tokenStatus?.source === 'entered' && (
            <button type="button" className="quiet" onClick={removeToken}>
              Remove token
            </button>
          )}
        </div>
      )}
      {isEditing && (
        <form className="token-form" onSubmit={saveToken}>
          <label htmlFor="github-token">GitHub token</label>
          <input
            id="github-token"
            type="password"
            autoComplete="off"
            value={tokenInput}
            onChange={(event) => setTokenInput(event.target.value)}
            aria-describedby="github-token-hint"
            autoFocus
          />
          <button type="submit">Save token</button>
          <button type="button" className="quiet" onClick={() => setIsEditing(false)}>
            Cancel
          </button>
          <p id="github-token-hint" className="hint">
            The token needs read access to the organisation's repositories (classic tokens: the repo scope). It is kept
            in memory and forgotten when Branch compare stops.
          </p>
          {saveError && (
            <p className="problem" role="alert">
              {saveError}
            </p>
          )}
        </form>
      )}
    </div>
  );
}
