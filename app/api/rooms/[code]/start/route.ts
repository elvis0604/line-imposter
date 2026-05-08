import { cookies } from 'next/headers';
import { getRoom, startRoom } from '@/lib/room';
import { PLAYER_ID_COOKIE } from '@/lib/identity';
import { pickRandomWord } from '@/lib/words';

// POST /api/rooms/[code]/start — host-only, transitions lobby → playing
export async function POST(_req: Request, ctx: RouteContext<'/api/rooms/[code]/start'>) {
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

  // Pick word and imposter
  const { word } = pickRandomWord();
  const imposterIndex = Math.floor(Math.random() * room.players.length);
  const imposterId = room.players[imposterIndex].id;

  const updatedRoom = await startRoom(code, { word, imposterId });

  // Ping PartyKit so it stores turn state and broadcasts game_started + turn_started
  const protocol = process.env.NODE_ENV === 'development' ? 'http' : 'https';
  const partyUrl = `${protocol}://${process.env.NEXT_PUBLIC_PARTYKIT_HOST}/parties/main/${code}`;

  try {
    await fetch(partyUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'game_started',
        turnOrder: updatedRoom?.turnOrder ?? [],
        totalRounds: updatedRoom?.totalRounds ?? 3,
      }),
    });
  } catch {
    // PartyKit might not be running in CI/test — not fatal
    console.warn('[start] could not reach PartyKit:', partyUrl);
  }

  return Response.json({ ok: true });
}
