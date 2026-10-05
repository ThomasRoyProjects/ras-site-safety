import React from 'react';


export default function AdminOverview({
  submissions,
  listSummary,
  listLoading,
  listError,
  activeFilterText
}) {
  const siteCounts = (Array.isArray(listSummary) ? listSummary : []).map((site) => ({
    id: site.site_id,
    name: site.site_name,
    count: Number(site.submission_count) || 0
  }));
  const representedSiteCount = siteCounts.filter((site) => site.count > 0).length;
  const latest = submissions.reduce(
    (value, item) => (!value || item.work_date > value ? item.work_date : value),
    ''
  );
  const metricsUnavailable = listLoading || Boolean(listError);

  return (
    <div className="admin-view admin-overview">
      <h1 className="visually-hidden" tabIndex={-1}>Admin overview</h1>
      <section className="summary-grid admin-summary-grid" aria-label="Submission overview">
        <article className="summary-card admin-summary-card">
          <span>Total submissions</span>
          <strong>{metricsUnavailable ? '—' : submissions.length}</strong>
          <small>Matching current filters</small>
        </article>
        <article className="summary-card admin-summary-card">
          <span>Sites represented</span>
          <strong>{metricsUnavailable ? '—' : representedSiteCount}</strong>
          <small>With returned records</small>
        </article>
        <article className="summary-card admin-summary-card">
          <span>Latest work date</span>
          <strong>{metricsUnavailable ? '—' : (latest || '—')}</strong>
          <small>From returned records</small>
        </article>
      </section>
      <section className="panel admin-summary-section" aria-labelledby="admin-summary-heading">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Overview</p>
            <h2 id="admin-summary-heading">Submissions by site</h2>
          </div>
          <span className="admin-summary-context">{activeFilterText}</span>
        </div>
        {listLoading ? (
          <p className="admin-loading" role="status">Loading submission totals…</p>
        ) : listError ? (
          <p className="alert" role="alert">{listError}</p>
        ) : siteCounts.length ? (
          <div className="summary-grid admin-summary-grid">
            {siteCounts.map((site) => (
              <article className="summary-card admin-summary-card" key={site.id}>
                <span className="admin-summary-site">{site.name}</span>
                <strong>{site.count}</strong>
                <small>{site.count === 1 ? 'submission' : 'submissions'}</small>
              </article>
            ))}
          </div>
        ) : (
          <p className="empty-state">No sites are available.</p>
        )}
      </section>
    </div>
  );
}
