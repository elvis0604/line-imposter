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
  if (room.status !== 'lobby') {
    return Response.json({ error: 'Game already in progress' }, { status: 409 });
  }

  await addPlayerToRoom(code, { id: playerId, name: playerName });

  // Persist identity cookies
  const jar = await cookies();
  jar.set(PLAYER_ID_COOKIE, playerId, { path: '/', maxAge: 60 * 60 * 24 * 7, sameSite: 'lax' });
  jar.set(PLAYER_NAME_COOKIE, playerName, { path: '/', maxAge: 60 * 60 * 24 * 7, sameSite: 'lax' });

  return Response.json({ ok: true });
}
