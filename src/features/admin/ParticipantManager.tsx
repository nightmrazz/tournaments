import { zodResolver } from '@hookform/resolvers/zod';
import { Ban, Lock, Shield, Trash2, UserPlus, Users } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { useConfirm, useToast } from '@/components/ui/overlay';
import { Alert, Button, Card, CardHeader, EmptyState, Field, Input } from '@/components/ui/primitives';
import { service } from '@/data';
import { makeParticipantSchema } from '@/features/participants/RegisterForm';
import { isConfirmed } from '@/engine';
import { useContacts, useInvalidateTournament } from '@/features/tournaments/queries';
import { t } from '@/i18n';
import { errorMessage } from '@/lib/utils';
import type { Participant, TournamentBundle } from '@/types/domain';
import { ApplicationsPanel } from './ApplicationsPanel';
import { InlineField } from './InlineField';
import { ClubSuggestions, duplicateTeams, TeamInput, useSaveTeam } from './TeamAssignment';

const makeAddSchema = () => makeParticipantSchema().extend({
  seed: z.string().regex(/^\d{0,3}$/, t('Whole numbers only')).optional(),
});
type AddForm = z.infer<ReturnType<typeof makeAddSchema>>;

export function ParticipantManager({ b }: { b: TournamentBundle }) {
  const tour = b.tournament;
  const closed = tour.status === 'completed' || tour.status === 'cancelled';
  const locked = b.matches.length > 0 || closed || tour.status === 'in_progress';
  const contacts = useContacts(tour.id, true);
  const invalidate = useInvalidateTournament(tour.id);
  const confirm = useConfirm();
  const toast = useToast();
  const [error, setError] = useState<string | null>(null);
  const { register, handleSubmit, reset, formState: { errors, isSubmitting } } = useForm<AddForm>({
    resolver: zodResolver(makeAddSchema()), defaultValues: { displayName: '', contact: '', seed: '' },
  });
  const contactOf = new Map((contacts.data ?? []).map((c) => [c.participantId, c.contact]));
  const confirmed = b.participants.filter(isConfirmed);
  const hasApplications = tour.settings.requirePayment || tour.settings.waitlistEnabled || confirmed.length < b.participants.length;
  const full = confirmed.length >= tour.maxParticipants;
  const drawn = b.matches.length > 0;
  const dups = duplicateTeams(confirmed);
  const saveTeam = useSaveTeam(tour.id);

  const add = async (v: AddForm) => {
    setError(null);
    try {
      await service.addParticipant(tour.id, { displayName: v.displayName, contact: v.contact || null, seed: v.seed ? Number(v.seed) : null });
      reset({ displayName: '', contact: '', seed: '' });
      await invalidate();
      toast('success', t('{name} added.', { name: v.displayName }));
    } catch (e) { setError(errorMessage(e)); }
  };

  const remove = async (p: Participant) => {
    if (!(await confirm({ title: t('Remove {name}?', { name: p.displayName }), body: t('Their registration and private contact details will be deleted. They can register again while registration is open.'), confirmLabel: t('Remove participant'), destructive: true }))) return;
    try { await service.removeParticipant(p.id); await invalidate(); toast('success', t('{name} removed.', { name: p.displayName })); }
    catch (e) { toast('error', errorMessage(e)); }
  };

  const cancelConfirmed = async (p: Participant) => {
    if (!(await confirm({
      title: t('Cancel the registration of {name}?', { name: p.displayName }),
      body: t('The place is released and the player sees the status "Cancelled". You can then offer the place to the next player on the waitlist.'),
      confirmLabel: t('Cancel registration'), destructive: true,
    }))) return;
    try { await service.registrationAction(p.id, 'cancel'); await invalidate(); toast('warning', t('Registration of {name} cancelled.', { name: p.displayName })); }
    catch (e) { toast('error', errorMessage(e)); }
  };

  const saveSeed = (p: Participant) => async (v: string) => {
    const seed = v === '' ? null : Number(v);
    if (seed !== null && (!Number.isInteger(seed) || seed < 1 || seed > 256)) {
      toast('error', t('Seed must be a whole number from 1 to 256.'));
      throw new Error('invalid');
    }
    try { await service.updateParticipant(p.id, { seed }); await invalidate(); toast('success', t('Seed updated for {name}.', { name: p.displayName })); }
    catch (e) { toast('error', errorMessage(e)); throw e; }
  };

  const sorted = [...confirmed].sort((a, c) => (a.seed ?? 999) - (c.seed ?? 999) || a.createdAt.localeCompare(c.createdAt));
  const withTeam = confirmed.filter((p) => p.team).length;

  return (
    <div className="space-y-5">
      <ClubSuggestions />
      {locked && !closed && (
        <Alert tone="info" title={<span className="flex items-center gap-2"><Lock className="h-4 w-4" />{t('Participant list is locked')}</span>}>
          {t('Fixtures have been generated. Reset the fixtures in Stage control to add, remove or reseed players. Teams are assigned now — here or in Stage control.')}
        </Alert>
      )}
      {(hasApplications || b.participants.length > 0) && <ApplicationsPanel b={b} contactOf={contactOf} />}
      {!locked && (
        <Card>
          <CardHeader title={t('Add participant')} description={full ? t('The tournament is full. Raise the capacity in Settings to add more.') : t('Add players who registered offline (for example, paid in cash). They are confirmed immediately.')} />
          <form onSubmit={handleSubmit(add)} className="grid gap-3 p-4 sm:grid-cols-2 sm:p-5 lg:grid-cols-[1fr_1fr_6rem_auto] lg:items-end" noValidate>
            {error && <Alert tone="danger" title={error} className="sm:col-span-2 lg:col-span-4" />}
            <Field label={t('Display name')} error={errors.displayName?.message}>{(p) => <Input {...p} {...register('displayName')} disabled={full} />}</Field>
            <Field label={t('Contact')} error={errors.contact?.message}>{(p) => <Input {...p} {...register('contact')} disabled={full} placeholder={t('Optional')} />}</Field>
            <Field label={t('Seed')} error={errors.seed?.message}>{(p) => <Input {...p} {...register('seed')} inputMode="numeric" disabled={full} placeholder="—" />}</Field>
            <Button type="submit" variant="primary" loading={isSubmitting} disabled={full}><UserPlus className="h-4 w-4" />{t('Add')}</Button>
          </form>
        </Card>
      )}
      <Card>
        <CardHeader
          title={t('Participants ({count}/{max})', { count: confirmed.length, max: tour.maxParticipants })}
          description={drawn
            ? t('Assign a team (club) to each player; type any name or pick a suggestion. Seeds are optional. Contact details are visible only to organizers.')
            : t('Teams are assigned after the draw. Seeds are optional. Contact details are visible only to organizers.')}
          action={confirmed.length > 0 && <span className="flex items-center gap-1.5 text-xs text-muted"><Shield className="h-3.5 w-3.5" aria-hidden />{t('Teams assigned: {n}/{total}', { n: withTeam, total: confirmed.length })}</span>}
        />
        {!confirmed.length ? (
          <div className="p-4"><EmptyState icon={<Users className="h-8 w-8" />} title={t('No participants yet')} description={hasApplications ? t('Confirm paid applications above or add players manually.') : t('Open registration or add players manually.')} /></div>
        ) : (
          <div className="relative overflow-x-auto">
            <table className="w-full min-w-[40rem] text-sm">
              <thead>
                <tr className="text-left text-xs text-subtle">
                  <th className="py-2 pl-4 font-medium sm:pl-5">{t('Player')}</th>
                  <th className="py-2 font-medium">{t('Team')}</th>
                  <th className="py-2 font-medium">{t('Contact')}</th>
                  <th className="py-2 font-medium">{t('Seed')}</th>
                  <th className="py-2 pr-4 sm:pr-5"><span className="sr-only">{t('Actions')}</span></th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((p) => {
                  return (
                    <tr key={p.id} className="border-t border-line align-middle">
                      <td className="py-2 pl-4 font-medium sm:pl-5">{p.displayName}</td>
                      <td className="py-2 pr-3">
                        {drawn
                          ? <TeamInput p={p} onSave={saveTeam(p)} disabled={closed} duplicate={!!p.team && dups.has(p.team.toLowerCase())} />
                          : <span className="text-xs text-subtle">{t('After the draw')}</span>}
                      </td>
                      <td className="py-2 text-muted">{contacts.isLoading ? '…' : contactOf.get(p.id) ?? <span className="text-subtle">—</span>}</td>
                      <td className="py-2">
                        <InlineField
                          key={`${p.id}-${p.seed ?? ''}`}
                          initial={p.seed?.toString() ?? ''} label={t('Seed for {name}', { name: p.displayName })} disabled={locked}
                          placeholder="—" inputMode="numeric" className="h-9 w-16 text-center tabular"
                          sanitize={(v) => v.replace(/\D/g, '').slice(0, 3)} onSave={saveSeed(p)}
                        />
                      </td>
                      <td className="py-2 pr-4 text-right sm:pr-5">
                        <Button variant="ghost" size="icon" disabled={locked} onClick={() => cancelConfirmed(p)} aria-label={t('Cancel the registration of {name}', { name: p.displayName })} title={t('Cancel registration (frees the place)')}><Ban className="h-4 w-4" /></Button>
                        <Button variant="ghost" size="icon" disabled={locked} onClick={() => remove(p)} aria-label={t('Remove {name}', { name: p.displayName })} title={t('Delete completely')}><Trash2 className="h-4 w-4" /></Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
