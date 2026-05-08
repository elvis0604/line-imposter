'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import PartySocket from 'partysocket';
import {
  Stack,
  Title,
  Text,
  Group,
  Badge,
  Avatar,
  Paper,
  Button,
  CopyButton,
  Tooltip,
  Divider,
  Loader,
  Center,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import type { Player, Room, ServerMessage } from '@/lib/types';

interface Props {
  initialRoom: Room;
}

function avatarLetters(name: string) {
  return name.slice(0, 2).toUpperCase();
}

export default function LobbyClient({ initialRoom }: Props) {
  const router = useRouter();
  const [room, setRoom] = useState<Room>(initialRoom);
  const [connected, setConnected] = useState(false);
  const [starting, setStarting] = useState(false);

  // Both start empty so server and client render identical HTML.
  // useEffect populates them after hydration (client-only).
  const [playerId, setPlayerId] = useState('');

  useEffect(() => {
    const pid = localStorage.getItem('lc_pid') ?? '';
    setPlayerId(pid);
  }, []);

  const isHost = room.hostId === playerId;

  async function handleStart() {
    setStarting(true);
    try {
      const res = await fetch(`/api/rooms/${room.code}/start`, { method: 'POST' });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Failed to start' }));
        notifications.show({ color: 'red', title: 'Error', message: err.error });
        setStarting(false);
      }
      // On success, PartyKit broadcasts game_started → all clients navigate
    } catch {
      notifications.show({ color: 'red', title: 'Error', message: 'Could not reach server' });
      setStarting(false);
    }
  }

  const handleMessage = useCallback((msg: ServerMessage) => {
    switch (msg.type) {
      case 'player_joined':
        setRoom((r) => {
          if (r.players.some((p) => p.id === msg.player.id)) return r;
          return { ...r, players: [...r.players, msg.player] };
        });
        notifications.show({
          color: 'teal',
          message: `${msg.player.name} joined`,
          autoClose: 2000,
        });
        break;

      case 'player_left':
        setRoom((r) => ({
          ...r,
          players: r.players.filter((p) => p.id !== msg.playerId),
        }));
        break;

      case 'game_started':
        router.push(`/room/${room.code}/game`);
        break;
    }
  }, [room.code, router]);

  useEffect(() => {
    const pid = localStorage.getItem('lc_pid') ?? '';
    if (!pid) return;

    const playerName = room.players.find((p) => p.id === pid)?.name ?? 'Unknown';

    const socket = new PartySocket({
      host: process.env.NEXT_PUBLIC_PARTYKIT_HOST!,
      room: room.code,
      query: { playerId: pid, playerName },
    });

    socket.addEventListener('open', () => setConnected(true));
    socket.addEventListener('close', () => setConnected(false));
    socket.addEventListener('message', (event) => {
      try {
        const msg = JSON.parse(event.data) as ServerMessage;
        handleMessage(msg);
      } catch {
        // ignore malformed messages
      }
    });

    return () => socket.close();
  }, [room.code, handleMessage]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Stack gap="lg" w="100%" maw={480}>
      {/* Header */}
      <Group justify="space-between" align="flex-start">
        <Stack gap={2}>
          <Title order={3}>Lobby</Title>
          <Text size="sm" c="dimmed">
            Waiting for players…
          </Text>
        </Stack>
        <Badge color={connected ? 'teal' : 'gray'} variant="dot" size="sm">
          {connected ? 'Connected' : 'Connecting…'}
        </Badge>
      </Group>

      {/* Room code */}
      <Paper withBorder p="md" radius="md">
        <Stack gap={4}>
          <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
            Room code
          </Text>
          <Group justify="space-between" align="center">
            <Text
              size="2.5rem"
              fw={900}
              ff="monospace"
              style={{ letterSpacing: '0.3em' }}
            >
              {room.code}
            </Text>
            <CopyButton value={room.code} timeout={2000}>
              {({ copied, copy }) => (
                <Tooltip label={copied ? 'Copied!' : 'Copy room code'} withArrow>
                  <Button
                    variant={copied ? 'filled' : 'light'}
                    color={copied ? 'teal' : 'violet'}
                    size="xs"
                    onClick={copy}
                  >
                    {copied ? 'Copied' : 'Copy code'}
                  </Button>
                </Tooltip>
              )}
            </CopyButton>
          </Group>
        </Stack>
      </Paper>

      <Divider />

      {/* Player list */}
      <Stack gap="xs">
        <Group justify="space-between">
          <Text fw={600}>Players</Text>
          <Badge variant="light" color="violet">
            {room.players.length}
          </Badge>
        </Group>

        {room.players.map((player) => (
          <PlayerRow
            key={player.id}
            player={player}
            isHost={room.hostId === player.id}
            isMe={player.id === playerId}
          />
        ))}
      </Stack>

      <Divider />

      {/* Start / waiting */}
      {isHost ? (
        <Stack gap="xs">
          <Button
            size="lg"
            fullWidth
            disabled={room.players.length < 3 || starting}
            loading={starting}
            onClick={handleStart}
            title={
              room.players.length < 3
                ? 'Need at least 3 players to start'
                : 'Start the game'
            }
          >
            Start game
          </Button>
          {room.players.length < 3 && (
            <Text size="xs" c="dimmed" ta="center">
              Need at least 3 players ({3 - room.players.length} more)
            </Text>
          )}
        </Stack>
      ) : (
        <Center>
          <Group gap="xs">
            <Loader size="xs" color="violet" />
            <Text size="sm" c="dimmed">
              Waiting for host to start…
            </Text>
          </Group>
        </Center>
      )}
    </Stack>
  );
}

function PlayerRow({
  player,
  isHost,
  isMe,
}: {
  player: Player;
  isHost: boolean;
  isMe: boolean;
}) {
  return (
    <Paper withBorder px="md" py="sm" radius="md">
      <Group justify="space-between">
        <Group gap="sm">
          <Avatar color="violet" radius="xl" size="sm">
            {avatarLetters(player.name)}
          </Avatar>
          <Text size="sm" fw={isMe ? 700 : 400}>
            {player.name}
            {isMe && (
              <Text span size="xs" c="dimmed">
                {' '}(you)
              </Text>
            )}
          </Text>
        </Group>
        {isHost && (
          <Badge color="yellow" variant="light" size="xs">
            Host
          </Badge>
        )}
      </Group>
    </Paper>
  );
}
