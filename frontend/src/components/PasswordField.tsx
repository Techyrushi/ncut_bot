import { useState } from 'react';

interface PasswordFieldProps {
  id: string;
  label: string;
  value: string;
  autoComplete: string;
  placeholder?: string;
  required?: boolean;
  minLength?: number;
  onChange: (value: string) => void;
}

export function PasswordField({
  id,
  label,
  value,
  autoComplete,
  placeholder,
  required = false,
  minLength,
  onChange,
}: PasswordFieldProps) {
  const [visible, setVisible] = useState(false);

  return (
    <label htmlFor={id}>
      {label}
      <div className="password-input">
        <input
          id={id}
          autoComplete={autoComplete}
          type={visible ? 'text' : 'password'}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          required={required}
          minLength={minLength}
        />
        <button
          type="button"
          className="password-toggle"
          aria-label={visible ? `Hide ${label.toLowerCase()}` : `Show ${label.toLowerCase()}`}
          aria-pressed={visible}
          onClick={() => setVisible((current) => !current)}
        >
          {visible ? 'Hide' : 'Show'}
        </button>
      </div>
    </label>
  );
}
