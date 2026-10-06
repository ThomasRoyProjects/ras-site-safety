import React from 'react';
import { api } from '../api.js';
import { isAbortError } from '../isAbortError.js';
import SubmissionDetail from './SubmissionDetail.jsx';
import SubmissionDrawer from './SubmissionDrawer.jsx';
import Pagination from './Pagination.jsx';
import './FramerView.css';

const CHECKLIST = [
  ['hard_hat', 'Hard hat is available and being worn'],
  ['high_visibility_vest', 'High-visibility vest is available and being worn'],
  ['safety_boots', 'Safety boots are available and being worn'],
  ['eye_protection', 'Eye protection is available and being worn'],
  ['fall_protection', 'Fall protection is required and in place'],
  ['ladders_scaffolds_inspected', 'Ladders and scaffolds have been inspected'],
  ['tools_cords_checked', 'Tools and cords have been checked'],
  ['hazards_identified', 'Site hazards have been identified and controlled']
];
const ACCEPTED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_PHOTOS = 5;
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
const MAX_NOTES_CODE_POINTS = 5000;
const PAGE_SIZE = 10;

function codePointLength(value) {
  return Array.from(value).length;
}

function limitCodePoints(value, limit) {
  let count = 0;
  let end = 0;
  for (const character of value) {
    if (count >= limit) break;
    count += 1;
    end += character.length;
  }
  return value.slice(0, end);
}

function localDate() {
  const date = new Date();
  const offset = date.getTimezoneOffset();
  return new Date(date.getTime() - offset * 60000).toISOString().slice(0, 10);
}

function emptyForm() {
  return {
    site_id: '',
    work_date: localDate(),
    notes: '',
    ...Object.fromEntries(CHECKLIST.map(([name]) => [name, '']))
  };
}

function errorMessage(error, fallback) {
  return error instanceof Error && error.message ? error.message : fallback;
}

function serverErrorMessage(error) {
  if (error?.status === 413) return 'Photo storage limit reached';
  if (error?.status === 429) return 'Daily submission limit reached. Try again tomorrow.';
  if (error?.status === 503) return 'Uploads are busy. Try again shortly.';
  return errorMessage(error, 'Submission could not be saved. Your entries are still here.');
}

function summaryFromSubmission(submission) {
  return {
    id: submission.id,
    site_name: submission.site_name,
    work_date: submission.work_date,
    status: submission.status,
    photo_count: submission.photos?.length ?? submission.photo_count ?? 0
  };
}

function describeDateError(value) {
  return value ? '' : 'Choose the work date.';
}

function validate(form, photos, photoError) {
  const errors = {};
  if (!form.site_id) errors.site_id = 'Choose a site before submitting.';
  errors.work_date = describeDateError(form.work_date);
  if (!errors.work_date) delete errors.work_date;
  if (CHECKLIST.some(([name]) => form[name] === '')) {
    errors.checklist = 'Answer every safety question.';
  }
  if (codePointLength(form.notes) > MAX_NOTES_CODE_POINTS) {
    errors.notes = 'Notes must be 5,000 characters or fewer.';
  }
  if (photoError) errors.photos = photoError;
  else if (!photos.length) errors.photos = 'Attach at least one site photo.';
  return errors;
}

function withoutError(errors, ...keys) {
  const next = { ...errors };
  keys.forEach((key) => delete next[key]);
  return next;
}

function fieldDescription(...ids) {
  return ids.filter(Boolean).join(' ') || undefined;
}

