// LOCAL DEVELOPMENT MODE — used when no Supabase credentials are configured.
// Data lives in this browser's localStorage and the visitor is treated as a local organizer.
// There is NO authentication or authorization here: anyone with access to the browser can
// change anything. It exists for development, demos and end-to-end tests only.

import {
  applyMutation as applyToBundle, assertCanAssignTeam, assertCanMarkReceiptSent, assertCanRegister, assertCanRemoveParticipant, assertCanSetRegistrationStatus,
  EngineError, initialRegistrationStatus, isConfirmed, normalizeName, planStatusChange, uuid, type Mutation,
} from '@/engine';
import type { Group, GroupMember, Match, Participant, ParticipantContact, Tournament, TournamentBundle, UserIdentity } from '@/types/domain';
import { AppError, type AuthApi, type DataService, type MyApplication, type TournamentInput, type TournamentSummary } from './service';

interface LocalDb {
  tournaments: Tournament[];
  participants: Participant[];
  contacts: ParticipantContact[];
  groups: Group[];
  groupMembers: GroupMember[];
  matches: Match[];
}

const KEY = 'kickoff:local-db:v1';
export const LOCAL_USER: UserIdentity = { id: 'local-organizer', email: null, displayName: 'Local organizer', role: 'organizer' };

const empty = (): LocalDb => ({ tournaments: [], participants: [], contacts: [], groups: [], groupMembers: [], matches: [] });

function load(): LocalDb {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return empty();
    const db = { ...empty(), ...(JSON.parse(raw) as LocalDb) };
    // Data saved before teams / paid registration existed lacks those fields.
    db.participants = db.participants.map((p) => ({ ...p, team: p.team ?? null, status: p.status ?? 'confirmed' }));
    return db;
  } catch {
    return empty();
  }
}

function save(db: LocalDb) {
  try {
    localStorage.setItem(KEY, JSON.stringify(db));
  } catch {
    throw new AppError('Could not save to browser storage (it may be full or disabled).');
  }
}

const wait = () => new Promise((r) => setTimeout(r, 60)); // keeps loading states honest in development

function wrap<T>(fn: () => T): Promise<T> {
  return wait().then(() => {
    try {
      return fn();
    } catch (e) {
      if (e instanceof EngineError) throw new AppError(e.message, e.code);
      throw e;
    }
  });
}

function bundleOf(db: LocalDb, id: string): TournamentBundle | null {
  const tournament = db.tournaments.find((t) => t.id === id);
  if (!tournament) return null;
  return {
    tournament,
    participants: db.participants.filter((p) => p.tournamentId === id),
    groups: db.groups.filter((g) => g.tournamentId === id),
    groupMembers: db.groupMembers.filter((g) => g.tournamentId === id),
    matches: db.matches.filter((m) => m.tournamentId === id),
  };
}

function writeBundle(db: LocalDb, b: TournamentBundle) {
  const id = b.tournament.id;
  db.tournaments = db.tournaments.map((t) => (t.id === id ? b.tournament : t));
  db.groups = [...db.groups.filter((g) => g.tournamentId !== id), ...b.groups];
  db.groupMembers = [...db.groupMembers.filter((g) => g.tournamentId !== id), ...b.groupMembers];
  db.matches = [...db.matches.filter((m) => m.tournamentId !== id), ...b.matches];
}

const summary = (db: LocalDb, t: Tournament): TournamentSummary => ({ ...t, participantCount: db.participants.filter((p) => p.tournamentId === t.id && isConfirmed(p)).length });

// Applications made from this browser — local mode has no accounts, so this is the "personal cabinet".
const MY_KEY = 'temcch:my-applications';
function myIds(): string[] {
  try { return JSON.parse(localStorage.getItem(MY_KEY) ?? '[]') as string[]; } catch { return []; }
}
function rememberMine(id: string) {
  try { localStorage.setItem(MY_KEY, JSON.stringify([...new Set([...myIds(), id])])); } catch { /* not persisted */ }
}

const listeners = new Set<() => void>();

