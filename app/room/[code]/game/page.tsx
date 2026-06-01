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

  // Visitors who are not in the player list watch as silent observers.
  // The secret word is withheld from them (and from the imposter) so it never
  // leaks through the hydration payload.
  const isObserver = !playerId || !room.players.some((p) => p.id === playerId);
  const isImposter = !isObserver && room.imposterId === playerId;
  const isHost = !isObserver && room.hostId === playerId;
  const word = isObserver || isImposter ? null : room.word;

  return (
    <Center mih="100dvh" p="md">
      <GameClient
        room={room}
        word={word}
        isImposter={isImposter}
        isHost={isHost}
        playerId={playerId ?? ''}
        isObserver={isObserver}
      />
    </Center>
  );
}
