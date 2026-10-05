import React from 'react';
import { api } from '../api.js';
import { isAbortError } from '../isAbortError.js';
import AdminOverview from './AdminOverview.jsx';
import SubmissionFilters from './SubmissionFilters.jsx';
import SubmissionList from './SubmissionList.jsx';
import StaffView from './StaffView.jsx';
import './AdminView.css';

const emptyFilters = { siteId: '', workerId: '', from: '', to: '' };

function describeDateRange(from, to) {
  if (from && to) return `${from} to ${to}`;
  if (from) return `From ${from}`;
  if (to) return `Through ${to}`;
  return 'Any date';
}

function describeFilter(value, items, allLabel) {
  if (!value) return allLabel;
  return items.find((item) => String(item.id) === String(value))?.name || allLabel;
}

function buildSubmissionQuery(filters) {
  const query = new URLSearchParams();
  if (filters.siteId) query.set('site_id', filters.siteId);
  if (filters.workerId) query.set('worker_id', filters.workerId);
  if (filters.from) query.set('date_from', filters.from);
  if (filters.to) query.set('date_to', filters.to);
  const queryString = query.toString();
  return queryString ? `/submissions?${queryString}` : '/submissions';
}

function errorMessage(error, fallback) {
  return error?.message || fallback;
}

