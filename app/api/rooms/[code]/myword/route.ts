import { cookies } from 'next/headers';
import { getRoom } from '@/lib/room';
import { PLAYER_ID_COOKIE } from '@/lib/identity';

// GET /api/rooms/[code]/myword — returns this player's word (or null if imposter)
export async function GET(_req: Request, ctx: RouteContext<'/api/rooms/[code]/myword'>) {
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
  if (room.status === 'lobby') {
    return Response.json({ error: 'Game not started yet' }, { status: 409 });
  }

  const isImposter = room.imposterId === playerId;

  return Response.json({
    isImposter,
    word: isImposter ? null : room.word,
  });
}
