// Supabase backend. Uses only the public anon key; every write is authorized by RLS policies
// or by SECURITY DEFINER functions that check permissions (see supabase/migrations).
import { createClient, type PostgrestError, type SupabaseClient } from '@supabase/supabase-js';
import { EngineError, planAdminAction } from '@/engine';
import type { CapacityCounts, RegistrationStatus, UserIdentity } from '@/types/domain';
import {
  parseSettings, toDbMutation, toGroup, toGroupMember, toMatch, toParticipant, toTournament,
  type GroupMemberRow, type GroupRow, type MatchRow, type ParticipantRow, type TournamentRow,
} from './mappers';
import { AppError, type DataService, type MyApplication, type TournamentInput, type TournamentSummary } from './service';

function fail(error: PostgrestError | { message: string; code?: string } | null): never {
  const code = error && 'code' in error ? error.code ?? 'ERROR' : 'ERROR';
  let message = error?.message ?? 'Unexpected error';
  if (code === '42501' && /row-level security/i.test(message)) message = 'You do not have permission to do that.';
  if (code === '23505' && /participants_(tag|name)_unique/.test(message)) message = 'This name is already registered.';
  if (code === '23505' && /profiles_nickname_unique/.test(message)) message = 'This nickname is already taken.';
  if (code === '23505' && /participants_application_code_unique/.test(message)) message = 'Please try again.';
  if (code === 'PGRST116') message = 'Not found.';
  throw new AppError(message, code);
}

function check(res: { data: unknown; error: PostgrestError | null }): unknown {
  if (res.error) fail(res.error);
  return res.data;
}

type SummaryRow = TournamentRow & { participants: { count: number }[] };
const toSummary = (r: SummaryRow): TournamentSummary => ({ ...toTournament(r), participantCount: r.participants?.[0]?.count ?? 0 });

const tournamentColumns = (i: Partial<TournamentInput>) => {
  const row: Record<string, unknown> = {};
  if (i.name !== undefined) row.name = i.name;
  if (i.description !== undefined) row.description = i.description;
  if (i.rules !== undefined) row.rules = i.rules;
  if (i.venue !== undefined) row.venue = i.venue;
  if (i.startsAt !== undefined) row.starts_at = i.startsAt;
  if (i.registrationDeadline !== undefined) row.registration_deadline = i.registrationDeadline;
  if (i.format !== undefined) row.format = i.format;
  if (i.maxParticipants !== undefined) row.max_participants = i.maxParticipants;
  if (i.settings !== undefined) row.settings = i.settings;
  return row;
};

