import type * as Party from 'partykit/server';
import type {
  BroadcastedDrawEvent,
  ClientMessage,
  Player,
  ServerMessage,
  VotingResults,
} from '../lib/types';
import { removePlayerFromRoom } from '../lib/room';

const DEFAULT_TURN_DURATION_MS = 5_000;
/** Max time to wait for the drawer to click Ready before auto-starting the turn. */
const MAX_PREP_WAIT_MS = 30_000;
/** Max time to wait for all players to acknowledge the reveal before auto-starting. */
const MAX_REVEAL_WAIT_MS = 30_000;
/** Max time to wait for the imposter to submit their final guess. */
const MAX_GUESS_WAIT_MS = 30_000;

// ── Persisted game state (written to room.storage on every mutation) ──────────

interface GameState {
  gameStarted: boolean;
  /** True after all rounds complete — clients that reconnect during voting/results get game_over. */
  gameOver: boolean;
  /** True while waiting for all players to acknowledge the reveal screen. */
  inRevealPhase: boolean;
  /** Epoch ms of the reveal fallback deadline (auto-starts if not everyone acks). */
  revealDeadline: number;
  /** Player IDs that have clicked "Got it" on the reveal screen. */
  revealAcknowledgedIds: string[];
  /** True while waiting for the drawer to click Ready between turns. */
  inPrepPhase: boolean;
  /** Epoch ms of the fallback deadline (auto-starts the turn if drawer never responds). */
  prepDeadline: number;
  turnOrder: string[];
  currentTurnIndex: number;
  currentRound: number;
  totalRounds: number;
  /** Drawing turn duration in ms (configured by host). */
  turnDuration: number;
  /** classic = timer always counts; draw = timer only ticks while pen is down. */
  timerMode: 'classic' | 'draw';
  /** Epoch ms when the current turn expires. 0 = timer not yet started (drawer hasn't drawn). */
  turnEndTime: number;
  /** True while the drawer's pen is down and the timer is counting. */
  drawingActive: boolean;
  /** Remaining ms when the timer is paused (pen is up). Starts as turnDuration. */
  remainingMs: number;
  /** True while the imposter is making their final guess (after voting identified them). */
  inGuessPhase: boolean;
  /** Epoch ms of the guess phase deadline (auto-advances to results if no guess). */
  guessDeadline: number;
  /** The voting results that triggered the guess phase — broadcast as-is if the
   *  imposter guesses wrong, or modified (artistsWin=false, guessedWord set) if correct. */
  originalResults?: VotingResults;
}

const STORAGE_KEY = 'gameState';

const EMPTY_STATE: GameState = {
  gameStarted: false,
  gameOver: false,
  inRevealPhase: false,
  revealDeadline: 0,
  revealAcknowledgedIds: [],
  inPrepPhase: false,
  prepDeadline: 0,
  turnOrder: [],
  currentTurnIndex: 0,
  currentRound: 1,
  totalRounds: 3,
  turnDuration: DEFAULT_TURN_DURATION_MS,
  timerMode: 'classic' as const,
  turnEndTime: 0,
  drawingActive: false,
  remainingMs: DEFAULT_TURN_DURATION_MS,
  inGuessPhase: false,
  guessDeadline: 0,
};

interface ConnectionState {
  playerId: string;
  playerName: string;
}

export default class GameRoom implements Party.Server {
  // In-memory mirror of storage — always in sync after first access.
  private state: GameState = { ...EMPTY_STATE };
  // Whether we've already loaded state from storage once.
  private stateLoaded = false;

  private turnTimer: ReturnType<typeof setTimeout> | null = null;
  private prepTimer: ReturnType<typeof setTimeout> | null = null;
  private revealTimer: ReturnType<typeof setTimeout> | null = null;
  private guessTimer: ReturnType<typeof setTimeout> | null = null;
  private canvasHistory: BroadcastedDrawEvent[] = [];
  /** Pending timers that will remove a disconnected lobby player from Redis.
   *  Keyed by playerId. Cancelled if the player reconnects within the grace period. */
  private lobbyDisconnectTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();

  constructor(readonly room: Party.Room) {}

  // ── Storage helpers ───────────────────────────────────────────────────────

  private async persistState() {
    await this.room.storage.put(STORAGE_KEY, this.state);
  }

