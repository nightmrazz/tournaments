import { Badge } from '@/components/ui/primitives';
import { REGISTRATION_STATUS_LABEL } from '@/engine';
import { t } from '@/i18n';
import type { RegistrationStatus } from '@/types/domain';

const tone: Record<RegistrationStatus, 'warning' | 'info' | 'success' | 'danger' | 'neutral'> = {
  awaiting_payment: 'warning',
  awaiting_review: 'info',
  confirmed: 'success',
  waitlisted: 'neutral',
  rejected: 'danger',
  cancelled: 'neutral',
};

export function RegistrationStatusBadge({ status }: { status: RegistrationStatus }) {
  return <Badge tone={tone[status]} dot={status === 'awaiting_review'}>{t(REGISTRATION_STATUS_LABEL[status])}</Badge>;
}
