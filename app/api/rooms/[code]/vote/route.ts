import { cookies } from 'next/headers';
import { getRoom, saveRoom } from '@/lib/room';
import { PLAYER_ID_COOKIE } from '@/lib/identity';
import type { VotingResults } from '@/lib/types';

// POST /api/rooms/[code]/vote — cast a vote for the suspected imposter
export async function POST(req: Request, ctx: RouteContext<'/api/rooms/[code]/vote'>) {
  const { code } = await ctx.params;

  const jar = await cookies();
  const playerId = jar.get(PLAYER_ID_COOKIE)?.value;
  if (!playerId) {
    return Response.json({ error: 'Not identified' }, { status: 401 });
  }

  const body = await req.json() as { accusedId?: string };
  const accusedId = body.accusedId;
  if (!accusedId || typeof accusedId !== 'string') {
    return Response.json({ error: 'accusedId is required' }, { status: 400 });
  }

  const room = await getRoom(code);
  if (!room) {
    return Response.json({ error: 'Room not found' }, { status: 404 });
  }
  if (room.status !== 'playing' && room.status !== 'voting') {
    return Response.json({ error: 'Game is not in a votable state' }, { status: 409 });
  }

  // Must be a participant
  if (!room.players.some((p) => p.id === playerId)) {
    return Response.json({ error: 'Not a member of this room' }, { status: 403 });
  }

  // Accused must be a participant
  if (!room.players.some((p) => p.id === accusedId)) {
    return Response.json({ error: 'Invalid accusedId' }, { status: 422 });
  }

  // Cannot vote for yourself
  if (accusedId === playerId) {
    return Response.json({ error: 'Cannot vote for yourself' }, { status: 422 });
  }

  // Cannot change vote once cast
  if (room.votes[playerId] !== undefined) {
    return Response.json({ error: 'Already voted' }, { status: 409 });
  }

  // Record vote and transition status to voting
  room.votes[playerId] = accusedId;
  room.status = 'voting';
  await saveRoom(room);

  const votedCount = Object.keys(room.votes).length;
  const totalPlayers = room.players.length;

  const protocol = process.env.NODE_ENV === 'development' ? 'http' : 'https';
  const partyUrl = `${protocol}://${process.env.NEXT_PUBLIC_PARTYKIT_HOST}/parties/main/${code}`;

  if (votedCount >= totalPlayers) {
    // All votes in — compute results
    const tally: Record<string, number> = {};
    for (const accused of Object.values(room.votes)) {
      tally[accused] = (tally[accused] ?? 0) + 1;
    }

    // Find the highest vote count
    const maxVotes = Math.max(...Object.values(tally));
    // All players who received that many votes
    const topAccused = Object.entries(tally)
      .filter(([, v]) => v === maxVotes)
      .map(([id]) => id);

    // Artists win only if a single player leads the vote AND they are the imposter
    const artistsWin = topAccused.length === 1 && topAccused[0] === room.imposterId;

    const results: VotingResults = {
      tally,
      imposterId: room.imposterId ?? '',
      word: room.word ?? '',
      artistsWin,
    };

    room.status = 'results';
    await saveRoom(room);

    try {
      await fetch(partyUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'voting_complete', results }),
      });
    } catch {
      console.warn('[vote] could not reach PartyKit:', partyUrl);
    }
  } else {
    // Partial — just notify everyone of progress
    try {
      await fetch(partyUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'vote_cast', votedCount, totalPlayers }),
      });
    } catch {
      console.warn('[vote] could not reach PartyKit:', partyUrl);
    }
  }

  return Response.json({ ok: true, votedCount, totalPlayers });
}