  /**
   * Load state from storage into this.state.
   * Safe to call multiple times; after the first successful load stateLoaded
   * is set so subsequent calls are no-ops.
   */
  private async ensureState(): Promise<void> {
    if (this.stateLoaded) return;
    const stored = await this.room.storage.get<GameState>(STORAGE_KEY);
    // Restore if a game was in progress OR has just ended (voting/results phase).
    if (stored && (stored.gameStarted || stored.gameOver)) {
      this.state = stored;
    }
    this.stateLoaded = true;
  }

  // ── Turn management ───────────────────────────────────────────────────────

  private broadcast(msg: ServerMessage, excludeId?: string) {
    this.room.broadcast(JSON.stringify(msg), excludeId ? [excludeId] : []);
  }

  private send(connection: Party.Connection, msg: ServerMessage) {
    connection.send(JSON.stringify(msg));
  }

  /** IDs of players in turnOrder who currently have an open connection. */
  private connectedPlayerIds(): string[] {
    const ids = new Set<string>();
    for (const conn of this.room.getConnections()) {
      const cs = conn.state as ConnectionState | null;
      if (cs?.playerId && this.state.turnOrder.includes(cs.playerId)) {
        ids.add(cs.playerId);
      }
    }
    return [...ids];
  }

  /**
   * Called after each reveal_acknowledged and after each disconnect during
   * the reveal phase. Starts the prep phase if every connected player has
   * acknowledged (disconnected players don't block the game).
   */
  private async advanceRevealIfReady() {
    const connected = this.connectedPlayerIds();
    if (connected.length === 0) return;
    const allReady = connected.every((id) =>
      this.state.revealAcknowledgedIds.includes(id),
    );
    if (!allReady) return;

    if (this.revealTimer) clearTimeout(this.revealTimer);
    this.revealTimer = null;
    this.state.inRevealPhase = false;
    await this.persistState();
    await this.startPrepPhase();
  }

  /**
   * Wait for all players to acknowledge the reveal screen before starting
   * the first prep phase. A 30 s timeout auto-advances if anyone is AFK.
   */
  private async startRevealPhase() {
    if (this.revealTimer) clearTimeout(this.revealTimer);

    this.state.inRevealPhase = true;
    // Pre-acknowledge dev bots — they never connect, so mark them ready immediately
    // so the progress bar and readyCount are accurate in quick-start dev sessions.
    this.state.revealAcknowledgedIds = this.state.turnOrder.filter((id) =>
      id.startsWith('dev-bot-'),
    );
    this.state.revealDeadline = Date.now() + MAX_REVEAL_WAIT_MS;
    await this.persistState();

    this.revealTimer = setTimeout(async () => {
      this.state.inRevealPhase = false;
      await this.persistState();
      await this.startPrepPhase();
    }, MAX_REVEAL_WAIT_MS);
  }

  /**
   * Broadcast a "get ready" announcement and wait for the drawer to click Ready.
   * A 30 s fallback timer auto-starts the turn if the drawer never responds.
   */
  private async startPrepPhase() {
    if (this.prepTimer) clearTimeout(this.prepTimer);
    if (this.turnTimer) clearTimeout(this.turnTimer);
    this.turnTimer = null;

    this.state.inPrepPhase = true;
    this.state.prepDeadline = Date.now() + MAX_PREP_WAIT_MS;
    this.state.turnEndTime = 0;
    await this.persistState();

    const drawerId = this.state.turnOrder[this.state.currentTurnIndex] ?? '';
    this.broadcast({
      type: 'turn_prep',
      drawerId,
      turnIndex: this.state.currentTurnIndex,
      round: this.state.currentRound,
      totalRounds: this.state.totalRounds,
    });

    // Fallback: auto-start if the drawer disconnects or never clicks Ready.
    this.prepTimer = setTimeout(() => {
      this.startTurn().catch(console.error);
    }, MAX_PREP_WAIT_MS);

    // Dev bots never connect, so if the current drawer is a bot skip the wait.
    if (drawerId.startsWith('dev-bot-')) {
      if (this.prepTimer) clearTimeout(this.prepTimer);
      this.prepTimer = null;
      await this.startTurn();
    }
  }

