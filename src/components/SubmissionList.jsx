import React from 'react';
import SubmissionDetail from './SubmissionDetail.jsx';
import SubmissionDrawer from './SubmissionDrawer.jsx';
import Pagination from './Pagination.jsx';

const PAGE_SIZE = 10;

export default function SubmissionList({
  submissions,
  listLoading,
  listError,
  activeFilterText,
  selectedId,
  detailLoading,
  detailError,
  selectedDetail,
  deleteBusy,
  deleteError,
  onSelect,
  onDelete,
  onClearSelection
}) {
  const [page, setPage] = React.useState(1);
  const headingRef = React.useRef(null);
  const pageCount = Math.max(1, Math.ceil(submissions.length / PAGE_SIZE));
  const visibleSubmissions = submissions.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  React.useEffect(() => {
    setPage(1);
  }, [submissions]);

  React.useEffect(() => {
    if (page > pageCount) setPage(pageCount);
  }, [page, pageCount]);

  return (
    <section className="panel admin-list-panel" aria-labelledby="admin-list-heading">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Results</p>
          <h2 id="admin-list-heading" ref={headingRef} tabIndex={-1}>Submission list</h2>
        </div>
        {!listLoading && !listError && (
          <span className="admin-result-count">
            {submissions.length} {submissions.length === 1 ? 'result' : 'results'}
          </span>
        )}
      </div>
      {listLoading && <p className="admin-loading" role="status">Loading submissions…</p>}
      {listError && <p className="alert" role="alert">{listError}</p>}
      {!listLoading && !listError && !submissions.length && (
        <div className="empty-state admin-empty-list">
          <h3>No submissions found</h3>
          <p>Try changing the active filters.</p>
        </div>
      )}
      {!listLoading && !listError && submissions.length > 0 && (
        <details className="admin-history-details">
          <summary>Show submission history ({submissions.length})</summary>
          <div className="table-wrap admin-table-wrap">
            <table className="submission-table admin-submission-table">
              <caption className="visually-hidden">Submissions matching {activeFilterText}</caption>
              <thead>
                <tr>
                  <th>Worker</th>
                  <th>Site</th>
                  <th>Date</th>
                  <th>Status</th>
                  <th>Photos</th>
                  <th><span className="visually-hidden">View</span></th>
                </tr>
              </thead>
              <tbody>
                {visibleSubmissions.map((submission) => (
                  <tr
                    key={submission.id}
                    className={String(selectedId) === String(submission.id) ? 'admin-selected-row' : undefined}
                  >
                    <td data-label="Worker">{submission.worker_name || 'Unknown worker'}</td>
                    <td data-label="Site">{submission.site_name || 'Unknown site'}</td>
                    <td data-label="Date">{submission.work_date}</td>
                    <td data-label="Status"><span className="status-badge">{submission.status || '—'}</span></td>
                    <td data-label="Photos">{submission.photo_count ?? 0}</td>
                    <td data-label="View">
                      <button
                        className="button secondary admin-view-button"
                        type="button"
                        onClick={() => onSelect(submission)}
                        aria-label={`View submission for ${submission.worker_name || 'worker'} at ${submission.site_name || 'site'} on ${submission.work_date}`}
                      >
                        View details
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {pageCount > 1 && (
            <Pagination
              page={page}
              pageCount={pageCount}
              onPageChange={setPage}
              label="Submission pages"
            />
          )}
        </details>
      )}
      <SubmissionDrawer
        open={Boolean(selectedId)}
        loading={detailLoading}
        error={detailError}
        submission={selectedDetail}
        busy={deleteBusy}
        fallbackFocusRef={headingRef}
        onClose={onClearSelection}
      >
        {selectedDetail && (
          <SubmissionDetail
            submission={selectedDetail}
            deleting={deleteBusy}
            deleteError={deleteError}
            onDelete={onDelete}
          />
        )}
      </SubmissionDrawer>
    </section>
  );
}
