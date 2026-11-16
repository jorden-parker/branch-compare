import React, { useEffect, useState } from 'react';
import SyncedPreview from './components/synced-preview';
import { requestJson, sendJson } from './api.js';
import ComparisonView from './ComparisonView.jsx';
import TokenPanel from './TokenPanel.jsx';

const preferredBaselineBranch = 'main';
const pollIntervalMilliseconds = 1500;
const previewHeight = 640;
const statusLabels = { starting: 'Starting', ready: 'Ready', failed: 'Failed' };
const views = [
  ['preview', 'Synced preview'],
  ['comparison', 'Visual comparison'],
];

function ApplicationLane({ application, role }) {
  return (
    <section className={`lane lane-${role}`} aria-label={`${application.branch} application`}>
      <h2>
        <code>{application.branch}</code>
      </h2>
      <p className={`status status-${application.status}`} role={application.status === 'failed' ? 'alert' : 'status'}>
        <strong>{statusLabels[application.status]}.</strong> {application.message}
      </p>
      {application.logTail && <pre className="log">{application.logTail}</pre>}
    </section>
  );
}

export default function App() {
  const [tokenStatus, setTokenStatus] = useState(null);
  const [owners, setOwners] = useState([]);
  const [ownerInput, setOwnerInput] = useState('');
  const [repositoryListing, setRepositoryListing] = useState(null);
  const [repositoryName, setRepositoryName] = useState('');
  const [branchListing, setBranchListing] = useState(null);
  const [branchName, setBranchName] = useState('');
  const [startCommand, setStartCommand] = useState('');
  const [applications, setApplications] = useState(null);
  const [problem, setProblem] = useState(null);
  const [activeView, setActiveView] = useState('preview');

  const selectedRepository = repositoryListing?.repositories.find((repository) => repository.name === repositoryName);
  const baselineBranch =
    branchListing && selectedRepository && !branchListing.branches.includes(preferredBaselineBranch)
      ? selectedRepository.defaultBranch
      : preferredBaselineBranch;
  const otherBranches = branchListing?.branches.filter((branch) => branch !== baselineBranch) ?? [];
  const runningApplications = applications ? [applications.baseline, applications.candidate] : [];
  const isStarting = runningApplications.some((application) => application.status === 'starting');
  const isReadyToCompare =
    applications !== null && runningApplications.every((application) => application.status === 'ready');

  useEffect(() => {
    requestJson('/api/token').then(setTokenStatus, (error) => setProblem(error.message));
  }, []);

  useEffect(() => {
    requestJson('/api/owners').then(
      (listing) => setOwners(listing.owners),
      () => setOwners([]),
    );
  }, [tokenStatus]);

  useEffect(() => {
    if (!isStarting) return undefined;
    const timer = setTimeout(async () => {
      try {
        const [baseline, candidate] = await Promise.all(
          runningApplications.map((application) => requestJson(`/api/applications?slug=${application.slug}`)),
        );
        setApplications({ baseline, candidate });
      } catch (error) {
        setProblem(error.message);
        setApplications(null);
      }
    }, pollIntervalMilliseconds);
    return () => clearTimeout(timer);
  }, [applications]);

  async function listRepositories(event) {
    event.preventDefault();
    const owner = ownerInput.trim();
    setProblem(null);
    setRepositoryListing(null);
    setRepositoryName('');
    setBranchListing(null);
    setBranchName('');
    try {
      const listing = await requestJson(`/api/repositories?owner=${encodeURIComponent(owner)}`);
      setRepositoryListing({ owner, ...listing });
    } catch (error) {
      setProblem(error.message);
    }
  }

  async function chooseRepository(name) {
    setRepositoryName(name);
    setBranchListing(null);
    setBranchName('');
    setProblem(null);
    if (!name) return;
    try {
      const owner = encodeURIComponent(repositoryListing.owner);
      setBranchListing(await requestJson(`/api/branches?owner=${owner}&repository=${encodeURIComponent(name)}`));
    } catch (error) {
      setProblem(error.message);
    }
  }

  function stopApplication(application) {
    return sendJson('DELETE', `/api/applications?slug=${application.slug}`);
  }

  async function startApplications() {
    const specification = { owner: repositoryListing.owner, repository: repositoryName, startCommand };
    setProblem(null);
    try {
      const baseline = await sendJson('POST', '/api/applications', { ...specification, branch: baselineBranch });
      const candidate = await sendJson('POST', '/api/applications', { ...specification, branch: branchName });
      const replacedApplications = runningApplications.filter(
        (application) => application.slug !== baseline.slug && application.slug !== candidate.slug,
      );
      await Promise.all(replacedApplications.map(stopApplication));
      setApplications({ baseline, candidate });
    } catch (error) {
      setProblem(error.message);
    }
  }

  async function stopApplications() {
    setApplications(null);
    try {
      await Promise.all(runningApplications.map(stopApplication));
    } catch (error) {
      setProblem(error.message);
    }
  }

  return (
    <main>
      <header className="masthead">
        <h1>Branch compare</h1>
        <TokenPanel tokenStatus={tokenStatus} onTokenStatusChange={setTokenStatus} />
      </header>

      <section className="picker" aria-label="Choose what to compare">
        <form className="fields" onSubmit={listRepositories}>
          <div className="field">
            <label htmlFor="owner">Owner or organisation</label>
            <input
              id="owner"
              list="known-owners"
              value={ownerInput}
              onChange={(event) => setOwnerInput(event.target.value)}
              placeholder="e.g. my-organisation"
              autoComplete="off"
              spellCheck="false"
            />
            <datalist id="known-owners">
              {owners.map((owner) => (
                <option key={owner} value={owner} />
              ))}
            </datalist>
          </div>
          <button type="submit" disabled={ownerInput.trim() === ''}>
            List repositories
          </button>
        </form>

        <div className="fields">
          <div className="field">
            <label htmlFor="repository">Repository</label>
            <select
              id="repository"
              value={repositoryName}
              disabled={!repositoryListing}
              onChange={(event) => chooseRepository(event.target.value)}
            >
              <option value="">{repositoryListing ? 'Choose a repository' : 'List repositories first'}</option>
              {repositoryListing?.repositories.map((repository) => (
                <option key={repository.name} value={repository.name}>
                  {repository.isPrivate ? `${repository.name} (private)` : repository.name}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="branch">Branch</label>
            <select
              id="branch"
              value={branchName}
              disabled={!branchListing}
              onChange={(event) => setBranchName(event.target.value)}
            >
              <option value="">{branchListing ? 'Choose a branch' : 'Choose a repository first'}</option>
              {otherBranches.map((branch) => (
                <option key={branch} value={branch}>
                  {branch}
                </option>
              ))}
            </select>
          </div>
          <p className="against">
            compared with <code>{baselineBranch}</code>
          </p>
        </div>

        {repositoryListing && !repositoryListing.isAuthenticated && (
          <p className="hint">
            No GitHub token is set, so only public repositories are listed. Add a token to see an organisation's private
            repositories.
          </p>
        )}
        {repositoryListing?.repositories.length === 0 && (
          <p className="hint">No repositories are visible for {repositoryListing.owner}.</p>
        )}
        {repositoryListing?.isTruncated && (
          <p className="hint">Only the 500 most recently pushed repositories are listed.</p>
        )}
        {branchListing?.isTruncated && <p className="hint">Only the first 500 branches are listed.</p>}
        {branchListing && otherBranches.length === 0 && (
          <p className="hint">This repository has no branch other than {baselineBranch}.</p>
        )}

        <div className="fields">
          <div className="field field-wide">
            <label htmlFor="start-command">Start command (optional)</label>
            <input
              id="start-command"
              value={startCommand}
              onChange={(event) => setStartCommand(event.target.value)}
              placeholder="Detected from the lockfile, e.g. npm install && npm run dev"
              spellCheck="false"
            />
          </div>
          <button type="button" onClick={startApplications} disabled={branchName === '' || isStarting}>
            Start both applications
          </button>
          {applications && (
            <button type="button" className="quiet" onClick={stopApplications}>
              Stop both applications
            </button>
          )}
        </div>
        {problem && (
          <p className="problem" role="alert">
            {problem}
          </p>
        )}
      </section>

      {applications && (
        <div className="lanes">
          <ApplicationLane application={applications.baseline} role="baseline" />
          <ApplicationLane application={applications.candidate} role="candidate" />
        </div>
      )}

      {isReadyToCompare && (
        <>
          <div className="views" role="tablist" aria-label="Ways to compare">
            {views.map(([view, label]) => (
              <button
                key={view}
                type="button"
                role="tab"
                aria-selected={activeView === view}
                onClick={() => setActiveView(view)}
              >
                {label}
              </button>
            ))}
          </div>
          <div role="tabpanel" hidden={activeView !== 'preview'}>
            <SyncedPreview
              srcA={`${applications.baseline.url}/`}
              srcB={`${applications.candidate.url}/`}
              height={previewHeight}
            />
          </div>
          <div role="tabpanel" hidden={activeView !== 'comparison'}>
            <ComparisonView baseline={applications.baseline} candidate={applications.candidate} />
          </div>
        </>
      )}
    </main>
  );
}