  private async startTurn() {
    if (this.prepTimer) clearTimeout(this.prepTimer);
    this.prepTimer = null;
    if (this.turnTimer) clearTimeout(this.turnTimer);

    this.state.inPrepPhase = false;
    this.state.prepDeadline = 0;
    this.state.drawingActive = false;
    this.state.remainingMs = this.state.turnDuration;
    this.state.turnEndTime = 0;
    await this.persistState();

    const drawerId = this.state.turnOrder[this.state.currentTurnIndex] ?? '';

    if (drawerId.startsWith('dev-bot-')) {
      // Dev bots never connect so they never send draw_start — auto-start the timer for them.
      this.state.drawingActive = true;
      this.state.turnEndTime = Date.now() + this.state.turnDuration;
      await this.persistState();
      const expectedIndex = this.state.currentTurnIndex;
      this.turnTimer = setTimeout(() => {
        this.advanceTurn(expectedIndex).catch(console.error);
      }, this.state.turnDuration);
    }
    // classic + draw mode: timer stays paused until the first draw_start message.

    this.broadcast({
      type: 'turn_started',
      drawerId,
      turnIndex: this.state.currentTurnIndex,
      round: this.state.currentRound,
      totalRounds: this.state.totalRounds,
      turnDuration: this.state.turnDuration,
      timeLeft: this.state.turnDuration,
    });
  }

  private async advanceTurn(expectedIndex?: number) {
    // Idempotency guard: bail out if the turn has already been advanced by a
    // concurrent code path (e.g. skip_turn message racing with the turnTimer).
    if (expectedIndex !== undefined && this.state.currentTurnIndex !== expectedIndex) return;
    this.state.currentTurnIndex++;

    if (this.state.currentTurnIndex >= this.state.turnOrder.length) {
      this.state.currentTurnIndex = 0;
      this.state.currentRound++;

      if (this.state.currentRound > this.state.totalRounds) {
        this.state.gameStarted = false;
        this.state.gameOver = true;
        this.state.turnEndTime = 0;
        if (this.turnTimer) clearTimeout(this.turnTimer);
        this.turnTimer = null;
        await this.persistState();
        this.broadcast({ type: 'game_over' });
        return;
      }
    }

    await this.persistState();
    await this.startPrepPhase();
  }

  /**
   * Enter the imposter-guess phase. Called after voting identifies the imposter
   * (artistsWin=true) — gives the imposter 30 s to guess the word and reverse the outcome.
   * `this.state.originalResults` must be set by the caller before invoking this.
   */
  private async startGuessPhase() {
    if (this.guessTimer) clearTimeout(this.guessTimer);

    this.state.inGuessPhase = true;
    this.state.guessDeadline = Date.now() + MAX_GUESS_WAIT_MS;
    await this.persistState();

    this.broadcast({ type: 'imposter_guess_phase', deadline: this.state.guessDeadline });

    this.guessTimer = setTimeout(async () => {
      await this.endGuessPhase();
    }, MAX_GUESS_WAIT_MS);
  }

  /**
   * End the guess phase.
   * If the guess was correct — broadcast voting_complete with artistsWin flipped to false
   * and guessedWord set (imposter wins).
   * If wrong or timeout — broadcast voting_complete with the original artistsWin=true
   * results, attaching wrongGuess so the results screen can display what the imposter tried.
   */
  private async endGuessPhase(guessedWord?: string, correct?: boolean) {
    if (this.guessTimer) clearTimeout(this.guessTimer);
    this.guessTimer = null;

    this.state.inGuessPhase = false;
    await this.persistState();

    const originalResults = this.state.originalResults;
    if (!originalResults) return;

    if (correct && guessedWord !== undefined) {
      const results: VotingResults = { ...originalResults, artistsWin: false, guessedWord };
      this.broadcast({ type: 'voting_complete', results });
    } else {
      const results: VotingResults = guessedWord !== undefined
        ? { ...originalResults, wrongGuess: guessedWord }
        : originalResults;
      this.broadcast({ type: 'voting_complete', results });
    }
  }

