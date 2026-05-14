import { cookies } from 'next/headers';
import { createRoomObject, generateRoomCode, getRoom, saveRoom, startRoom } from '@/lib/room';
import { PLAYER_ID_COOKIE, PLAYER_NAME_COOKIE } from '@/lib/identity';
import { pickRandomWord } from '@/lib/words';

// POST /api/dev/quick-start — dev only
// Creates a room with 2 bot players, starts it, and returns the room code.
// The requesting player is always an artist (bot-1 is the imposter) so the
// word is visible on the reveal screen — useful for testing.
export async function POST() {
  if (process.env.NODE_ENV !== 'development') {
    return Response.json({ error: 'Not available' }, { status: 404 });
  }

  const jar = await cookies();

  // Reuse existing player id / name from cookie, or generate fresh ones.
  let playerId = jar.get(PLAYER_ID_COOKIE)?.value;
  if (!playerId) {
    playerId = Math.random().toString(36).slice(2, 10);
  }
  const playerName = jar.get(PLAYER_NAME_COOKIE)?.value || 'Dev Player';

  // Unique room code.
  let code = generateRoomCode();
  for (let i = 0; i < 5; i++) {
    if (!(await getRoom(code))) break;
    code = generateRoomCode();
  }

  // Room: real player + 2 bots (minimum 3 required by start logic).
  const room = createRoomObject(code, { id: playerId, name: playerName });
  room.players.push({ id: 'dev-bot-1', name: 'Bot Alpha' });
  room.players.push({ id: 'dev-bot-2', name: 'Bot Beta' });
  await saveRoom(room);

  // Start: bots are the imposter so the real player always sees the word.
  const { word } = pickRandomWord(null);
  const started = await startRoom(code, {
    word,
    imposterId: 'dev-bot-1',
    totalRounds: 3,
    turnDuration: 5_000,
    timerMode: 'classic',
    imposterGuess: false,
    category: null,
  });

  // Ping PartyKit so it stores turn state (best-effort — may not be running).
  const partyUrl = `http://${process.env.NEXT_PUBLIC_PARTYKIT_HOST}/parties/main/${code}`;
  try {
    await fetch(partyUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'game_started',
        turnOrder: started?.turnOrder ?? [],
        totalRounds: 3,
        turnDuration: 5_000,
        timerMode: 'classic',
        imposterGuess: false,
      }),
    });
  } catch {
    // PartyKit not running locally — not fatal for UI testing.
  }

  // Persist identity so the game page server component can read it.
  jar.set(PLAYER_ID_COOKIE, playerId, { path: '/', maxAge: 604800, sameSite: 'lax' });
  jar.set(PLAYER_NAME_COOKIE, playerName, { path: '/', maxAge: 604800, sameSite: 'lax' });

  return Response.json({ code });
}
