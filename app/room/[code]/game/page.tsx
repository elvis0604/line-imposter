import { notFound, redirect } from 'next/navigation';
import { Center } from '@mantine/core';
import { getRoom } from '@/lib/room';
import { getPlayerId } from '@/lib/identity';
import GameClient from './GameClient';

export default async function GamePage(props: PageProps<'/room/[code]/game'>) {
  const { code } = await props.params;
  const room = await getRoom(code.toUpperCase());

  if (!room) notFound();
  if (room.status === 'lobby') redirect(`/room/${code}`);

  const playerId = await getPlayerId();

  // Non-participants (no cookie, or not in the player list) cannot view the game.
  // This prevents an outsider from seeing the secret word via the hydration payload.
  if (!playerId || !room.players.some((p) => p.id === playerId)) {
    redirect('/');
  }

  const isImposter = room.imposterId === playerId;
  const isHost = room.hostId === playerId;
  const word = isImposter ? null : room.word;

  return (
    <Center mih="100vh" p="md">
      <GameClient
        room={room}
        word={word}
        isImposter={isImposter}
        isHost={isHost}
        playerId={playerId}
      />
    </Center>
  );
}
