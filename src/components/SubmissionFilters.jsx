import React from 'react';

export default function SubmissionFilters({
  draftFilters,
  sites,
  workers,
  optionsLoading,
  optionsError,
  filterError,
  activeFilterText,
  onChange,
  onApply,
  onClear,
  onRetry
}) {
  const optionsUnavailable = optionsLoading || Boolean(optionsError);

  return (
    <section className="panel admin-filter-panel" aria-labelledby="admin-filter-heading">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Filters</p>
          <h2 id="admin-filter-heading">Find submissions</h2>
        </div>
        <p className="admin-active-filter" aria-live="polite">Showing: {activeFilterText}</p>
      </div>
      {optionsError && (
        <div className="admin-filter-options-error">
          <p className="alert" role="alert">{optionsError}</p>
          <button className="button secondary" type="button" onClick={onRetry} disabled={optionsLoading}>
            Retry loading options
          </button>
        </div>
      )}
      <form className="admin-filter-form" onSubmit={onApply}>
        <div className="field-grid admin-filter-grid">
          <label className="field" htmlFor="admin-site-filter">
            Site
            <select
              id="admin-site-filter"
              value={draftFilters.siteId}
              onChange={(event) => onChange('siteId', event.target.value)}
              disabled={optionsUnavailable}
            >
              <option value="">All sites</option>
              {sites.map((site) => <option key={site.id} value={site.id}>{site.name}</option>)}
            </select>
          </label>
          <label className="field" htmlFor="admin-worker-filter">
            Worker
            <select
              id="admin-worker-filter"
              value={draftFilters.workerId}
              onChange={(event) => onChange('workerId', event.target.value)}
              disabled={optionsUnavailable}
            >
              <option value="">All workers</option>
              {workers.map((worker) => <option key={worker.id} value={worker.id}>{worker.name}</option>)}
            </select>
          </label>
          <label className="field" htmlFor="admin-date-from">
            From date
            <input
              id="admin-date-from"
              type="date"
              value={draftFilters.from}
              onChange={(event) => onChange('from', event.target.value)}
            />
          </label>
          <label className="field" htmlFor="admin-date-to">
            To date
            <input
              id="admin-date-to"
              type="date"
              value={draftFilters.to}
              onChange={(event) => onChange('to', event.target.value)}
            />
          </label>
        </div>
        {filterError && <p className="alert admin-filter-error" role="alert">{filterError}</p>}
        <div className="admin-filter-actions">
          <button className="button" type="submit" disabled={optionsUnavailable}>Apply filters</button>
          <button className="button secondary" type="button" onClick={onClear}>Clear filters</button>
        </div>
      </form>
    </section>
  );
}
