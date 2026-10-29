import { DEFAULT_SETTINGS, type Match, type Participant, type Tournament, type TournamentBundle, type TournamentSettings } from '@/types/domain';
import { sequentialIds, type CommandContext } from '@/engine';

export const NOW = '2026-10-28T12:00:00.000Z';

export function makeParticipants(n: number, tournamentId = 't1'): Participant[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `p${String(i + 1).padStart(2, '0')}`,
    tournamentId,
    displayName: `Player ${i + 1}`,
    gamertag: `Player ${i + 1}`,
    team: null,
    status: 'confirmed' as const,
    seed: null,
    userId: null,
    createdAt: new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString(),
  }));
}

export function makeTournament(over: Partial<Tournament> = {}, settings: Partial<TournamentSettings> = {}): Tournament {
  return {
    id: 't1', ownerId: 'owner', name: 'Test Cup', description: '', rules: '', venue: '', startsAt: null, registrationDeadline: null,
    format: 'groups_knockout', status: 'registration_closed', maxParticipants: 16,
    settings: { ...DEFAULT_SETTINGS, ...settings }, version: 1, createdAt: NOW, updatedAt: NOW, ...over,
  };
}

export function makeBundle(n: number, over: Partial<Tournament> = {}, settings: Partial<TournamentSettings> = {}): TournamentBundle {
  return { tournament: makeTournament(over, settings), participants: makeParticipants(n), groups: [], groupMembers: [], matches: [] };
}

// One shared id sequence so ids never collide across commands within a test run.
const sharedIds = sequentialIds('x');
export const ctx = (): CommandContext => ({ ids: sharedIds, now: NOW });

let mId = 0;
export function groupMatch(home: string, away: string, hs: number | null, as: number | null, over: Partial<Match> = {}): Match {
  mId++;
  return {
    id: `m${mId}`, tournamentId: 't1', stage: 'group', groupId: 'g1', round: mId, slot: 0, isThirdPlace: false,
    homeId: home, awayId: away, homeScore: hs, awayScore: as, homePens: null, awayPens: null,
    winnerId: null, walkover: false, status: hs === null ? 'scheduled' : 'completed', scheduledAt: null, station: null,
    nextMatchId: null, nextSlot: null, loserNextMatchId: null, loserNextSlot: null, updatedAt: NOW, ...over,
  };
}