export function createSupabaseService(url: string, anonKey: string): DataService {
  const sb: SupabaseClient = createClient(url, anonKey, { auth: { persistSession: true, autoRefreshToken: true } });

  async function currentUser(): Promise<UserIdentity | null> {
    const { data, error } = await sb.auth.getUser();
    if (error || !data.user) return null;
    const { data: profile } = await sb.from('profiles').select('display_name, role').eq('id', data.user.id).maybeSingle();
    return {
      id: data.user.id,
      email: data.user.email ?? null,
      displayName: profile?.display_name || data.user.email || 'Player',
      role: (profile?.role as UserIdentity['role']) ?? 'user',
    };
  }

  return {
    mode: 'supabase',
    auth: {
      getUser: currentUser,
      async signIn(email, password) {
        const { error } = await sb.auth.signInWithPassword({ email, password });
        if (error) fail({ message: error.message === 'Invalid login credentials' ? 'Incorrect email or password.' : error.message });
      },
      async signUp(email, password, displayName) {
        const { data, error } = await sb.auth.signUp({ email, password, options: { data: { display_name: displayName } } });
        if (error) fail({ message: error.message });
        return { needsConfirmation: !data.session };
      },
      async signOut() {
        await sb.auth.signOut();
      },
      async updateNickname(nickname) {
        const { data } = await sb.auth.getUser();
        if (!data.user) fail({ message: 'Sign in first' });
        check(await sb.from('profiles').update({ display_name: nickname.trim() }).eq('id', data.user.id).select('id').single());
      },
      async nicknameAvailable(nickname) {
        return check(await sb.rpc('nickname_available', { p_nickname: nickname })) as boolean;
      },
      onChange(cb) {
        const { data } = sb.auth.onAuthStateChange(() => cb());
        return () => data.subscription.unsubscribe();
      },
    },

    async listTournaments() {
      const rows = check(await sb.from('tournaments').select('*, participants(count)').neq('status', 'draft').order('starts_at', { ascending: true, nullsFirst: false }));
      return (rows as SummaryRow[]).map(toSummary);
    },

    async listManagedTournaments(userId) {
      // RLS already limits drafts to managers; filter to what this user owns or co-manages.
      const managed = check(await sb.from('tournament_managers').select('tournament_id').eq('user_id', userId)) as { tournament_id: string }[];
      const ids = managed.map((m) => m.tournament_id);
      let q = sb.from('tournaments').select('*, participants(count)').order('created_at', { ascending: false });
      q = ids.length ? q.or(`owner_id.eq.${userId},id.in.(${ids.join(',')})`) : q.eq('owner_id', userId);
      return (check(await q) as SummaryRow[]).map(toSummary);
    },

    async getBundle(id) {
      const [t, p, g, gm, m, c] = await Promise.all([
        sb.from('tournaments').select('*').eq('id', id).maybeSingle(),
        sb.from('participants').select('*').eq('tournament_id', id).order('created_at'),
        sb.from('groups').select('*').eq('tournament_id', id),
        sb.from('group_members').select('*').eq('tournament_id', id),
        sb.from('matches').select('*').eq('tournament_id', id),
        // Public viewers only see confirmed rows, so place counts come from the server.
        sb.rpc('tournament_counts', { p_tournament_id: id }),
      ]);
      const tr = check(t) as TournamentRow | null;
      if (!tr) return null;
      return {
        tournament: toTournament(tr),
        participants: (check(p) as ParticipantRow[]).map(toParticipant),
        groups: (check(g) as GroupRow[]).map(toGroup),
        groupMembers: (check(gm) as GroupMemberRow[]).map(toGroupMember),
        matches: (check(m) as MatchRow[]).map(toMatch),
        counts: ((check(c) as CapacityCounts[] | null) ?? [])[0],
      };
    },

    async createTournament(input) {
      const user = await currentUser();
      if (!user) fail({ message: 'Sign in to create a tournament.' });
      const row = check(await sb.from('tournaments').insert({ ...tournamentColumns(input), owner_id: user.id }).select('*').single());
      return toTournament(row as TournamentRow);
    },

    async updateTournament(id, input) {
      const row = check(await sb.from('tournaments').update(tournamentColumns(input)).eq('id', id).select('*').single());
      return toTournament(row as TournamentRow);
    },

    async setStatus(id, status) {
      check(await sb.from('tournaments').update({ status }).eq('id', id).select('id').single());
    },

    async deleteTournament(id) {
      check(await sb.from('tournaments').delete().eq('id', id));
    },

    async register(tournamentId, input) {
      const pid = check(await sb.rpc('register_for_tournament', {
        p_tournament_id: tournamentId, p_display_name: input.displayName, p_gamertag: input.displayName, p_contact: input.contact ?? null,
      })) as string;
      const row = check(await sb.from('participants').select('*').eq('id', pid).single());
      return toParticipant(row as ParticipantRow);
    },

    async addParticipant(tournamentId, input) {
      const row = check(await sb.from('participants').insert({
        tournament_id: tournamentId, display_name: input.displayName.trim(), gamertag: input.displayName.trim(),
        seed: input.seed ?? null,
      }).select('*').single()) as ParticipantRow;
      if (input.contact?.trim()) {
        check(await sb.from('participant_contacts').insert({ participant_id: row.id, tournament_id: tournamentId, contact: input.contact.trim() }));
      }
      return toParticipant(row);
    },

    async updateParticipant(participantId, patch) {
      const row: Record<string, unknown> = {};
      if (patch.displayName !== undefined) { row.display_name = patch.displayName.trim(); row.gamertag = patch.displayName.trim(); }
      if (patch.seed !== undefined) row.seed = patch.seed;
      if (patch.team !== undefined) row.team = patch.team?.trim() ? patch.team.trim().slice(0, 40) : null;
      check(await sb.from('participants').update(row).eq('id', participantId).select('id').single());
    },

    async removeParticipant(participantId) {
      check(await sb.from('participants').delete().eq('id', participantId).select('id').single());
    },

    async registrationAction(participantId, action) {
      // The engine decides the transition from fresh data; the database trigger re-checks capacity
      // under a row lock and RLS limits the update to the tournament's managers.
      const pr = check(await sb.from('participants').select('tournament_id').eq('id', participantId).single()) as { tournament_id: string };
      const b = await this.getBundle(pr.tournament_id);
      const p = b?.participants.find((x) => x.id === participantId);
      if (!b || !p) fail({ message: 'Participant not found.' });
      let outcome;
      try {
        outcome = planAdminAction(b.tournament, b.participants, p, action, b.matches.length > 0);
      } catch (e) {
        if (e instanceof EngineError) throw new AppError(e.message, e.code);
        throw e;
      }
      check(await sb.from('participants').update({ payment_status: outcome.status, reserved_until: outcome.reservedUntil }).eq('id', participantId).select('id').single());
    },

    async markReceiptSent(participantId) {
      return check(await sb.rpc('mark_receipt_sent', { p_participant_id: participantId })) as RegistrationStatus;
    },

    async cancelMyRegistration(participantId) {
      check(await sb.rpc('cancel_my_registration', { p_participant_id: participantId }));
    },

    async waitlistPosition(participantId) {
      return (check(await sb.rpc('waitlist_position', { p_participant_id: participantId })) as number | null) ?? null;
    },

    async listMyApplications() {
      const { data } = await sb.auth.getUser();
      if (!data.user) return [];
      type Row = ParticipantRow & { tournaments: Pick<TournamentRow, 'id' | 'name' | 'status' | 'starts_at' | 'settings'> | null };
      const rows = check(await sb.from('participants')
        .select('*, tournaments(id, name, status, starts_at, settings)')
        .eq('user_id', data.user.id)
        .order('created_at', { ascending: false })) as Row[];
      return rows.filter((r) => r.tournaments).map((r): MyApplication => {
        const tr = r.tournaments as NonNullable<Row['tournaments']>;
        return {
          participant: toParticipant(r),
          tournament: { id: tr.id, name: tr.name, status: tr.status, startsAt: tr.starts_at, settings: parseSettings(tr.settings) },
        };
      });
    },

    async listContacts(tournamentId) {
      const rows = check(await sb.from('participant_contacts').select('participant_id, contact').eq('tournament_id', tournamentId)) as { participant_id: string; contact: string }[];
      return rows.map((r) => ({ participantId: r.participant_id, contact: r.contact }));
    },

    async applyMutation(tournamentId, expectedVersion, mutation) {
      check(await sb.rpc('apply_tournament_mutation', { p_tournament_id: tournamentId, p_expected_version: expectedVersion, p_mutation: toDbMutation(mutation) }));
    },
  };
}
