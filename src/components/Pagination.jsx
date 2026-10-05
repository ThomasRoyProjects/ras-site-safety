import React from 'react';

export default function Pagination({ page, pageCount, onPageChange, label = 'Pages' }) {
  if (pageCount <= 1) return null;

  return (
    <nav className="pagination" aria-label={label}>
      <button
        className="button secondary"
        type="button"
        onClick={() => onPageChange(Math.max(1, page - 1))}
        disabled={page <= 1}
      >
        Previous
      </button>
      <span aria-live="polite">Page {page} of {pageCount}</span>
      <button
        className="button secondary"
        type="button"
        onClick={() => onPageChange(Math.min(pageCount, page + 1))}
        disabled={page >= pageCount}
      >
        Next
      </button>
    </nav>
  );
}