  /**
   * Restart whichever timer is appropriate after a hot-reload / server restart.
   *
   * IMPORTANT: always go through setTimeout (even with delay 0) rather than
   * calling advanceTurn/startTurn directly. This ensures this.turnTimer /
   * this.prepTimer is set synchronously before any other concurrent onConnect
   * handler runs, so the guard at the top of each branch fires correctly and
   * we never double-advance the turn index.
   */
  private restartTimersAfterRestore() {
    if (this.state.inGuessPhase) {
      if (this.guessTimer) return;
      const remaining = Math.max(0, this.state.guessDeadline - Date.now());
      this.guessTimer = setTimeout(async () => {
        await this.endGuessPhase();
      }, remaining);
      return;
    }
    if (this.state.inRevealPhase) {
      if (this.revealTimer) return;
      const remaining = Math.max(0, this.state.revealDeadline - Date.now());
      this.revealTimer = setTimeout(async () => {
        this.state.inRevealPhase = false;
        await this.persistState();
        await this.startPrepPhase();
      }, remaining);
      return;
    }
    if (this.state.inPrepPhase) {
      if (this.prepTimer) return; // already running
      const remaining = Math.max(0, this.state.prepDeadline - Date.now());
      this.prepTimer = setTimeout(() => {
        this.startTurn().catch(console.error);
      }, remaining);
    } else {
      if (this.turnTimer) return; // already running
      // turnEndTime === 0 means startTurn hasn't run yet (game_started just
      // fired but the first startTurn hasn't persisted yet).  Nothing to restore.
      if (this.state.turnEndTime === 0) return;
      const remaining = Math.max(0, this.state.turnEndTime - Date.now());
      const expectedIndex = this.state.currentTurnIndex;
      this.turnTimer = setTimeout(() => {
        this.advanceTurn(expectedIndex).catch(console.error);
      }, remaining);
    }
  }

  // ── PartyKit lifecycle ────────────────────────────────────────────────────

  async onConnect(connection: Party.Connection, ctx: Party.ConnectionContext) {
    const url = new URL(ctx.request.url);
    const playerId = url.searchParams.get('playerId') ?? connection.id;
    const playerName = url.searchParams.get('playerName') ?? 'Unknown';
    connection.setState({ playerId, playerName } satisfies ConnectionState);

    // Restore persisted state if in-memory state is blank (after hot-reload).
    await this.ensureState();

    if (this.state.inGuessPhase) {
      // Imposter guess phase — reconnecting player gets the deadline so the
      // countdown and UI are immediately in sync.
      this.restartTimersAfterRestore();
      this.send(connection, {
        type: 'imposter_guess_phase',
        deadline: this.state.guessDeadline,
      });
    } else if (this.state.gameOver) {
      // All rounds complete — player is reconnecting during voting/results.
      // Send game_over so the client transitions out of the reveal screen.
      this.send(connection, { type: 'game_over' });
    } else if (!this.state.gameStarted) {
      // Lobby: announce presence, but only if this is a genuinely new connection.
      // If a pending disconnect timer exists the player is reconnecting after a
      // brief drop — cancel the timer (Redis stays intact) and skip the
      // player_joined broadcast so no spurious chime/toast fires for others.
      const pendingTimer = this.lobbyDisconnectTimers.get(playerId);
      // Check if this player already has an older connection still open
      // (e.g. their game WS hasn't closed yet but the new lobby WS just opened).
      // In that case suppress player_joined — onClose will also skip player_left
      // once the old WS eventually closes.
      let alreadyConnected = false;
      for (const conn of this.room.getConnections()) {
        if (conn.id !== connection.id) {
          const otherCs = conn.state as ConnectionState | null;
          if (otherCs?.playerId === playerId) {
            alreadyConnected = true;
            break;
          }
        }
      }
      if (pendingTimer) {
        clearTimeout(pendingTimer);
        this.lobbyDisconnectTimers.delete(playerId);
      } else if (!alreadyConnected) {
        const player: Player = { id: playerId, name: playerName };
        this.broadcast({ type: 'player_joined', player }, connection.id);
      }
      // Build the authoritative player list from live connections and broadcast
      // to ALL clients (not just the connecting one). This is critical after a
      // game_reset: every reconnecting player skips player_joined (reconnect
      // path above), so without a broadcast here the host would never learn
      // about non-hosts who reconnect after themselves.
      // Deduplicate by playerId in case old and new WS connections briefly overlap.
      const seenIds = new Set<string>();
      const syncPlayers: Player[] = [];
      for (const conn of this.room.getConnections()) {
        const cs = conn.state as ConnectionState | null;
        if (cs?.playerId && !seenIds.has(cs.playerId)) {
          seenIds.add(cs.playerId);
          syncPlayers.push({ id: cs.playerId, name: cs.playerName });
        }
      }
      this.room.broadcast(
        JSON.stringify({ type: 'lobby_sync', players: syncPlayers } satisfies ServerMessage),
      );
    } else {
      // Game in progress: restart whichever timer was lost, then send catch-up.
      this.restartTimersAfterRestore();

      if (this.state.inRevealPhase) {
        // Player reconnected during the reveal window — send current progress
        // so their waiting screen shows the right count.
        this.send(connection, {
          type: 'reveal_progress',
          readyCount: this.state.revealAcknowledgedIds.length,
          totalPlayers: this.state.turnOrder.length,
          deadline: this.state.revealDeadline,
        });
      } else if (this.state.inPrepPhase) {
        // Send accumulated canvas history — the canvas persists across all turns,
        // so a late joiner needs it even during the prep window.
        if (this.canvasHistory.length > 0) {
          this.send(connection, { type: 'canvas_history', events: this.canvasHistory });
        }
        // Player reconnected during the prep window — resend the announcement.
        this.send(connection, {
          type: 'turn_prep',
          drawerId: this.state.turnOrder[this.state.currentTurnIndex] ?? '',
          turnIndex: this.state.currentTurnIndex,
          round: this.state.currentRound,
          totalRounds: this.state.totalRounds,
        });
      } else {
        // Player reconnected mid-turn — send canvas state then current turn info.
        if (this.canvasHistory.length > 0) {
          this.send(connection, { type: 'canvas_history', events: this.canvasHistory });
        }
        // If drawing hasn't started yet the full duration is the correct timeLeft.
        const timeLeft = this.state.drawingActive
          ? Math.max(0, this.state.turnEndTime - Date.now())
          : this.state.remainingMs;
        this.send(connection, {
          type: 'turn_started',
          drawerId: this.state.turnOrder[this.state.currentTurnIndex] ?? '',
          turnIndex: this.state.currentTurnIndex,
          round: this.state.currentRound,
          totalRounds: this.state.totalRounds,
          turnDuration: this.state.turnDuration,
          timeLeft,
        });
        // If the timer is running, tell the reconnecting client to start counting.
        if (this.state.drawingActive && this.state.turnEndTime > 0) {
          this.send(connection, {
            type: 'timer_update',
            turnEndTime: this.state.turnEndTime,
            remainingMs: this.state.remainingMs,
            paused: false,
          });
        }
      }
    }

    console.log(`[${this.room.id}] connect: ${playerName} (${playerId})`);
  }

