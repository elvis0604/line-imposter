import { getRedis, ROOM_TTL_SECONDS } from './redis';
import type { Player, Room } from './types';

// ─── Key helpers ──────────────────────────────────────────────────────────────

export function roomKey(code: string) {
  return `room:${code.toUpperCase()}`;
}

// ─── CRUD ─────────────────────────────────────────────────────────────────────

export async function getRoom(code: string): Promise<Room | null> {
  return getRedis().get<Room>(roomKey(code));
}

export async function saveRoom(room: Room): Promise<void> {
  await getRedis().set(roomKey(room.code), room, { ex: ROOM_TTL_SECONDS });
}

export async function addPlayerToRoom(code: string, player: Player): Promise<Room | null> {
  const room = await getRoom(code);
  if (!room) return null;

  // Deduplicate: if player already in room, just refresh TTL
  const already = room.players.some((p) => p.id === player.id);
  if (!already) {
    room.players.push(player);
  }
  await saveRoom(room);
  return room;
}

export async function removePlayerFromRoom(code: string, targetPlayerId: string): Promise<Room | null> {
  const room = await getRoom(code);
  if (!room) return null;

  room.players = room.players.filter((p) => p.id !== targetPlayerId);
  await saveRoom(room);
  return room;
}

// ─── Code generation ──────────────────────────────────────────────────────────

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function generateRoomCode(): string {
  return Array.from(
    { length: 4 },
    () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)],
  ).join('');
}

/** Shuffle an array in-place (Fisher-Yates). */
function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ─── Defaults ─────────────────────────────────────────────────────────────────

export const DEFAULT_TOTAL_ROUNDS = 3;
export const DEFAULT_TURN_DURATION = 5_000; // ms
export const DEFAULT_TIMER_MODE: 'classic' | 'draw' = 'classic';
export const DEFAULT_IMPOSTER_GUESS = false;

// ─── Start ────────────────────────────────────────────────────────────────────

export interface StartRoomOptions {
  word: string;
  imposterId: string;
  /** Config values to persist on the room (from host's lobby settings). */
  totalRounds: number;
  turnDuration: number;
  timerMode: 'classic' | 'draw';
  imposterGuess: boolean;
  category: string | null;
}

/** Transition a room from lobby → playing. Mutates and saves the room. */
export async function startRoom(code: string, opts: StartRoomOptions): Promise<Room | null> {
  const room = await getRoom(code);
  if (!room || room.status !== 'lobby') return null;

  room.status = 'playing';
  room.word = opts.word;
  room.imposterId = opts.imposterId;
  room.totalRounds = opts.totalRounds;
  room.turnDuration = opts.turnDuration;
  room.timerMode = opts.timerMode;
  room.imposterGuess = opts.imposterGuess;
  room.category = opts.category;
  room.turnOrder = shuffle(room.players.map((p) => p.id));
  room.currentTurnIndex = 0;
  room.currentRound = 1;

  await saveRoom(room);

  // Clear any vote data left over from a previous game in this room.
  const redis = getRedis();
  await redis.del(`votes:${code}`, `vote_count:${code}`);

  return room;
}

// ─── Reset (play again) ───────────────────────────────────────────────────────

/**
 * Reset a room back to lobby state for a rematch.
 * Keeps the player list and config (totalRounds, turnDuration, category).
 */
export async function resetRoom(code: string): Promise<Room | null> {
  const room = await getRoom(code);
  if (!room) return null;

  room.status = 'lobby';
  room.word = null;
  room.imposterId = null;
  room.turnOrder = [];
  room.currentTurnIndex = 0;
  room.currentRound = 0;
  room.votes = {};
  // Config (totalRounds, turnDuration, timerMode, category) and players are preserved.

  await saveRoom(room);

  // Clear atomic vote keys for the finished game.
  const redis = getRedis();
  await redis.del(`votes:${code}`, `vote_count:${code}`);

  return room;
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export function createRoomObject(code: string, host: Player): Room {
  return {
    code,
    hostId: host.id,
    players: [host],
    status: 'lobby',
    // Config defaults — host can change these in the lobby before starting:
    totalRounds: DEFAULT_TOTAL_ROUNDS,
    turnDuration: DEFAULT_TURN_DURATION,
    timerMode: DEFAULT_TIMER_MODE,
    imposterGuess: DEFAULT_IMPOSTER_GUESS,
    category: null,
    word: null,
    imposterId: null,
    turnOrder: [],
    currentTurnIndex: 0,
    currentRound: 0,
    votes: {},
    createdAt: Date.now(),
  };
}
