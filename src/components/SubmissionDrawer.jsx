import React from 'react';

export default function SubmissionDrawer({
  open,
  title = 'Submission details',
  loading,
  error,
  submission,
  busy = false,
  fallbackFocusRef,
  onClose,
  children
}) {
  const dialogRef = React.useRef(null);
  const returnFocusRef = React.useRef(null);

  React.useEffect(() => {
    const dialog = dialogRef.current;

    if (!dialog) {
      return undefined;
    }

    let focusFrame;

    if (open) {
      returnFocusRef.current = document.activeElement;

      if (!dialog.open) {
        dialog.showModal();
      }

      focusFrame = requestAnimationFrame(() => {
        dialog.querySelector('[data-drawer-close]')?.focus();
      });
    } else if (dialog.open) {
      dialog.close();
    }

    return () => {
      if (focusFrame) {
        cancelAnimationFrame(focusFrame);
      }
    };
  }, [open]);

  React.useEffect(() => {
    const dialog = dialogRef.current;

    if (!dialog) {
      return undefined;
    }

    const handleClose = () => {
      onClose?.();
      requestAnimationFrame(() => {
        const target = returnFocusRef.current;
        if (target?.isConnected) {
          target.focus?.();
        } else {
          fallbackFocusRef?.current?.focus?.();
        }
      });
    };

    dialog.addEventListener('close', handleClose);
    return () => dialog.removeEventListener('close', handleClose);
  }, [onClose]);

  function close() {
    if (busy) return;
    if (dialogRef.current?.open) {
      dialogRef.current.close();
    } else {
      onClose?.();
    }
  }

  function handleBackdropClick(event) {
    if (event.target === event.currentTarget) {
      close();
    }
  }

  return (
    <dialog
      ref={dialogRef}
      className="submission-drawer"
      aria-labelledby="submission-drawer-title"
      onClick={handleBackdropClick}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
    >
      <div className="submission-drawer-inner">
        <div className="section-heading submission-drawer-heading">
          <div>
            <p className="eyebrow">Safety record</p>
            <h2 id="submission-drawer-title">{title}</h2>
          </div>
          <button
            data-drawer-close
            className="button secondary"
            type="button"
            onClick={close}
            disabled={busy}
          >
            Close
          </button>
        </div>
        {loading && <p className="muted" role="status">Loading submission details…</p>}
        {error && <p className="alert" role="alert">{error}</p>}
        {!loading && !error && submission && children}
      </div>
    </dialog>
  );
}
