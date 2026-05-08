import { cookies } from 'next/headers';

export const PLAYER_ID_COOKIE = 'lc_pid';
export const PLAYER_NAME_COOKIE = 'lc_pname';

/** Read the player ID cookie from an incoming server-side request. */
export async function getPlayerId(): Promise<string | null> {
  const jar = await cookies();
  return jar.get(PLAYER_ID_COOKIE)?.value ?? null;
}

/** Read the player name cookie from an incoming server-side request. */
export async function getPlayerName(): Promise<string | null> {
  const jar = await cookies();
  return jar.get(PLAYER_NAME_COOKIE)?.value ?? null;
}