  async onMessage(
    message: string | ArrayBuffer | ArrayBufferView,
    sender: Party.Connection,
  ) {
    if (typeof message !== 'string') return;

    let msg: ClientMessage;
    try {
      msg = JSON.parse(message) as ClientMessage;
    } catch {
      return;
    }

    if (msg.type === 'ping') {
      sender.send('{"type":"pong"}');
      return;
    }

    if (msg.type === 'draw') {
      const cs = sender.state as ConnectionState | null;
      const drawerId = cs?.playerId ?? sender.id;
      const event: BroadcastedDrawEvent = { ...msg.event, drawerId };
      if (this.canvasHistory.length < 5000) this.canvasHistory.push(event);
      this.broadcast({ type: 'draw', event }, sender.id);
      return;
    }

    if (msg.type === 'draw_start' || msg.type === 'draw_pause') {
      await this.ensureState();
      // draw_pause only applies in draw mode (classic timer never pauses once started).
      if (msg.type === 'draw_pause' && this.state.timerMode !== 'draw') return;
      // draw_start applies to both classic and draw modes.
      if (this.state.timerMode !== 'classic' && this.state.timerMode !== 'draw') return;
      const cs = sender.state as ConnectionState | null;
      const senderId = cs?.playerId ?? sender.id;
      const currentDrawer = this.state.turnOrder[this.state.currentTurnIndex];
      if (senderId !== currentDrawer || !this.state.gameStarted || this.state.inPrepPhase) return;

      if (msg.type === 'draw_start' && !this.state.drawingActive) {
        // Resume: arm the timer with however many ms are left.
        this.state.drawingActive = true;
        this.state.turnEndTime = Date.now() + this.state.remainingMs;
        const expectedIndex = this.state.currentTurnIndex;
        this.turnTimer = setTimeout(() => {
          this.advanceTurn(expectedIndex).catch(console.error);
        }, this.state.remainingMs);
        this.broadcast({
          type: 'timer_update',
          turnEndTime: this.state.turnEndTime,
          remainingMs: this.state.remainingMs,
          paused: false,
        });
        await this.persistState();
      }

      if (msg.type === 'draw_pause' && this.state.drawingActive) {
        // Pause: snapshot remaining time and stop the timer.
        this.state.remainingMs = Math.max(0, this.state.turnEndTime - Date.now());
        this.state.drawingActive = false;
        this.state.turnEndTime = 0;
        if (this.turnTimer) clearTimeout(this.turnTimer);
        this.turnTimer = null;
        this.broadcast({
          type: 'timer_update',
          turnEndTime: 0,
          remainingMs: this.state.remainingMs,
          paused: true,
        });
        await this.persistState();
      }
      return;
    }

    if (msg.type === 'skip_turn') {
      await this.ensureState();
      const cs = sender.state as ConnectionState | null;
      const senderId = cs?.playerId ?? sender.id;
      const currentDrawer = this.state.turnOrder[this.state.currentTurnIndex];
      if (senderId === currentDrawer) {
        if (this.turnTimer) clearTimeout(this.turnTimer);
        this.turnTimer = null;
        await this.advanceTurn(this.state.currentTurnIndex);
      }
      return;
    }

    if (msg.type === 'dev_skip_bot_turn') {
      await this.ensureState();
      const currentDrawer = this.state.turnOrder[this.state.currentTurnIndex] ?? '';
      // Safety guard: only allow skipping when the current drawer is a dev bot.
      if (!currentDrawer.startsWith('dev-bot-')) return;
      if (this.turnTimer) clearTimeout(this.turnTimer);
      this.turnTimer = null;
      await this.advanceTurn(this.state.currentTurnIndex);
      return;
    }

    if (msg.type === 'player_ready') {
      await this.ensureState();
      const cs = sender.state as ConnectionState | null;
      const senderId = cs?.playerId ?? sender.id;
      const currentDrawer = this.state.turnOrder[this.state.currentTurnIndex];
      // Only the current drawer can trigger the turn start from the prep phase.
      if (senderId === currentDrawer && this.state.inPrepPhase) {
        if (this.prepTimer) clearTimeout(this.prepTimer);
        this.prepTimer = null;
        await this.startTurn();
      }
      return;
    }

    if (msg.type === 'reveal_acknowledged') {
      await this.ensureState();
      if (!this.state.inRevealPhase) return;

      const cs = sender.state as ConnectionState | null;
      const senderId = cs?.playerId ?? sender.id;

      // Deduplicate — ignore if player already acknowledged.
      if (this.state.revealAcknowledgedIds.includes(senderId)) return;
      this.state.revealAcknowledgedIds.push(senderId);
      await this.persistState();

      const readyCount = this.state.revealAcknowledgedIds.length;
      const totalPlayers = this.state.turnOrder.length;
      this.broadcast({ type: 'reveal_progress', readyCount, totalPlayers, deadline: this.state.revealDeadline });

      // Check if all currently-connected players have acknowledged.
      // Disconnected players are skipped so they don't block the game.
      await this.advanceRevealIfReady();
      return;
    }
  }

