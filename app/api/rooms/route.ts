import { cookies } from 'next/headers';
import { createRoomObject, generateRoomCode, getRoom, saveRoom } from '@/lib/room';
import { PLAYER_ID_COOKIE, PLAYER_NAME_COOKIE } from '@/lib/identity';

// POST /api/rooms — create a new room
export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  if (!body || typeof body.playerName !== 'string' || typeof body.playerId !== 'string') {
    return Response.json({ error: 'playerName and playerId are required' }, { status: 400 });
  }

  const playerName = body.playerName.trim().slice(0, 20);
  const playerId = body.playerId.trim();
  if (!playerName || !playerId) {
    return Response.json({ error: 'playerName and playerId must not be empty' }, { status: 400 });
  }

  // Generate a unique 4-char code (retry on collision)
  let code = generateRoomCode();
  for (let i = 0; i < 5; i++) {
    const existing = await getRoom(code);
    if (!existing) break;
    code = generateRoomCode();
  }

  const room = createRoomObject(code, { id: playerId, name: playerName });
  await saveRoom(room);

  // Persist identity in cookies for later server-side use (Phase 3+)
  const jar = await cookies();
  jar.set(PLAYER_ID_COOKIE, playerId, { path: '/', maxAge: 60 * 60 * 24 * 7, sameSite: 'lax' });
  jar.set(PLAYER_NAME_COOKIE, playerName, { path: '/', maxAge: 60 * 60 * 24 * 7, sameSite: 'lax' });

  return Response.json({ code }, { status: 201 });
}
