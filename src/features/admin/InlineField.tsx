import { useState } from 'react';
import { Input } from '@/components/ui/primitives';

/** Text field that saves on blur / Enter and rolls back if saving fails. */
export function InlineField({ initial, label, disabled, placeholder, className, list, inputMode, sanitize, onSave }: {
  initial: string; label: string; disabled?: boolean; placeholder?: string; className?: string; list?: string;
  inputMode?: 'numeric' | 'text'; sanitize?: (v: string) => string; onSave: (v: string) => Promise<void>;
}) {
  const [value, setValue] = useState(initial);
  const save = async () => {
    if (value.trim() === initial.trim()) return;
    try { await onSave(value.trim()); } catch { setValue(initial); }
  };
  return (
    <Input
      aria-label={label} value={value} disabled={disabled} placeholder={placeholder} list={list} inputMode={inputMode}
      onChange={(e) => setValue(sanitize ? sanitize(e.target.value) : e.target.value)}
      onBlur={save} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      className={className}
    />
  );
}
