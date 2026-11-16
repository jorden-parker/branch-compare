import React, { useState } from 'react';
import { sendJson } from './api.js';

function describeDifference({ mismatchedPixelCount, totalPixelCount }) {
  if (mismatchedPixelCount === 0) return 'No pixels differ.';
  const percentage = ((100 * mismatchedPixelCount) / totalPixelCount).toFixed(2);
  return `${percentage}% of pixels differ (${mismatchedPixelCount.toLocaleString()} of ${totalPixelCount.toLocaleString()}).`;
}

export default function ComparisonView({ baseline, candidate }) {
  const [pagePath, setPagePath] = useState('/');
  const [comparison, setComparison] = useState(null);
  const [comparisonError, setComparisonError] = useState(null);
  const [isComparing, setIsComparing] = useState(false);

  async function runComparison(event) {
    event.preventDefault();
    setIsComparing(true);
    setComparisonError(null);
    try {
      setComparison(
        await sendJson('POST', '/api/comparisons', {
          baselineSlug: baseline.slug,
          candidateSlug: candidate.slug,
          pagePath,
        }),
      );
    } catch (error) {
      setComparisonError(error.message);
    } finally {
      setIsComparing(false);
    }
  }

  return (
    <div className="comparison">
      <form className="fields" onSubmit={runComparison}>
        <div className="field">
          <label htmlFor="page-path">Page path</label>
          <input id="page-path" value={pagePath} onChange={(event) => setPagePath(event.target.value)} />
        </div>
        <button type="submit" disabled={isComparing}>
          {isComparing ? 'Comparing…' : 'Run visual comparison'}
        </button>
      </form>
      {comparisonError && (
        <p className="problem" role="alert">
          {comparisonError}
        </p>
      )}
      {comparison && (
        <>
          <p className="verdict">{describeDifference(comparison)}</p>
          <div className="screenshots">
            <figure className="lane lane-baseline">
              <figcaption>
                <code>{baseline.branch}</code>
              </figcaption>
              <img src={comparison.baselineImage} alt={`Screenshot of ${baseline.branch}`} />
            </figure>
            <figure className="lane">
              <figcaption>Difference</figcaption>
              <img src={comparison.differenceImage} alt="Pixels that differ, marked in red" />
            </figure>
            <figure className="lane lane-candidate">
              <figcaption>
                <code>{candidate.branch}</code>
              </figcaption>
              <img src={comparison.candidateImage} alt={`Screenshot of ${candidate.branch}`} />
            </figure>
          </div>
        </>
      )}
    </div>
  );
}
