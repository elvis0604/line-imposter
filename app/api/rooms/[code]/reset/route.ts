import { cookies } from 'next/headers';
import { getRoom, resetRoom } from '@/lib/room';
import { PLAYER_ID_COOKIE } from '@/lib/identity';

// POST /api/rooms/[code]/reset — host-only, resets the room back to lobby for a rematch
export async function POST(_req: Request, ctx: { params: Promise<{ code: string }> }) {
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
    return Response.json({ error: 'Only the host can restart the game' }, { status: 403 });
  }

  await resetRoom(code);

  // Notify PartyKit so it clears game state and broadcasts game_reset to all clients.
  const protocol = process.env.NODE_ENV === 'development' ? 'http' : 'https';
  const partyUrl = `${protocol}://${process.env.NEXT_PUBLIC_PARTYKIT_HOST}/parties/main/${code}`;

  try {
    await fetch(partyUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'game_reset' }),
    });
  } catch {
    console.warn('[reset] could not reach PartyKit:', partyUrl);
  }

  return Response.json({ ok: true });
}
