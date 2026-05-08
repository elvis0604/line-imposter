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

export interface StartRoomOptions {
  word: string;
  imposterId: string;
}

/** Transition a room from lobby → playing. Mutates and saves the room. */
export async function startRoom(code: string, opts: StartRoomOptions): Promise<Room | null> {
  const room = await getRoom(code);
  if (!room || room.status !== 'lobby') return null;

  room.status = 'playing';
  room.word = opts.word;
  room.imposterId = opts.imposterId;
  room.turnOrder = shuffle(room.players.map((p) => p.id));
  room.currentTurnIndex = 0;
  room.currentRound = 1;

  await saveRoom(room);
  return room;
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export function createRoomObject(code: string, host: Player, totalRounds = 3): Room {
  return {
    code,
    hostId: host.id,
    players: [host],
    status: 'lobby',
    word: null,
    imposterId: null,
    turnOrder: [],
    currentTurnIndex: 0,
    currentRound: 0,
    totalRounds,
    votes: {},
    createdAt: Date.now(),
  };
}
