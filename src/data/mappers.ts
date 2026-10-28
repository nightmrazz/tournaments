// Conversions between database rows (snake_case) and domain objects (camelCase).
import type { Mutation } from '@/engine';
import { DEFAULT_SETTINGS, type Group, type GroupMember, type Match, type Participant, type Tournament, type TournamentSettings } from '@/types/domain';

export interface TournamentRow {
  id: string; owner_id: string; name: string; description: string; rules: string; venue: string;
  starts_at: string | null; registration_deadline: string | null; format: Tournament['format']; status: Tournament['status'];
  max_participants: number; settings: Partial<TournamentSettings>; version: number; created_at: string; updated_at: string;
}
export interface ParticipantRow {
  id: string; tournament_id: string; display_name: string; gamertag: string; team: string | null; seed: number | null; user_id: string | null; created_at: string;
}
export interface GroupRow { id: string; tournament_id: string; name: string; index: number }
export interface GroupMemberRow { group_id: string; participant_id: string; tournament_id: string; position: number }
export interface MatchRow {
  id: string; tournament_id: string; stage: Match['stage']; group_id: string | null; round: number; slot: number; is_third_place: boolean;
  home_id: string | null; away_id: string | null; home_score: number | null; away_score: number | null;
  home_pens: number | null; away_pens: number | null; winner_id: string | null; walkover: boolean; status: Match['status'];
  scheduled_at: string | null; station: string | null; next_match_id: string | null; next_slot: Match['nextSlot'];
  loser_next_match_id: string | null; loser_next_slot: Match['loserNextSlot']; updated_at: string;
}

/** Settings are stored as JSON; unknown or missing keys fall back to defaults. */
export function parseSettings(raw: unknown): TournamentSettings {
  const s = (raw && typeof raw === 'object' ? raw : {}) as Partial<TournamentSettings>;
  return { ...DEFAULT_SETTINGS, ...s, tiebreakers: Array.isArray(s.tiebreakers) ? s.tiebreakers : DEFAULT_SETTINGS.tiebreakers };
}

export const toTournament = (r: TournamentRow): Tournament => ({
  id: r.id, ownerId: r.owner_id, name: r.name, description: r.description, rules: r.rules, venue: r.venue,
  startsAt: r.starts_at, registrationDeadline: r.registration_deadline, format: r.format, status: r.status,
  maxParticipants: r.max_participants, settings: parseSettings(r.settings), version: r.version, createdAt: r.created_at, updatedAt: r.updated_at,
});

export const toParticipant = (r: ParticipantRow): Participant => ({
  id: r.id, tournamentId: r.tournament_id, displayName: r.display_name, gamertag: r.gamertag, team: r.team ?? null, seed: r.seed, userId: r.user_id, createdAt: r.created_at,
});

export const toGroup = (r: GroupRow): Group => ({ id: r.id, tournamentId: r.tournament_id, name: r.name, index: r.index });
export const toGroupMember = (r: GroupMemberRow): GroupMember => ({ groupId: r.group_id, participantId: r.participant_id, tournamentId: r.tournament_id, position: r.position });

export const toMatch = (r: MatchRow): Match => ({
  id: r.id, tournamentId: r.tournament_id, stage: r.stage, groupId: r.group_id, round: r.round, slot: r.slot, isThirdPlace: r.is_third_place,
  homeId: r.home_id, awayId: r.away_id, homeScore: r.home_score, awayScore: r.away_score, homePens: r.home_pens, awayPens: r.away_pens,
  winnerId: r.winner_id, walkover: r.walkover, status: r.status, scheduledAt: r.scheduled_at, station: r.station,
  nextMatchId: r.next_match_id, nextSlot: r.next_slot, loserNextMatchId: r.loser_next_match_id, loserNextSlot: r.loser_next_slot, updatedAt: r.updated_at,
});

export const fromMatch = (m: Match): Omit<MatchRow, 'updated_at'> => ({
  id: m.id, tournament_id: m.tournamentId, stage: m.stage, group_id: m.groupId, round: m.round, slot: m.slot, is_third_place: m.isThirdPlace,
  home_id: m.homeId, away_id: m.awayId, home_score: m.homeScore, away_score: m.awayScore, home_pens: m.homePens, away_pens: m.awayPens,
  winner_id: m.winnerId, walkover: m.walkover, status: m.status, scheduled_at: m.scheduledAt, station: m.station,
  next_match_id: m.nextMatchId, next_slot: m.nextSlot, loser_next_match_id: m.loserNextMatchId, loser_next_slot: m.loserNextSlot,
});

/** Payload accepted by the apply_tournament_mutation SQL function. */
export function toDbMutation(m: Mutation) {
  return {
    insert_groups: m.insertGroups.map((g) => ({ id: g.id, name: g.name, index: g.index })),
    insert_members: m.insertMembers.map((x) => ({ group_id: x.groupId, participant_id: x.participantId, position: x.position })),
    insert_matches: m.insertMatches.map(fromMatch),
    update_matches: m.updateMatches.map(fromMatch),
    delete_match_ids: m.deleteMatchIds,
    delete_group_ids: m.deleteGroupIds,
    tournament_status: m.tournamentStatus,
  };
}
