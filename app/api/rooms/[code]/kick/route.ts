import { cookies } from 'next/headers';
import { getRoom, removePlayerFromRoom } from '@/lib/room';
import { PLAYER_ID_COOKIE } from '@/lib/identity';

// POST /api/rooms/[code]/kick — host removes a player from the lobby
export async function POST(
  request: Request,
  props: { params: Promise<{ code: string }> },
) {
  const { code } = await props.params;
  const roomCode = code.toUpperCase();

  const jar = await cookies();
  const callerId = jar.get(PLAYER_ID_COOKIE)?.value ?? '';
  if (!callerId) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 });
  }

  const room = await getRoom(roomCode);
  if (!room) {
    return Response.json({ error: 'Room not found' }, { status: 404 });
  }
  if (room.status !== 'lobby') {
    return Response.json({ error: 'Game already started' }, { status: 409 });
  }
  if (room.hostId !== callerId) {
    return Response.json({ error: 'Only the host can kick players' }, { status: 403 });
  }

  const body = await request.json().catch(() => null);
  const targetPlayerId: string = body?.targetPlayerId ?? '';
  if (!targetPlayerId) {
    return Response.json({ error: 'targetPlayerId is required' }, { status: 400 });
  }
  if (targetPlayerId === callerId) {
    return Response.json({ error: 'Host cannot kick themselves' }, { status: 400 });
  }
  if (!room.players.some((p) => p.id === targetPlayerId)) {
    return Response.json({ error: 'Player not found in room' }, { status: 404 });
  }

  // Remove from Redis
  await removePlayerFromRoom(roomCode, targetPlayerId);

  // Ping PartyKit so it can broadcast and close the kicked connection
  const protocol = process.env.NODE_ENV === 'development' ? 'http' : 'https';
  const partyUrl = `${protocol}://${process.env.NEXT_PUBLIC_PARTYKIT_HOST}/parties/main/${roomCode}`;
  try {
    await fetch(partyUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'player_kicked', targetPlayerId }),
    });
  } catch {
    console.warn('[kick] could not reach PartyKit:', partyUrl);
  }

  return new Response(null, { status: 204 });
}
