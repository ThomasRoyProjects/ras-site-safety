import React from 'react';

export default function PasswordField({
  id,
  name = id,
  label,
  value,
  onChange,
  autoComplete,
  disabled,
  describedBy
}) {
  const [visible, setVisible] = React.useState(false);

  function toggleVisibility() {
    setVisible((current) => !current);
  }

  return (
    <div className="password-field">
      <label className="field" htmlFor={id}>
        {label}
        <input
          id={id}
          name={name}
          type={visible ? 'text' : 'password'}
          autoComplete={autoComplete}
          value={value}
          onChange={onChange}
          disabled={disabled}
          required
          aria-describedby={describedBy}
        />
      </label>
      <button
        className="password-toggle"
        type="button"
        onClick={toggleVisibility}
        disabled={disabled}
        aria-controls={id}
        aria-pressed={visible}
      >
        {visible ? 'Hide' : 'Show'}
      </button>
    </div>
  );
}