export default function AdminView({ user, view = 'overview', onSessionExpired }) {
  const [sites, setSites] = React.useState([]);
  const [workers, setWorkers] = React.useState([]);
  const [submissions, setSubmissions] = React.useState([]);
  const [draftFilters, setDraftFilters] = React.useState(emptyFilters);
  const [activeFilters, setActiveFilters] = React.useState(emptyFilters);
  const [listSummary, setListSummary] = React.useState(null);
  const [listReload, setListReload] = React.useState(0);
  const [optionsLoading, setOptionsLoading] = React.useState(true);
  const [listLoading, setListLoading] = React.useState(true);
  const [optionsError, setOptionsError] = React.useState('');
  const [listError, setListError] = React.useState('');
  const [filterError, setFilterError] = React.useState('');
  const [selectedId, setSelectedId] = React.useState(null);
  const [selectedDetail, setSelectedDetail] = React.useState(null);
  const [detailLoading, setDetailLoading] = React.useState(false);
  const [detailError, setDetailError] = React.useState('');
  const [actionNotice, setActionNotice] = React.useState('');
  const [deleteError, setDeleteError] = React.useState('');
  const [deleteBusy, setDeleteBusy] = React.useState(false);
  const optionsRequest = React.useRef(null);
  const listRequest = React.useRef({ id: 0, controller: null });
  const detailRequest = React.useRef({ id: 0, controller: null });
  const deleteRequest = React.useRef({ id: 0, controller: null });

  const endSession = React.useCallback((error) => {
    if (error?.status === 401) {
      onSessionExpired?.();
      return true;
    }
    return false;
  }, [onSessionExpired]);

  const loadOptions = React.useCallback(() => {
    optionsRequest.current?.abort();
    const controller = new AbortController();
    optionsRequest.current = controller;
    setOptionsLoading(true);
    setOptionsError('');

    Promise.all([
      api('/sites', { signal: controller.signal }),
      api('/admin/workers', { signal: controller.signal })
    ])
      .then(([siteData, workerData]) => {
        if (!controller.signal.aborted && optionsRequest.current === controller) {
          setSites(Array.isArray(siteData?.sites) ? siteData.sites : []);
          setWorkers(Array.isArray(workerData?.workers) ? workerData.workers : []);
        }
      })
      .catch((error) => {
        if (!controller.signal.aborted && optionsRequest.current === controller && !isAbortError(error) && !endSession(error)) {
          setOptionsError(errorMessage(error, 'Filter options could not be loaded.'));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted && optionsRequest.current === controller) setOptionsLoading(false);
      });

    return controller;
  }, [endSession]);

  React.useEffect(() => {
    const controller = loadOptions();
    return () => {
      controller.abort();
      if (optionsRequest.current === controller) optionsRequest.current = null;
    };
  }, [loadOptions, user?.id]);

  React.useEffect(() => {
    const requestId = listRequest.current.id + 1;
    listRequest.current.id = requestId;
    listRequest.current.controller?.abort();
    const controller = new AbortController();
    listRequest.current.controller = controller;
    setListLoading(true);
    setListError('');
    setSubmissions([]);
    setListSummary(null);

    api(buildSubmissionQuery(activeFilters), { signal: controller.signal })
      .then((response) => {
        if (!controller.signal.aborted && requestId === listRequest.current.id) {
          setSubmissions(Array.isArray(response?.submissions) ? response.submissions : []);
          setListSummary(Array.isArray(response?.summary) ? response.summary : []);
        }
      })
      .catch((error) => {
        if (!controller.signal.aborted && requestId === listRequest.current.id && !isAbortError(error) && !endSession(error)) {
          setListError(errorMessage(error, 'Submissions could not be loaded.'));
          setSubmissions([]);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted && requestId === listRequest.current.id) setListLoading(false);
      });

    return () => controller.abort();
  }, [activeFilters, endSession, listReload]);

  React.useEffect(() => () => {
    listRequest.current.controller?.abort();
    detailRequest.current.controller?.abort();
    deleteRequest.current.controller?.abort();
    optionsRequest.current?.abort();
  }, []);

  React.useEffect(() => {
    if (selectedId === null) return undefined;
    const requestId = detailRequest.current.id + 1;
    detailRequest.current.id = requestId;
    detailRequest.current.controller?.abort();
    const controller = new AbortController();
    detailRequest.current.controller = controller;
    setDetailLoading(true);
    setDetailError('');
    setSelectedDetail(null);

    api(`/submissions/${encodeURIComponent(selectedId)}`, { signal: controller.signal })
      .then((data) => {
        if (!controller.signal.aborted && requestId === detailRequest.current.id) setSelectedDetail(data.submission);
      })
      .catch((error) => {
        if (!controller.signal.aborted && requestId === detailRequest.current.id && !isAbortError(error) && !endSession(error)) {
          setDetailError(errorMessage(error, 'Submission details could not be loaded.'));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted && requestId === detailRequest.current.id) setDetailLoading(false);
      });

    return () => controller.abort();
  }, [selectedId, endSession]);

  const clearSelection = React.useCallback(() => {
    detailRequest.current.id += 1;
    detailRequest.current.controller?.abort();
    deleteRequest.current.id += 1;
    deleteRequest.current.controller?.abort();
    setSelectedId(null);
    setSelectedDetail(null);

    setDetailLoading(false);
    setDetailError('');
    setDeleteError('');
  }, []);
  React.useEffect(() => {
    if (view !== 'submissions' && selectedId !== null) clearSelection();
  }, [clearSelection, selectedId, view]);

  const updateDraft = React.useCallback((name, value) => {
    setDraftFilters((current) => ({ ...current, [name]: value }));
    setFilterError('');
  }, []);

  const applyFilters = React.useCallback((event) => {
    event.preventDefault();
    if (optionsLoading || optionsError) return;
    if (draftFilters.from && draftFilters.to && draftFilters.from > draftFilters.to) {
      setFilterError('The start date must be on or before the end date.');
      return;
    }
    clearSelection();
    setActiveFilters({ ...draftFilters });
  }, [clearSelection, draftFilters, optionsError, optionsLoading]);

  const clearFilters = React.useCallback(() => {
    setDraftFilters(emptyFilters);
    setFilterError('');
    clearSelection();
    setActiveFilters(emptyFilters);
  }, [clearSelection]);

  const retryOptions = React.useCallback(() => {
    setFilterError('');
    loadOptions();
  }, [loadOptions]);

  const selectSubmission = React.useCallback((submission) => {
    if (submission?.id) setSelectedId(submission.id);
  }, []);

  const deleteSubmission = React.useCallback((submissionId) => {
    deleteRequest.current.controller?.abort();
    const requestId = deleteRequest.current.id + 1;
    deleteRequest.current.id = requestId;
    const controller = new AbortController();
    deleteRequest.current.controller = controller;
    setDeleteBusy(true);
    setDeleteError('');
    setActionNotice('');

    function finishDeletion() {
      setDeleteBusy(false);
      setSubmissions((current) =>
        current.filter((row) => String(row.id) !== String(submissionId))
      );
      setActionNotice('Submission deleted.');
      setListReload((current) => current + 1);
      clearSelection();
    }

    api(`/submissions/${encodeURIComponent(submissionId)}`, {
      method: 'DELETE',
      signal: controller.signal
    })
      .then(() => {
        if (
          controller.signal.aborted ||
          requestId !== deleteRequest.current.id
        ) {
          return;
        }
        finishDeletion();
      })
      .catch((error) => {
        if (
          controller.signal.aborted ||
          requestId !== deleteRequest.current.id ||
          isAbortError(error)
        ) {
          return;
        }
        if (error?.status === 404) {
          finishDeletion();
          return;
        }
        if (endSession(error)) return;
        setDeleteError(errorMessage(error, 'Submission could not be deleted.'));
      })
      .finally(() => {
        if (!controller.signal.aborted && requestId === deleteRequest.current.id) {
          setDeleteBusy(false);
        }
      });
  }, [clearSelection, endSession]);

  const activeFilterText = `${describeFilter(activeFilters.siteId, sites, 'All sites')} · ${describeFilter(activeFilters.workerId, workers, 'All workers')} · ${describeDateRange(activeFilters.from, activeFilters.to)}`;
  const sharedListProps = {
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
    onSelect: selectSubmission,
    onDelete: deleteSubmission,
    onClearSelection: clearSelection
  };

  if (view === 'staff') return <StaffView user={user} onSessionExpired={onSessionExpired} />;
  if (view === 'account') return null;
  if (view === 'overview') {
    return (
      <AdminOverview
        submissions={submissions}
        listSummary={listSummary}
        listLoading={listLoading}
        listError={listError}
        activeFilterText={activeFilterText}
      />
    );
  }
  if (view !== 'submissions') return null;

  return (
    <div className="admin-view">
      <h1 className="visually-hidden" tabIndex={-1}>Admin submissions</h1>
      {actionNotice && <p className="alert success" role="status">{actionNotice}</p>}
      <SubmissionFilters
        draftFilters={draftFilters}
        sites={sites}
        workers={workers}
        optionsLoading={optionsLoading}
        optionsError={optionsError}
        filterError={filterError}
        activeFilterText={activeFilterText}
        onChange={updateDraft}
        onApply={applyFilters}
        onClear={clearFilters}
        onRetry={retryOptions}
      />
      <SubmissionList {...sharedListProps} />
    </div>
  );
}
