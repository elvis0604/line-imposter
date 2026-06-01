import { cookies } from 'next/headers';
import { addPlayerToRoom, getRoom } from '@/lib/room';
import { PLAYER_ID_COOKIE, PLAYER_NAME_COOKIE } from '@/lib/identity';

// POST /api/rooms/[code]/join — join an existing room
export async function POST(request: Request, ctx: RouteContext<'/api/rooms/[code]/join'>) {
  const { code } = await ctx.params;

  const body = await request.json().catch(() => null);
  if (!body || typeof body.playerName !== 'string' || typeof body.playerId !== 'string') {
    return Response.json({ error: 'playerName and playerId are required' }, { status: 400 });
  }

  const playerName = body.playerName.trim().slice(0, 20);
  const playerId = body.playerId.trim();
  if (!playerName || !playerId) {
    return Response.json({ error: 'playerName and playerId must not be empty' }, { status: 400 });
  }

  const room = await getRoom(code);
  if (!room) {
    return Response.json({ error: 'Room not found' }, { status: 404 });
  }

  const jar = await cookies();
  const cookieOpts = { path: '/', maxAge: 60 * 60 * 24 * 7, sameSite: 'lax' } as const;

  const isReturningPlayer = room.players.some((p) => p.id === playerId);

  if (room.status !== 'lobby' && !isReturningPlayer) {
    // Game in progress and this is a new visitor — give them an identity cookie
    // so they have a persistent ID, then let the navigation chain send them to
    // /room/CODE/game where they'll land as a silent observer.
    jar.set(PLAYER_ID_COOKIE,   playerId,   cookieOpts);
    jar.set(PLAYER_NAME_COOKIE, playerName, cookieOpts);
    return Response.json({ ok: true });
  }

  // Lobby join OR returning player — add to room (idempotent for returning players).
  await addPlayerToRoom(code, { id: playerId, name: playerName });

  jar.set(PLAYER_ID_COOKIE,   playerId,   cookieOpts);
  jar.set(PLAYER_NAME_COOKIE, playerName, cookieOpts);

  return Response.json({ ok: true });
}
