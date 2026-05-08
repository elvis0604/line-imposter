import { notFound, redirect } from 'next/navigation';
import { Center } from '@mantine/core';
import { getRoom } from '@/lib/room';
import { getPlayerId } from '@/lib/identity';
import LobbyClient from './LobbyClient';

export default async function RoomPage(props: PageProps<'/room/[code]'>) {
  const { code } = await props.params;
  const room = await getRoom(code.toUpperCase());

  if (!room) notFound();

  // If the game has moved past lobby, Phase 3/6 will add redirects here
  if (room.status !== 'lobby') {
    redirect(`/room/${code}/game`);
  }

  // Pass the cookie-based player ID to the client so the WebSocket connection
  // doesn't depend solely on localStorage (which may not be set on a fresh
  // device that arrived via a shared link rather than the join form).
  const playerId = await getPlayerId();

  return (
    <Center mih="100dvh" p="md">
      <LobbyClient initialRoom={room} playerId={playerId} />
    </Center>
  );
}
