import { cookies } from 'next/headers';
import { getRoom, startRoom, DEFAULT_TOTAL_ROUNDS, DEFAULT_TURN_DURATION, DEFAULT_TIMER_MODE, DEFAULT_IMPOSTER_GUESS } from '@/lib/room';
import { PLAYER_ID_COOKIE } from '@/lib/identity';
import { pickRandomWord } from '@/lib/words';

// POST /api/rooms/[code]/start — host-only, transitions lobby → playing
export async function POST(req: Request, ctx: RouteContext<'/api/rooms/[code]/start'>) {
  const { code } = await ctx.params;

  const jar = await cookies();
  const playerId = jar.get(PLAYER_ID_COOKIE)?.value;
  if (!playerId) {
    return Response.json({ error: 'Not identified' }, { status: 401 });
  }

  const room = await getRoom(code);
  if (!room) {
    return Response.json({ error: 'Room not found' }, { status: 404 });
  }
  if (room.hostId !== playerId) {
    return Response.json({ error: 'Only the host can start the game' }, { status: 403 });
  }
  if (room.status !== 'lobby') {
    return Response.json({ error: 'Game already started' }, { status: 409 });
  }
  if (room.players.length < 3) {
    return Response.json({ error: 'Need at least 3 players' }, { status: 422 });
  }

  // Read config from request body (host's lobby settings), falling back to room defaults.
  const body = await req.json().catch(() => ({})) as {
    totalRounds?: number;
    turnDuration?: number;
    timerMode?: 'classic' | 'draw';
    imposterGuess?: boolean;
    category?: string | null;
  };

  const totalRounds = Math.min(10, Math.max(1, body.totalRounds ?? room.totalRounds ?? DEFAULT_TOTAL_ROUNDS));
  const turnDuration = Math.min(10_000, Math.max(3_000, body.turnDuration ?? room.turnDuration ?? DEFAULT_TURN_DURATION));
  const timerMode: 'classic' | 'draw' = body.timerMode === 'draw' ? 'draw' : (room.timerMode ?? DEFAULT_TIMER_MODE);
  const imposterGuess: boolean = body.imposterGuess ?? room.imposterGuess ?? DEFAULT_IMPOSTER_GUESS;
  const category = body.category ?? room.category ?? null;

  // Pick word (respecting chosen category) and randomly select imposter.
  const { word } = pickRandomWord(category);
  const imposterIndex = Math.floor(Math.random() * room.players.length);
  const imposterId = room.players[imposterIndex].id;

  const updatedRoom = await startRoom(code, { word, imposterId, totalRounds, turnDuration, timerMode, imposterGuess, category });

  // Ping PartyKit so it stores turn state and broadcasts game_started + turn_started.
  const protocol = process.env.NODE_ENV === 'development' ? 'http' : 'https';
  const partyUrl = `${protocol}://${process.env.NEXT_PUBLIC_PARTYKIT_HOST}/parties/main/${code}`;

  try {
    await fetch(partyUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'game_started',
        turnOrder: updatedRoom?.turnOrder ?? [],
        totalRounds,
        turnDuration,
        timerMode,
      }),
    });
  } catch {
    // PartyKit might not be running in CI/test — not fatal
    console.warn('[start] could not reach PartyKit:', partyUrl);
  }

  return Response.json({ ok: true });
}
