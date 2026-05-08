import { getRoom } from '@/lib/room';

// GET /api/rooms/[code] — fetch room state
export async function GET(_req: Request, ctx: RouteContext<'/api/rooms/[code]'>) {
  const { code } = await ctx.params;
  const room = await getRoom(code);
  if (!room) {
    return Response.json({ error: 'Room not found' }, { status: 404 });
  }
  return Response.json(room);
}
