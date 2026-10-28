export type EngineErrorCode =
  | 'INVALID_CONFIG'
  | 'INVALID_SCORE'
  | 'INVALID_STATE'
  | 'STAGE_INCOMPLETE'
  | 'NOT_FOUND'
  | 'DUPLICATE'
  | 'KNOCKOUT_CONFLICT';

/** A rule violation the UI can show to the organizer as-is. */
export class EngineError extends Error {
  readonly code: EngineErrorCode;
  constructor(code: EngineErrorCode, message: string) {
    super(message);
    this.name = 'EngineError';
    this.code = code;
  }
}
