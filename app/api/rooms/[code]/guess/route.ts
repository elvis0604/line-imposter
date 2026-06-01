import { cookies } from 'next/headers';
import { getRoom } from '@/lib/room';
import { PLAYER_ID_COOKIE } from '@/lib/identity';

// POST /api/rooms/[code]/guess — imposter submits their word guess
// Called during the imposter_guess_phase. We validate the guess against the
// room word and ping PartyKit, which already holds the original VotingResults
// and decides the final broadcast: voting_complete with guessedWord (correct)
// or voting_complete with the unchanged artistsWin=true results (wrong/timeout).
export async function POST(req: Request, ctx: RouteContext<'/api/rooms/[code]/guess'>) {
  const { code } = await ctx.params;
  const roomCode = code.toUpperCase();

  const jar = await cookies();
  const playerId = jar.get(PLAYER_ID_COOKIE)?.value;
  if (!playerId) {
    return Response.json({ error: 'Not identified' }, { status: 401 });
  }

  const body = await req.json() as { guess?: string };
  const guess = typeof body.guess === 'string' ? body.guess.trim() : '';
  if (!guess) {
    return Response.json({ error: 'guess is required' }, { status: 400 });
  }

  const room = await getRoom(roomCode);
  if (!room) {
    return Response.json({ error: 'Room not found' }, { status: 404 });
  }
  if (room.imposterId !== playerId) {
    return Response.json({ error: 'Only the imposter can submit a guess' }, { status: 403 });
  }
  if (!room.word) {
    return Response.json({ error: 'No active word' }, { status: 409 });
  }

  const correct = guess.toLowerCase() === room.word.toLowerCase();

  const protocol = process.env.NODE_ENV === 'development' ? 'http' : 'https';
  const partyUrl = `${protocol}://${process.env.NEXT_PUBLIC_PARTYKIT_HOST}/parties/main/${roomCode}`;

  // Always send the guessed word so the results screen can display it regardless of outcome.
  const pingBody = { action: 'guess_result', guessedWord: guess, correct };

  try {
    await fetch(partyUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(pingBody),
    });
  } catch {
    console.warn('[guess] could not reach PartyKit:', partyUrl);
  }

  return Response.json({ ok: true, correct });
}