const auth: AuthApi = {
  getUser: async () => LOCAL_USER,
  signIn: async () => { throw new AppError('Sign-in is not available in local mode. Configure Supabase to enable accounts.'); },
  signUp: async () => { throw new AppError('Sign-up is not available in local mode. Configure Supabase to enable accounts.'); },
  signOut: async () => undefined,
  updateNickname: async () => { throw new AppError('Accounts are disabled in local mode'); },
  nicknameAvailable: async () => true,
  onChange: (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
};

export function createLocalService(): DataService {
  return {
    mode: 'local',
    auth,

    listTournaments: () => wrap(() => {
      const db = load();
      // Drafts are only visible to their manager — in local mode that is always the local organizer.
      return db.tournaments.map((t) => summary(db, t));
    }),

    listManagedTournaments: () => wrap(() => {
      const db = load();
      return db.tournaments.filter((t) => t.ownerId === LOCAL_USER.id).map((t) => summary(db, t));
    }),

    getBundle: (id) => wrap(() => bundleOf(load(), id)),

    createTournament: (input: TournamentInput) => wrap(() => {
      const db = load();
      const now = new Date().toISOString();
      const t: Tournament = { ...input, id: uuid(), ownerId: LOCAL_USER.id, status: 'draft', version: 1, createdAt: now, updatedAt: now };
      db.tournaments.push(t);
      save(db);
      return t;
    }),

    updateTournament: (id, input) => wrap(() => {
      const db = load();
      const b = bundleOf(db, id);
      if (!b) throw new AppError('Tournament not found.');
      const t = b.tournament;
      if (b.matches.length) {
        const s = input.settings;
        const structural = (input.format && input.format !== t.format) || (s && (
          s.groupCount !== t.settings.groupCount || s.advancePerGroup !== t.settings.advancePerGroup ||
          s.doubleRoundRobin !== t.settings.doubleRoundRobin || s.thirdPlaceMatch !== t.settings.thirdPlaceMatch));
        if (structural) throw new AppError('Format and structure settings cannot change after fixtures exist.');
      }
      const confirmed = b.participants.filter(isConfirmed).length;
      if (input.maxParticipants !== undefined && input.maxParticipants < confirmed)
        throw new AppError(`Capacity cannot be lower than the current number of participants (${confirmed}).`);
      const next: Tournament = { ...t, ...input, updatedAt: new Date().toISOString() };
      db.tournaments = db.tournaments.map((x) => (x.id === id ? next : x));
      save(db);
      return next;
    }),

    setStatus: (id, status) => wrap(() => {
      const db = load();
      const b = bundleOf(db, id);
      if (!b) throw new AppError('Tournament not found.');
      const { mutation } = planStatusChange(b, status);
      writeBundle(db, applyToBundle(b, mutation, new Date().toISOString()));
      save(db);
    }),

    deleteTournament: (id) => wrap(() => {
      const db = load();
      db.tournaments = db.tournaments.filter((t) => t.id !== id);
      const pids = new Set(db.participants.filter((p) => p.tournamentId === id).map((p) => p.id));
      db.participants = db.participants.filter((p) => p.tournamentId !== id);
      db.contacts = db.contacts.filter((c) => !pids.has(c.participantId));
      db.groups = db.groups.filter((g) => g.tournamentId !== id);
      db.groupMembers = db.groupMembers.filter((g) => g.tournamentId !== id);
      db.matches = db.matches.filter((m) => m.tournamentId !== id);
      save(db);
    }),

    register: (tournamentId, input) => wrap(() => {
      const p = addParticipant(tournamentId, input, false);
      rememberMine(p.id);
      return p;
    }),
    addParticipant: (tournamentId, input) => wrap(() => addParticipant(tournamentId, input, true)),

    updateParticipant: (participantId, patch) => wrap(() => {
      const db = load();
      const p = db.participants.find((x) => x.id === participantId);
      if (!p) throw new AppError('Participant not found.');
      const b = bundleOf(db, p.tournamentId) as TournamentBundle;
      if (patch.team !== undefined) assertCanAssignTeam(b.tournament, b.matches.length > 0);
      if (b.tournament.status === 'completed' || b.tournament.status === 'cancelled') throw new AppError('This tournament is closed.');
      const onlyTeam = Object.keys(patch).every((k) => k === 'team');
      if (b.matches.length && !onlyTeam) throw new AppError('Participants cannot change after fixtures have been generated.');
      if (patch.displayName !== undefined) {
        const name = patch.displayName.trim();
        if (db.participants.some((x) => x.tournamentId === p.tournamentId && x.id !== p.id && normalizeName(x.displayName) === normalizeName(name)))
          throw new AppError('This name is already registered.');
        p.displayName = name;
        p.gamertag = name;
      }
      if (patch.seed !== undefined) p.seed = patch.seed;
      if (patch.team !== undefined) p.team = patch.team?.trim() ? patch.team.trim().slice(0, 40) : null;
      save(db);
    }),

    removeParticipant: (participantId) => wrap(() => {
      const db = load();
      const p = db.participants.find((x) => x.id === participantId);
      if (!p) throw new AppError('Participant not found.');
      const b = bundleOf(db, p.tournamentId) as TournamentBundle;
      assertCanRemoveParticipant(b.tournament, b.matches.length > 0);
      db.participants = db.participants.filter((x) => x.id !== participantId);
      db.contacts = db.contacts.filter((c) => c.participantId !== participantId);
      save(db);
    }),

    setRegistrationStatus: (participantId, status) => wrap(() => {
      const db = load();
      const p = db.participants.find((x) => x.id === participantId);
      if (!p) throw new AppError('Participant not found.');
      const b = bundleOf(db, p.tournamentId) as TournamentBundle;
      assertCanSetRegistrationStatus(b.tournament, b.participants, p, status, b.matches.length > 0);
      p.status = status;
      save(db);
    }),

    markReceiptSent: (participantId) => wrap(() => {
      const db = load();
      const p = db.participants.find((x) => x.id === participantId);
      if (!p) throw new AppError('Participant not found.');
      const b = bundleOf(db, p.tournamentId) as TournamentBundle;
      if (b.matches.length) throw new AppError('Registration status cannot change after the draw.');
      assertCanMarkReceiptSent(p);
      p.status = 'awaiting_review';
      save(db);
    }),

    listMyApplications: () => wrap(() => {
      const db = load();
      const mine = new Set(myIds());
      return db.participants
        .filter((p) => mine.has(p.id))
        .flatMap((p): MyApplication[] => {
          const tournament = db.tournaments.find((t) => t.id === p.tournamentId);
          return tournament ? [{ participant: p, tournament }] : [];
        })
        .sort((a, c) => c.participant.createdAt.localeCompare(a.participant.createdAt));
    }),

    listContacts: (tournamentId) => wrap(() => {
      const db = load();
      const ids = new Set(db.participants.filter((p) => p.tournamentId === tournamentId).map((p) => p.id));
      return db.contacts.filter((c) => ids.has(c.participantId));
    }),

    applyMutation: (tournamentId, expectedVersion, mutation: Mutation) => wrap(() => {
      const db = load();
      const b = bundleOf(db, tournamentId);
      if (!b) throw new AppError('Tournament not found.');
      if (b.tournament.version !== expectedVersion) throw new AppError('This tournament was changed elsewhere. Reload and try again.', 'CONFLICT');
      if (b.tournament.status === 'completed' || b.tournament.status === 'cancelled') throw new AppError('This tournament is closed for changes.');
      writeBundle(db, applyToBundle(b, mutation, new Date().toISOString()));
      save(db);
    }),
  };

  function addParticipant(tournamentId: string, input: { displayName: string; contact?: string | null; seed?: number | null }, asOrganizer: boolean): Participant {
    const db = load();
    const b = bundleOf(db, tournamentId);
    if (!b || (b.tournament.status === 'draft' && !asOrganizer)) throw new AppError('Tournament not found.');
    if (b.matches.length) throw new AppError('Participants cannot be added after fixtures have been generated.');
    assertCanRegister(b.tournament, b.participants, input, { userId: null, asOrganizer });
    const p: Participant = {
      id: uuid(), tournamentId, displayName: input.displayName.trim(), gamertag: input.displayName.trim(),
      team: null, status: initialRegistrationStatus(b.tournament, asOrganizer),
      seed: input.seed ?? null, userId: null, createdAt: new Date().toISOString(),
    };
    db.participants.push(p);
    if (input.contact?.trim()) db.contacts.push({ participantId: p.id, contact: input.contact.trim() });
    save(db);
    return p;
  }
}

export function resetLocalData() {
  localStorage.removeItem(KEY);
}
