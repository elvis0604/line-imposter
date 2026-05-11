import type * as Party from 'partykit/server';
import type {
  BroadcastedDrawEvent,
  ClientMessage,
  Player,
  ServerMessage,
  VotingResults,
} from '../lib/types';

const DEFAULT_TURN_DURATION_MS = 5_000;
/** Max time to wait for the drawer to click Ready before auto-starting the turn. */
const MAX_PREP_WAIT_MS = 30_000;
/** Max time to wait for all players to acknowledge the reveal before auto-starting. */
const MAX_REVEAL_WAIT_MS = 30_000;

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
  /** Epoch ms when the current turn expires. 0 = turn not yet started. */
  turnEndTime: number;
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
  turnEndTime: 0,
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
  private canvasHistory: BroadcastedDrawEvent[] = [];

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
    this.state.turnEndTime = Date.now() + this.state.turnDuration;
    // Do NOT reset canvasHistory here — the canvas persists across turns.
    await this.persistState();

    const drawerId = this.state.turnOrder[this.state.currentTurnIndex] ?? '';
    this.broadcast({
      type: 'turn_started',
      drawerId,
      turnIndex: this.state.currentTurnIndex,
      round: this.state.currentRound,
      totalRounds: this.state.totalRounds,
      turnDuration: this.state.turnDuration,
      timeLeft: this.state.turnDuration,
    });

    const expectedIndex = this.state.currentTurnIndex;
    this.turnTimer = setTimeout(() => {
      this.advanceTurn(expectedIndex).catch(console.error);
    }, this.state.turnDuration);
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
   * Restart whichever timer is appropriate after a hot-reload / server restart.
   * Called once per onConnect when the in-memory timers are gone.
   *
   * IMPORTANT: always go through setTimeout (even with delay 0) rather than
   * calling advanceTurn/startTurn directly. This ensures this.turnTimer /
   * this.prepTimer is set synchronously before any other concurrent onConnect
   * handler runs, so the guard at the top of each branch fires correctly and
   * we never double-advance the turn index.
   */
  private restartTimersAfterRestore() {
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

    if (this.state.gameOver) {
      // All rounds complete — player is reconnecting during voting/results.
      // Send game_over so the client transitions out of the reveal screen.
      this.send(connection, { type: 'game_over' });
    } else if (!this.state.gameStarted) {
      // Lobby: announce presence
      const player: Player = { id: playerId, name: playerName };
      this.broadcast({ type: 'player_joined', player }, connection.id);
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
        const timeLeft = Math.max(0, this.state.turnEndTime - Date.now());
        this.send(connection, {
          type: 'turn_started',
          drawerId: this.state.turnOrder[this.state.currentTurnIndex] ?? '',
          turnIndex: this.state.currentTurnIndex,
          round: this.state.currentRound,
          totalRounds: this.state.totalRounds,
          turnDuration: this.state.turnDuration,
          timeLeft,
        });
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
    if (!this.state.gameStarted) {
      this.broadcast({ type: 'player_left', playerId: cs.playerId });
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
      votedCount?: number;
      totalPlayers?: number;
      results?: VotingResults;
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
        currentTurnIndex: 0,
        currentRound: 1,
        turnEndTime: 0,
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

    if (body.action === 'game_reset') {
      // Clear all game state so the room is back to lobby.
      if (this.turnTimer) clearTimeout(this.turnTimer);
      if (this.prepTimer) clearTimeout(this.prepTimer);
      if (this.revealTimer) clearTimeout(this.revealTimer);
      this.turnTimer = null;
      this.prepTimer = null;
      this.revealTimer = null;
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
