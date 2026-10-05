import React from 'react';

const checklist = [
  ['hard_hat', 'Hard hat worn'],
  ['high_visibility_vest', 'High-visibility vest worn'],
  ['safety_boots', 'Safety boots worn'],
  ['eye_protection', 'Eye protection worn'],
  ['fall_protection', 'Fall protection in place'],
  ['ladders_scaffolds_inspected', 'Ladders and scaffolds inspected'],
  ['tools_cords_checked', 'Tools and cords checked'],
  ['hazards_identified', 'Hazards identified']
];

function PhotoThumbnail({ photo, index, siteName }) {
  const [failed, setFailed] = React.useState(false);

  return (
    <a
      href={photo.url}
      target="_blank"
      rel="noreferrer"
      aria-label={`View original site photo ${index + 1}`}
    >
      <span className="photo-thumbnail">
        {failed ? (
          <span className="photo-thumbnail-fallback">Thumbnail unavailable</span>
        ) : (
          <img
            src={photo.thumbnail_url}
            alt={`Site safety photo ${index + 1} for ${siteName}`}
            loading="lazy"
            onError={() => setFailed(true)}
          />
        )}
      </span>
      <span>Photo {index + 1} · {(photo.size_bytes / 1024 / 1024).toFixed(2)} MB</span>
    </a>
  );
}

export default function SubmissionDetail({
  submission,
  deleting = false,
  deleteError = '',
  onDelete
}) {
  const [confirmingDelete, setConfirmingDelete] = React.useState(false);
  const deleteButtonRef = React.useRef(null);
  const deleteWarningId = React.useId();
  const photoCount = submission.photos.length;

  React.useEffect(() => {
    setConfirmingDelete(false);
  }, [submission.id]);

  function cancelDelete() {
    if (deleting) return;
    setConfirmingDelete(false);
    requestAnimationFrame(() => deleteButtonRef.current?.focus());
  }

  return (
    <article className="submission-detail" aria-label={`Submission ${submission.id} details`}>
      <div className="section-heading">
        <div>
          <p className="eyebrow">Safety record #{submission.id}</p>
          <h2>{submission.site_name}</h2>
        </div>
        <span className="status-badge">{submission.status}</span>
      </div>

      <dl className="detail-meta">
        <div><dt>Worker</dt><dd>{submission.worker_name}</dd></div>
        <div><dt>Work date</dt><dd><time dateTime={submission.work_date}>{submission.work_date}</time></dd></div>
      </dl>

      <h3>Safety checklist</h3>
      <dl className="detail-checklist">
        {checklist.map(([key, label]) => (
          <div key={key}>
            <dt>{label}</dt>
            <dd className={submission[key] === 1 ? 'answer-yes' : 'answer-no'}>
              {submission[key] === 1 ? 'Yes' : 'No'}
            </dd>
          </div>
        ))}
      </dl>

      <h3>Site notes</h3>
      <p className="detail-notes">{submission.notes || 'No additional notes.'}</p>

      <h3>Site photos <span className="muted">({submission.photos.length})</span></h3>
      <p className="muted">Select a photo to view the original image.</p>
      <div className="photo-gallery">
        {submission.photos.map((photo, index) => (
          <PhotoThumbnail
            key={photo.id}
            photo={photo}
            index={index}
            siteName={submission.site_name}
          />
        ))}
      </div>
      {onDelete && (
        <div className="submission-delete-action">
          {deleteError && <p className="alert" role="alert">{deleteError}</p>}
          {!confirmingDelete ? (
            <button
              ref={deleteButtonRef}
              className="button danger"
              type="button"
              onClick={() => setConfirmingDelete(true)}
              disabled={deleting}
            >
              Delete submission
            </button>
          ) : (
            <div
              className="submission-delete-confirmation"
              role="group"
              aria-labelledby={deleteWarningId}
            >
              <p id={deleteWarningId}>
                Delete this submission and its {photoCount}{' '}
                {photoCount === 1 ? 'photo' : 'photos'}? This cannot be undone.
              </p>
              <div className="submission-delete-actions">
                <button
                  className="button secondary"
                  type="button"
                  onClick={cancelDelete}
                  disabled={deleting}
                  autoFocus
                >
                  Cancel
                </button>
                <button
                  className="button danger"
                  type="button"
                  onClick={() => onDelete(submission.id)}
                  disabled={deleting}
                >
                  {deleting ? 'Deleting…' : 'Delete'}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </article>
  );
}
