import { z } from 'zod';
import { t } from '@/i18n';

/** Same rule as the `guard_profile_nickname` SQL trigger. */
export const NICKNAME_RE = /^[A-Za-z0-9А-Яа-яЁё_.-]{3,24}$/;

export const makeNicknameSchema = () =>
  z.string().trim().regex(NICKNAME_RE, t('Nickname: 3–24 letters, digits, _ . - (no spaces).'));
