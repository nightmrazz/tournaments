import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { locale, t, tr } from '@/i18n';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// Formatters follow the selected interface language.
const fmt = (iso: string, o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(locale(), o).format(new Date(iso));

export const formatDate = (iso: string | null | undefined) => (iso ? fmt(iso, { day: 'numeric', month: 'short', year: 'numeric' }) : t('Date TBA'));
export const formatDateTime = (iso: string | null | undefined) => (iso ? fmt(iso, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
export const formatTime = (iso: string | null | undefined) => (iso ? fmt(iso, { hour: '2-digit', minute: '2-digit' }) : '');

/** ISO string → value for <input type="datetime-local"> in local time. */
export function toLocalInput(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fromLocalInput(value: string): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** User-facing text for any error, translated when possible. */
export const errorMessage = (e: unknown) => tr(e instanceof Error ? e.message : 'Something went wrong.');
