// ─── Core domain types ────────────────────────────────────────────────────────

export type GameStatus = 'lobby' | 'playing' | 'voting' | 'results';

export interface Player {
  id: string;
  name: string;
}

export interface Room {
  code: string;
  hostId: string;
  players: Player[];
  status: GameStatus;
  // Game config (set by host before starting, preserved across rematches):
  totalRounds: number;
  turnDuration: number;     // ms per drawing turn
  timerMode: 'classic' | 'draw'; // classic = always counting; draw = pauses when pen is up
  imposterGuess: boolean;   // whether the imposter gets a chance to guess the word at the end
  category: string | null;  // null = random from all categories
  // Phase 3+ (present from creation but unused until Phase 3):
  word: string | null;
  imposterId: string | null;
  turnOrder: string[];
  currentTurnIndex: number;
  currentRound: number;
  votes: Record<string, string>; // voterId → accusedId
  createdAt: number; // unix ms
}

// ─── Drawing events ───────────────────────────────────────────────────────────

/** A single stroke segment with coordinates normalized to [0, 1]. */
export interface DrawEvent {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  color: string;
  lineWidth: number; // canvas buffer pixels (800×600 space)
  tool: 'pen' | 'eraser';
}

/** A draw event re-broadcast by the server, including who drew it. */
export interface BroadcastedDrawEvent extends DrawEvent {
  drawerId: string;
}

// ─── Voting ───────────────────────────────────────────────────────────────────

/** Final voting results broadcast to all clients after everyone has voted. */
export interface VotingResults {
  /** How many votes each player received. */
  tally: Record<string, number>; // playerId → vote count
  imposterId: string;
  word: string;
  /**
   * True when a single player received more votes than anyone else
   * AND that player is the imposter. Ties go to the imposter.
   */
  artistsWin: boolean;
  /**
   * Set when the imposter won by correctly guessing the word (voting was skipped).
   * Contains the exact guess string they submitted.
   */
  guessedWord?: string;
  /**
   * Set when the imposter attempted a guess but got it wrong.
   * The artists still win, but the guess is shown on the results screen.
   */
  wrongGuess?: string;
}

// ─── PartyKit message protocol ────────────────────────────────────────────────

/** Messages broadcast from the PartyKit server to all clients. */
export type ServerMessage =
  | { type: 'player_joined'; player: Player }
  | { type: 'player_left'; playerId: string }
  | { type: 'lobby_sync'; players: Player[] }
  | { type: 'player_kicked'; playerId: string }
  | { type: 'game_started' }
  | { type: 'reveal_progress'; readyCount: number; totalPlayers: number; deadline: number }
  | { type: 'draw'; event: BroadcastedDrawEvent }
  | { type: 'canvas_history'; events: BroadcastedDrawEvent[] }
  | { type: 'canvas_clear' }
  | {
      /** Announced before a turn begins — drawer must click Ready before the timer starts. */
      type: 'turn_prep';
      drawerId: string;
      turnIndex: number;
      round: number;
      totalRounds: number;
    }
  | {
      type: 'turn_started';
      drawerId: string;
      turnIndex: number;
      round: number;
      totalRounds: number;
      turnDuration: number; // ms — full turn length
      timeLeft: number;     // ms remaining (< turnDuration on reconnect)
    }
  | { type: 'timer_started'; turnEndTime: number } // fired when drawer makes their first stroke
  | { type: 'timer_update'; turnEndTime: number; remainingMs: number; paused: boolean }
  | { type: 'imposter_guess_phase'; deadline: number }
  | { type: 'game_over' }
  | { type: 'game_reset' }
  | { type: 'vote_cast'; votedCount: number; totalPlayers: number }
  | { type: 'voting_complete'; results: VotingResults };

/** Messages sent from a client to the PartyKit server. */
export type ClientMessage =
  | { type: 'ping' }
  | { type: 'draw'; event: DrawEvent }
  | { type: 'draw_start' }   // pen down — resume timer
  | { type: 'draw_pause' }   // pen up   — pause timer
  | { type: 'skip_turn' }
  | { type: 'player_ready' }
  | { type: 'reveal_acknowledged' }
  | { type: 'dev_skip_bot_turn' };  // dev only — skip the current bot's turn immediately
