import { cookies } from 'next/headers';
import { getRoom, saveRoom } from '@/lib/room';
import { getRedis, ROOM_TTL_SECONDS } from '@/lib/redis';
import { PLAYER_ID_COOKIE } from '@/lib/identity';
import type { VotingResults } from '@/lib/types';

// POST /api/rooms/[code]/vote — cast a vote for the suspected imposter
//
// Votes are stored in a dedicated Redis hash (votes:CODE) using HSETNX, which
// is atomic at the Redis level. This prevents the READ-MODIFY-WRITE race that
// occurs when two players vote at exactly the same time and one write
// overwrites the other. A separate INCR counter (vote_count:CODE) lets the
// final request detect that all votes are in, also atomically.
export async function POST(req: Request, ctx: RouteContext<'/api/rooms/[code]/vote'>) {
  const { code } = await ctx.params;
  const roomCode = code.toUpperCase();

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

  const room = await getRoom(roomCode);
  if (!room) {
    return Response.json({ error: 'Room not found' }, { status: 404 });
  }
  if (room.status !== 'playing' && room.status !== 'voting') {
    return Response.json({ error: 'Game is not in a votable state' }, { status: 409 });
  }
  if (!room.players.some((p) => p.id === playerId)) {
    return Response.json({ error: 'Not a member of this room' }, { status: 403 });
  }
  if (!room.players.some((p) => p.id === accusedId)) {
    return Response.json({ error: 'Invalid accusedId' }, { status: 422 });
  }
  if (accusedId === playerId) {
    return Response.json({ error: 'Cannot vote for yourself' }, { status: 422 });
  }

  const redis = getRedis();
  const votesKey = `votes:${roomCode}`;
  const countKey = `vote_count:${roomCode}`;

  // Atomically record the vote — returns 1 if set, 0 if field already existed.
  const didSet = await redis.hsetnx(votesKey, playerId, accusedId);
  if (!didSet) {
    return Response.json({ error: 'Already voted' }, { status: 409 });
  }
  await redis.expire(votesKey, ROOM_TTL_SECONDS);

  // Atomically increment the vote counter.
  let voteCount = await redis.incr(countKey);
  await redis.expire(countKey, ROOM_TTL_SECONDS);

  // Dev bots never connect — auto-cast their votes so the tally completes.
  // Non-imposter bots always vote for the imposter so the correct outcome
  // is deterministic (real player's vote is the deciding factor).
  // The imposter bot votes for a random artist so it doesn't self-incriminate.
  if (process.env.NODE_ENV === 'development') {
    const devBots = room.players.filter(
      (p) => p.id.startsWith('dev-bot-') && p.id !== playerId,
    );
    for (const bot of devBots) {
      const alreadyVoted = await redis.hsetnx(votesKey, bot.id, '');
      // Check if bot already has a vote recorded; 0 means field existed already.
      if (alreadyVoted === 0) continue; // already voted in a previous call
      let targetId: string;
      if (bot.id === room.imposterId) {
        // Imposter bot votes for a random artist (not itself, not the imposter).
        const artists = room.players.filter((p) => p.id !== bot.id && p.id !== room.imposterId);
        const fallback = room.players.filter((p) => p.id !== bot.id);
        const pool = artists.length > 0 ? artists : fallback;
        targetId = pool[Math.floor(Math.random() * pool.length)].id;
      } else {
        // Artist bot always votes for the imposter.
        targetId = room.imposterId ?? '';
      }
      await redis.hset(votesKey, { [bot.id]: targetId });
      await redis.expire(votesKey, ROOM_TTL_SECONDS);
      voteCount = await redis.incr(countKey);
      await redis.expire(countKey, ROOM_TTL_SECONDS);
    }
  }

  const totalPlayers = room.players.length;
  const protocol = process.env.NODE_ENV === 'development' ? 'http' : 'https';
  const partyUrl = `${protocol}://${process.env.NEXT_PUBLIC_PARTYKIT_HOST}/parties/main/${roomCode}`;

  if (voteCount >= totalPlayers) {
    // All votes are in — compute and broadcast results.
    // HGETALL is safe here: all N votes are guaranteed to be in the hash
    // because each was written before its corresponding INCR.
    const allVotes = await redis.hgetall<Record<string, string>>(votesKey) ?? {};

    const tally: Record<string, number> = {};
    for (const accused of Object.values(allVotes)) {
      tally[accused] = (tally[accused] ?? 0) + 1;
    }

    const maxVotes = Math.max(...Object.values(tally));
    const topAccused = Object.entries(tally)
      .filter(([, v]) => v === maxVotes)
      .map(([id]) => id);

    // Artists win only if a single player leads AND they are the imposter.
    const artistsWin = topAccused.length === 1 && topAccused[0] === room.imposterId;

    const results: VotingResults = {
      tally,
      imposterId: room.imposterId ?? '',
      word: room.word ?? '',
      artistsWin,
    };

    room.status = 'results';
    await saveRoom(room);

    // If the imposter was correctly identified AND the room has the guess
    // feature enabled, give the imposter a last-chance guess instead of
    // immediately broadcasting the final results.
    const pingAction = artistsWin && room.imposterGuess
      ? 'start_guess_phase'
      : 'voting_complete';

    try {
      await fetch(partyUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: pingAction, results }),
      });
    } catch {
      console.warn('[vote] could not reach PartyKit:', partyUrl);
    }
  } else {
    // Partial — transition room to 'voting' on first vote and notify progress.
    if (room.status !== 'voting') {
      room.status = 'voting';
      await saveRoom(room);
    }

    try {
      await fetch(partyUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'vote_cast', votedCount: voteCount, totalPlayers }),
      });
    } catch {
      console.warn('[vote] could not reach PartyKit:', partyUrl);
    }
  }

  return Response.json({ ok: true, votedCount: voteCount, totalPlayers });
}