  async onClose(connection: Party.Connection) {
    const cs = connection.state as ConnectionState | null;
    if (!cs) return;

    // Ensure state is loaded — onClose can fire after a hot-reload where the
    // in-memory state is blank, causing incorrect gameStarted=false reads.
    await this.ensureState();

    if (!this.state.gameStarted && !this.state.inGuessPhase) {
      const playerId = cs.playerId;
      const existing = this.lobbyDisconnectTimers.get(playerId);
      if (existing) clearTimeout(existing);

      // Defer the departure notification so that a page-refresh (or any brief
      // reconnect) has time to open a new WebSocket and cancel this timer
      // before player_left is ever sent. Broadcasting player_left immediately
      // and then correcting with lobby_sync creates an unavoidable race where
      // the correction arrives before the removal, leaving the player
      // permanently invisible on some clients.
      const timer = setTimeout(async () => {
        this.lobbyDisconnectTimers.delete(playerId);
        // Skip if the player already reconnected on a new WebSocket.
        let stillConnected = false;
        for (const conn of this.room.getConnections()) {
          const connState = conn.state as ConnectionState | null;
          if (connState?.playerId === playerId) {
            stillConnected = true;
            break;
          }
        }
        if (!stillConnected) {
          this.broadcast({ type: 'player_left', playerId });
          await removePlayerFromRoom(this.room.id, playerId);
        }
      }, 3_000);
      this.lobbyDisconnectTimers.set(playerId, timer);
    }

    // A disconnect during the reveal phase might unblock the remaining
    // connected players (they may all have already acknowledged).
    if (this.state.inRevealPhase) {
      await this.advanceRevealIfReady();
    }
    console.log(`[${this.room.id}] disconnect: ${cs.playerName} (${cs.playerId})`);
  }