function NewSubmissionForm({ user, sites, sitesLoading, sitesError, onRetrySites, onSubmissionSaved, onSessionExpired, loadHistory }) {
  const [form, setForm] = React.useState(emptyForm);
  const [photos, setPhotos] = React.useState([]);
  const [photoError, setPhotoError] = React.useState('');
  const [errors, setErrors] = React.useState({});
  const [submitMessage, setSubmitMessage] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  const [fileInputKey, setFileInputKey] = React.useState(0);
  const submitRequest = React.useRef(null);
  const photosRef = React.useRef(photos);
  const errorSummaryRef = React.useRef(null);
  const focusSummaryOnUpdateRef = React.useRef(false);
  const mountedRef = React.useRef(true);
  const sitesUnavailable = sitesLoading || Boolean(sitesError) || sites.length === 0;

  photosRef.current = photos;
  React.useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      submitRequest.current?.abort();
      photosRef.current.forEach((photo) => URL.revokeObjectURL(photo.url));
    };
  }, []);

  React.useEffect(() => {
    if (!focusSummaryOnUpdateRef.current) return;
    focusSummaryOnUpdateRef.current = false;
    if (Object.keys(errors).length > 0) {
      // WebKit does not reliably scroll a focused element into view.
      errorSummaryRef.current?.focus({ preventScroll: true });
      errorSummaryRef.current?.scrollIntoView({ block: 'start', behavior: 'auto' });
    }
  }, [errors]);

  const focusError = React.useCallback((key) => {
    const targetIds = {
      site_id: 'framer-site',
      work_date: 'framer-date',
      notes: 'framer-notes',
      photos: 'framer-photos'
    };
    const target = key === 'checklist'
      ? `framer-question-${CHECKLIST.find(([name]) => !form[name])?.[0] || CHECKLIST[0][0]}`
      : targetIds[key] || `framer-${key}`;
    const element = document.getElementById(target);
    if (key === 'checklist') element?.querySelector('input')?.focus();
    else element?.focus();
  }, [form]);

  const choosePhotos = (event) => {
    const chosen = Array.from(event.target.files || []);
    if (!chosen.length) return;
    const remaining = MAX_PHOTOS - photos.length;
    const accepted = [];
    const problems = [];
    chosen.forEach((file) => {
      if (!ACCEPTED_TYPES.has(file.type)) problems.push(`${file.name} is not a JPEG, PNG, or WebP image.`);
      else if (file.size < 1) problems.push(`${file.name} must not be empty.`);
      else if (file.size > MAX_PHOTO_BYTES) problems.push(`${file.name} must be no larger than 10 MiB.`);
      else if (accepted.length >= remaining) problems.push(`Only ${MAX_PHOTOS} photos can be attached.`);
      else accepted.push({ id: `${file.name}-${file.size}-${file.lastModified}-${Math.random()}`, file, url: URL.createObjectURL(file) });
    });
    if (accepted.length) setPhotos((current) => [...current, ...accepted]);
    const message = problems.join(' ');
    setPhotoError(message);
    setErrors((current) => message ? { ...current, photos: message } : withoutError(current, 'photos'));
    event.target.value = '';
  };

  const removePhoto = (id) => {
    setPhotos((current) => {
      const removed = current.find((photo) => photo.id === id);
      if (removed) URL.revokeObjectURL(removed.url);
      return current.filter((photo) => photo.id !== id);
    });
    setPhotoError('');
    setErrors((current) => withoutError(current, 'photos'));
  };

  const updateForm = (event) => {
    const { name, value } = event.target;
    const isChecklistField = CHECKLIST.some(([item]) => item === name);
    setForm((current) => ({ ...current, [name]: name === 'notes' ? limitCodePoints(value, MAX_NOTES_CODE_POINTS) : value }));
    setErrors((current) => withoutError(current, isChecklistField ? 'checklist' : name));
    setSubmitMessage('');
  };

  const submit = async (event) => {
    event.preventDefault();
    setSubmitMessage('');
    const validationErrors = validate(form, photos, photoError);
    focusSummaryOnUpdateRef.current = true;
    setErrors(validationErrors);
    if (Object.keys(validationErrors).length > 0 || sitesUnavailable) {
      if (sitesUnavailable && !validationErrors.site_id) setErrors({ ...validationErrors, site_id: sitesError || 'Sites are unavailable. Retry loading sites before submitting.' });
      return;
    }

    setSubmitting(true);
    const controller = new AbortController();
    submitRequest.current = controller;
    const body = new FormData();
    body.append('site_id', form.site_id);
    body.append('work_date', form.work_date);
    body.append('notes', form.notes);
    CHECKLIST.forEach(([name]) => body.append(name, form[name]));
    photos.forEach(({ file }) => body.append('photos', file));

    try {
      const data = await api('/submissions', { method: 'POST', body, signal: controller.signal });
      if (controller.signal.aborted || !mountedRef.current) return;

      const createdSummary = summaryFromSubmission(data.submission);
      setSubmitMessage('Safety submission saved successfully.');
      onSubmissionSaved(createdSummary);
      photos.forEach((photo) => URL.revokeObjectURL(photo.url));
      setPhotos([]);
      setPhotoError('');
      setErrors({});
      setFileInputKey((key) => key + 1);
      setForm(emptyForm());
      await loadHistory(false);
    } catch (error) {
      if (!controller.signal.aborted && mountedRef.current && !isAbortError(error) && !onSessionExpired?.(error)) {
        focusSummaryOnUpdateRef.current = true;
        setErrors({ form: serverErrorMessage(error) });
      }
    } finally {
      if (submitRequest.current === controller) submitRequest.current = null;
      if (!controller.signal.aborted && mountedRef.current) setSubmitting(false);
    }
  };

  const errorEntries = Object.entries(errors).filter(([, message]) => message);
  const errorLabels = {
    site_id: 'Site',
    work_date: 'Work date',
    checklist: 'Safety checks',
    notes: 'Notes',
    photos: 'Site photos',
    form: 'Submission'
  };
  const siteErrorId = errors.site_id ? 'framer-site-error' : undefined;
  const dateErrorId = errors.work_date ? 'framer-date-error' : undefined;
  const checklistErrorId = errors.checklist ? 'framer-checklist-error' : undefined;
  const notesErrorId = errors.notes ? 'framer-notes-error' : undefined;
  const photosErrorId = errors.photos ? 'framer-photos-error' : undefined;
  const siteUnavailableMessage = sitesError || (sites.length === 0 && !sitesLoading ? 'No sites are available. Retry loading sites before submitting.' : '');
  const siteUnavailableId = siteUnavailableMessage ? 'framer-sites-load-error' : undefined;

  return (
    <div className="framer-page" data-workspace-view="new">
      <h1 className="visually-hidden" tabIndex={-1}>New submission</h1>
      <section className="panel framer-panel" aria-labelledby="new-submission-heading">
        <div className="section-heading">
            <p className="eyebrow">New record</p>
            <h2 id="new-submission-heading">Safety submission</h2>
          </div>
        {submitMessage && <p className="alert success" role="status">{submitMessage}</p>}
        {errorEntries.length > 0 && (
          <div className="alert framer-error-summary" role="alert" tabIndex="-1" ref={errorSummaryRef} aria-labelledby="framer-error-summary-heading">
            <strong id="framer-error-summary-heading">Review the following before submitting:</strong>
            <ul>
              {errorEntries.map(([key, message]) => (
                <li key={key}>
                  {key === 'form' ? (
                    <span>{errorLabels[key]}: {message}</span>
                  ) : (
                    <button type="button" className="framer-error-link" onClick={() => focusError(key)}>
                      {errorLabels[key] || 'Error'}: {message}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
        <form className="framer-form" onSubmit={submit} noValidate>
          <div className="field-grid framer-context-grid">
            <div className="field">
              <label htmlFor="framer-worker">Worker</label>
              <input id="framer-worker" value={user?.name || ''} readOnly aria-describedby="framer-worker-note" />
              <small id="framer-worker-note" className="muted">Your signed-in account is recorded automatically.</small>
            </div>
            <div className="field">
              <label htmlFor="framer-site">Site <span aria-hidden="true">*</span></label>
              <select
                id="framer-site"
                name="site_id"
                value={form.site_id}
                onChange={updateForm}
                disabled={sitesUnavailable || submitting}
                required
                aria-invalid={Boolean(errors.site_id)}
                aria-describedby={fieldDescription(siteErrorId, siteUnavailableId)}
              >
                <option value="">{sitesLoading ? 'Loading sites…' : 'Choose a site'}</option>
                {sites.map((site) => <option key={site.id} value={site.id}>{site.name}</option>)}
              </select>
              {errors.site_id && <small id={siteErrorId} className="framer-field-error">{errors.site_id}</small>}
              {siteUnavailableMessage && <small id={siteUnavailableId} className="framer-field-error" role="alert">{siteUnavailableMessage}</small>}
              {(sitesError || (sites.length === 0 && !sitesLoading)) && <button type="button" className="button secondary framer-refresh" onClick={onRetrySites} disabled={sitesLoading}>Retry loading sites</button>}
            </div>
            <div className="field">
              <label htmlFor="framer-date">Work date <span aria-hidden="true">*</span></label>
              <input id="framer-date" name="work_date" type="date" value={form.work_date} onChange={updateForm} disabled={submitting} required aria-invalid={Boolean(errors.work_date)} aria-describedby={dateErrorId} />
              {errors.work_date && <small id={dateErrorId} className="framer-field-error">{errors.work_date}</small>}
            </div>
          </div>

          <fieldset className="framer-checklist" aria-describedby={checklistErrorId} aria-invalid={Boolean(errors.checklist)}>
            <legend>Safety checks <span className="muted">Answer every question</span></legend>
            {CHECKLIST.map(([name, label], index) => (
              <div className="framer-question" key={name}>
                <span id={`question-${name}`} className="framer-question-label"><span className="framer-question-number">{index + 1}</span>{label} <span aria-hidden="true">*</span></span>
                <div
                  id={`framer-question-${name}`}
                  className="framer-options"
                  role="radiogroup"
                  aria-labelledby={`question-${name}`}
                  aria-invalid={Boolean(errors.checklist && !form[name])}
                  aria-describedby={errors.checklist && !form[name] ? checklistErrorId : undefined}
                >
                  <label><input type="radio" name={name} value="1" checked={form[name] === '1'} onChange={updateForm} disabled={submitting} required aria-invalid={Boolean(errors.checklist && !form[name])} aria-describedby={errors.checklist && !form[name] ? checklistErrorId : undefined} />Yes</label>
                  <label><input type="radio" name={name} value="0" checked={form[name] === '0'} onChange={updateForm} disabled={submitting} aria-invalid={Boolean(errors.checklist && !form[name])} aria-describedby={errors.checklist && !form[name] ? checklistErrorId : undefined} />No</label>
                </div>
              </div>
            ))}
            {errors.checklist && <small id={checklistErrorId} className="framer-field-error">{errors.checklist}</small>}
          </fieldset>

          <div className="field framer-notes-field">
            <label htmlFor="framer-notes">Notes <span className="muted">(optional)</span></label>
            <textarea id="framer-notes" name="notes" value={form.notes} onChange={updateForm} rows={4} disabled={submitting} aria-invalid={Boolean(errors.notes)} aria-describedby={fieldDescription('framer-notes-count', notesErrorId)} placeholder="Add hazards, controls, or other useful context." />
            <small id="framer-notes-count" className="muted" aria-live="polite">{codePointLength(form.notes)}/5000 characters</small>
            {errors.notes && <small id={notesErrorId} className="framer-field-error">{errors.notes}</small>}
          </div>

          <div className="field framer-photos-field">
            <label htmlFor="framer-photos">Site photos <span aria-hidden="true">*</span></label>
            <p id="framer-photo-guidance" className="muted">Attach 1–5 non-empty JPEG, PNG, or WebP photos. Each file must be 10 MiB or smaller.</p>
            <input key={fileInputKey} id="framer-photos" type="file" accept="image/jpeg,image/png,image/webp" multiple onChange={choosePhotos} disabled={submitting || photos.length >= MAX_PHOTOS} aria-invalid={Boolean(errors.photos)} aria-describedby={fieldDescription('framer-photo-guidance', 'framer-photo-count', photosErrorId)} />
            <small id="framer-photo-count" className="muted">{photos.length}/{MAX_PHOTOS} photos selected.</small>
            {errors.photos && <p id={photosErrorId} className="framer-field-error" role="alert">{errors.photos}</p>}
            {photos.length > 0 && (
              <ul className="framer-photo-list" aria-label="Selected photo previews">
                {photos.map((photo, index) => (
                  <li key={photo.id}>
                    <img src={photo.url} alt={`Selected site photo ${index + 1}`} />
                    <button type="button" className="button secondary framer-remove-photo" aria-label={`Remove selected site photo ${index + 1}`} onClick={() => removePhoto(photo.id)} disabled={submitting}>Remove</button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <button type="submit" className="button framer-submit-button" disabled={submitting || sitesUnavailable}>
            {submitting ? 'Saving submission…' : sitesUnavailable ? 'Sites unavailable' : 'Save safety submission'}
          </button>
        </form>
      </section>
    </div>
  );
}

function SubmissionHistory({ history, historyLoading, historyError, page, onPageChange, onRefresh, onSelect, detailLoading, detailError, selectedSubmission, onCloseDetail }) {
  const pageCount = Math.max(1, Math.ceil(history.length / PAGE_SIZE));
  const visibleHistory = history.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  // Safari does not focus a button on click. Focus it so the drawer can return focus here.
  function openDetail(event, item) {
    event.currentTarget.focus();
    onSelect(item);
  }
  return (
    <div className="framer-page" data-workspace-view="history">
      <h1 className="visually-hidden" tabIndex={-1}>Submission history</h1>
      <section className="panel framer-panel" aria-labelledby="history-heading">
        <div className="section-heading">
          <div><p className="eyebrow">Return visits</p><h2 id="history-heading">My submission history</h2></div>
          <button type="button" className="button secondary framer-refresh" onClick={onRefresh} disabled={historyLoading}>Refresh</button>
        </div>
        <p className="history-count muted">{historyLoading ? 'Loading records…' : `${history.length} ${history.length === 1 ? 'record' : 'records'}`}</p>
        {historyError && <p className="alert" role="alert">{historyError}</p>}
        {historyLoading ? <p className="muted" role="status">Loading your submissions…</p> : history.length === 0 ? <p className="empty-state">No submissions yet. Your saved checks will appear here.</p> : (
          <details className="history-details">
            <summary>Show submission history ({history.length})</summary>
            <div className="framer-history-list">
              {visibleHistory.map((item) => (
                <button type="button" className="framer-history-item" key={item.id} onClick={(event) => openDetail(event, item)} aria-label={`View submission for ${item.site_name || 'site'} on ${item.work_date}`}>
                  <span><strong>{item.site_name || 'Site'}</strong><small>{item.work_date}</small></span>
                  <span className="framer-history-meta"><span className="status-badge">{item.status || '—'}</span><small>{item.photo_count ?? 0} {item.photo_count === 1 ? 'photo' : 'photos'}</small></span>
                </button>
              ))}
            </div>
            <Pagination page={page} pageCount={pageCount} onPageChange={onPageChange} label="History pages" />
          </details>
        )}
      </section>
      <SubmissionDrawer open={Boolean(detailLoading || detailError || selectedSubmission)} title="Submission details" loading={detailLoading} error={detailError} submission={selectedSubmission} onClose={onCloseDetail}>
        {selectedSubmission && <SubmissionDetail submission={selectedSubmission} />}
      </SubmissionDrawer>
    </div>
  );
}

function SubmissionOverview({ history, historyLoading, historyError }) {
  const latest = history.reduce((value, item) => (!value || item.work_date > value ? item.work_date : value), '');
  const uniqueSites = new Set(history.map((item) => item.site_id || item.site_name).filter(Boolean)).size;
  const metricsUnavailable = historyLoading || Boolean(historyError);
  return (
    <div className="framer-page" data-workspace-view="overview">
      <h1 className="visually-hidden" tabIndex={-1}>Framer overview</h1>
      <section className="summary-grid framer-summary-grid" aria-label="Submission overview">
        <article className="summary-card"><span>My submissions</span><strong>{metricsUnavailable ? '—' : history.length}</strong><small>Saved safety records</small></article>
        <article className="summary-card"><span>Sites visited</span><strong>{metricsUnavailable ? '—' : uniqueSites}</strong><small>Across returned records</small></article>
        <article className="summary-card"><span>Latest work date</span><strong>{metricsUnavailable ? '—' : (latest || '—')}</strong><small>Most recent saved record</small></article>
      </section>
      {historyError && <p className="alert" role="alert">{historyError}</p>}
      <section className="panel framer-overview-note"><p className="eyebrow">Ready for today</p><h2>Keep the crew check-in current.</h2><p className="muted">Start a new submission before work, or open History to review a saved record.</p></section>
    </div>
  );
}

export default function FramerView({ user, view = 'overview', onSessionExpired }) {
  const [sites, setSites] = React.useState([]);
  const [sitesLoading, setSitesLoading] = React.useState(true);
  const [sitesError, setSitesError] = React.useState('');
  const [history, setHistory] = React.useState([]);
  const [historyLoading, setHistoryLoading] = React.useState(true);
  const [historyError, setHistoryError] = React.useState('');
  const [selectedSubmission, setSelectedSubmission] = React.useState(null);
  const [detailLoading, setDetailLoading] = React.useState(false);
  const [detailError, setDetailError] = React.useState('');
  const [page, setPage] = React.useState(1);
  const sitesRequest = React.useRef(null);
  const historyRequest = React.useRef(null);
  const detailRequest = React.useRef(null);
  const historyRequestNumber = React.useRef(0);
  const detailRequestNumber = React.useRef(0);

  const handleAuthError = React.useCallback((error) => {
    if (error?.status === 401) {
      onSessionExpired?.();
      return true;
    }
    return false;
  }, [onSessionExpired]);

  const loadSites = React.useCallback(() => {
    sitesRequest.current?.abort();
    const controller = new AbortController();
    sitesRequest.current = controller;
    setSitesLoading(true);
    setSitesError('');
    setSites([]);
    api('/sites', { signal: controller.signal }).then((data) => {
      if (!controller.signal.aborted && sitesRequest.current === controller) setSites(Array.isArray(data?.sites) ? data.sites : []);
    }).catch((error) => {
      if (!controller.signal.aborted && sitesRequest.current === controller && !isAbortError(error) && !handleAuthError(error)) setSitesError(errorMessage(error, 'Sites could not be loaded.'));
    }).finally(() => {
      if (!controller.signal.aborted && sitesRequest.current === controller) setSitesLoading(false);
    });
  }, [handleAuthError]);

  React.useEffect(() => {
    loadSites();
    return () => {
      sitesRequest.current?.abort();
    };
  }, [loadSites, user?.id]);

  const loadHistory = React.useCallback((showLoading = true) => {
    historyRequest.current?.abort();
    const controller = new AbortController();
    const requestNumber = ++historyRequestNumber.current;
    historyRequest.current = controller;
    if (showLoading) setHistoryLoading(true);
    setHistoryError('');
    return api('/submissions', { signal: controller.signal }).then((data) => {
      if (controller.signal.aborted || requestNumber !== historyRequestNumber.current) return null;
      const next = Array.isArray(data?.submissions) ? data.submissions : [];
      setHistory(next);
      setPage(1);
      return next;
    }).catch((error) => {
      if (!controller.signal.aborted && requestNumber === historyRequestNumber.current && !isAbortError(error) && !handleAuthError(error)) setHistoryError(errorMessage(error, 'Submission history could not be loaded.'));
      return null;
    }).finally(() => {
      if (!controller.signal.aborted && requestNumber === historyRequestNumber.current) setHistoryLoading(false);
    });
  }, [handleAuthError]);

  React.useEffect(() => {
    loadHistory();
    return () => historyRequest.current?.abort();
  }, [loadHistory, user?.id]);

  React.useEffect(() => () => {
    sitesRequest.current?.abort();
    historyRequest.current?.abort();
    detailRequest.current?.abort();
  }, []);

  const selectHistory = (item) => {
    detailRequest.current?.abort();
    const controller = new AbortController();
    const requestNumber = ++detailRequestNumber.current;
    detailRequest.current = controller;
    setDetailLoading(true);
    setDetailError('');
    setSelectedSubmission(null);
    api(`/submissions/${encodeURIComponent(item.id)}`, { signal: controller.signal }).then((data) => {
      if (!controller.signal.aborted && requestNumber === detailRequestNumber.current) setSelectedSubmission(data.submission);
    }).catch((error) => {
      if (!controller.signal.aborted && requestNumber === detailRequestNumber.current && !isAbortError(error) && !handleAuthError(error)) setDetailError(errorMessage(error, 'Submission details could not be loaded.'));
    }).finally(() => {
      if (!controller.signal.aborted && requestNumber === detailRequestNumber.current) {
        detailRequest.current = null;
        setDetailLoading(false);
      }
    });
  };

  const clearDetail = React.useCallback(() => {
    detailRequest.current?.abort();
    detailRequest.current = null;
    detailRequestNumber.current += 1;
    setSelectedSubmission(null);
    setDetailError('');
    setDetailLoading(false);
  }, []);

  React.useEffect(() => {
    if (view !== 'history' && (detailLoading || detailError || selectedSubmission)) clearDetail();
  }, [clearDetail, detailError, detailLoading, selectedSubmission, view]);

  const saveSummary = React.useCallback((summary) => {
    setHistory((current) => [summary, ...current.filter((item) => item.id !== summary.id)]);
    setPage(1);
  }, []);

  if (view === 'overview') return <SubmissionOverview history={history} historyLoading={historyLoading} historyError={historyError} />;
  if (view === 'history') return <SubmissionHistory history={history} historyLoading={historyLoading} historyError={historyError} page={page} onPageChange={setPage} onRefresh={loadHistory} onSelect={selectHistory} detailLoading={detailLoading} detailError={detailError} selectedSubmission={selectedSubmission} onCloseDetail={clearDetail} />;
  if (view === 'new') return <NewSubmissionForm user={user} sites={sites} sitesLoading={sitesLoading} sitesError={sitesError} onRetrySites={loadSites} onSubmissionSaved={saveSummary} onSessionExpired={handleAuthError} loadHistory={loadHistory} />;
  return null;
}
