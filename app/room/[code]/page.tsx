import { notFound, redirect } from 'next/navigation';
import { Center } from '@mantine/core';
import { getRoom } from '@/lib/room';
import LobbyClient from './LobbyClient';

export default async function RoomPage(props: PageProps<'/room/[code]'>) {
  const { code } = await props.params;
  const room = await getRoom(code.toUpperCase());

  if (!room) notFound();

  // If the game has moved past lobby, Phase 3/6 will add redirects here
  if (room.status !== 'lobby') {
    redirect(`/room/${code}/game`);
  }

  return (
    <Center mih="100dvh" p="md">
      <LobbyClient initialRoom={room} />
    </Center>
  );
}