  async onError(connection: Party.Connection, error: Error) {
    console.error(`[${this.room.id}] error:`, error.message);
    await this.onClose(connection);
  }

  async onRequest(req: Party.Request) {
    if (req.method !== 'POST') return new Response('not found', { status: 404 });

    const body = await req.json() as {
      action?: string;
      turnOrder?: string[];
      totalRounds?: number;
      turnDuration?: number;
      timerMode?: 'classic' | 'draw';
      votedCount?: number;
      totalPlayers?: number;
      results?: VotingResults;
      guessedWord?: string;
      correct?: boolean;
      targetPlayerId?: string;
    };

    if (body.action === 'game_started') {
      this.state = {
        gameStarted: true,
        gameOver: false,
        inRevealPhase: false,
        revealDeadline: 0,
        revealAcknowledgedIds: [],
        inPrepPhase: false,
        prepDeadline: 0,
        turnOrder: body.turnOrder ?? [],
        totalRounds: body.totalRounds ?? 3,
        turnDuration: body.turnDuration ?? DEFAULT_TURN_DURATION_MS,
        timerMode: body.timerMode === 'draw' ? 'draw' : 'classic',
        currentTurnIndex: 0,
        currentRound: 1,
        turnEndTime: 0,
        drawingActive: false,
        remainingMs: body.turnDuration ?? DEFAULT_TURN_DURATION_MS,
        inGuessPhase: false,
        guessDeadline: 0,
      };
      this.stateLoaded = true;
      this.canvasHistory = [];
      await this.persistState();

      this.broadcast({ type: 'game_started' });
      // Wait for all players to acknowledge the reveal screen before starting
      // the first prep phase, so no one misses a turn while still reading their role.
      await this.startRevealPhase();
      return new Response('ok');
    }

    if (body.action === 'vote_cast') {
      this.broadcast({
        type: 'vote_cast',
        votedCount: body.votedCount ?? 0,
        totalPlayers: body.totalPlayers ?? 0,
      });
      return new Response('ok');
    }

    if (body.action === 'voting_complete' && body.results) {
      this.broadcast({ type: 'voting_complete', results: body.results });
      return new Response('ok');
    }

    if (body.action === 'start_guess_phase' && body.results) {
      // Vote identified the imposter — give them a chance to guess the word.
      // Guard: only enter guess phase if we're in the gameOver state (just finished voting).
      if (this.state.gameOver && !this.state.inGuessPhase) {
        this.state.originalResults = body.results;
        await this.startGuessPhase();
      }
      return new Response('ok');
    }

    if (body.action === 'guess_result') {
      // Guard: ignore if the guess phase already ended (e.g. timer fired first).
      if (this.state.inGuessPhase) {
        await this.endGuessPhase(body.guessedWord, body.correct === true);
      }
      return new Response('ok');
    }

    if (body.action === 'game_reset') {
      // Clear all game state so the room is back to lobby.
      if (this.turnTimer) clearTimeout(this.turnTimer);
      if (this.prepTimer) clearTimeout(this.prepTimer);
      if (this.revealTimer) clearTimeout(this.revealTimer);
      if (this.guessTimer) clearTimeout(this.guessTimer);
      this.turnTimer = null;
      this.prepTimer = null;
      this.revealTimer = null;
      this.guessTimer = null;
      this.state = { ...EMPTY_STATE };
      this.stateLoaded = true;
      this.canvasHistory = [];
      await this.persistState();
      this.broadcast({ type: 'game_reset' });
      return new Response('ok');
    }

    if (body.action === 'player_kicked' && body.targetPlayerId) {
      const targetPlayerId = body.targetPlayerId;
      // Broadcast to all clients first so the kicked player's UI can react.
      this.broadcast({ type: 'player_kicked', playerId: targetPlayerId });
      // Close the kicked player's WebSocket connection if still open.
      for (const conn of this.room.getConnections()) {
        const cs = conn.state as ConnectionState | null;
        if (cs?.playerId === targetPlayerId) {
          conn.close(4001, 'kicked');
          break;
        }
      }
      return new Response('ok');
    }

    return new Response('not found', { status: 404 });
  }
}

export type { GameRoom };
