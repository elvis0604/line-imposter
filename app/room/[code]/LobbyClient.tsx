'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
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
  NumberInput,
  Switch,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import type { Player, Room, ServerMessage } from '@/lib/types';
import { DEFAULT_TOTAL_ROUNDS, DEFAULT_TURN_DURATION, DEFAULT_TIMER_MODE, DEFAULT_IMPOSTER_GUESS } from '@/lib/room';

interface Props {
  initialRoom: Room;
  /** Player ID read server-side from the lc_pid cookie. Null if the player
   *  arrived without a cookie (e.g. via a shared link on a fresh device).
   *  The socket effect falls back to localStorage so both paths work. */
  playerId: string | null;
}

function avatarLetters(name: string) {
  return name.slice(0, 2).toUpperCase();
}

/** Short two-tone chime using the Web Audio API — no dependency required. */
function playJoinChime() {
  try {
    const ctx = new AudioContext();
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.18, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.5);
    gain.connect(ctx.destination);

    [523.25, 659.25].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = freq;
      osc.connect(gain);
      osc.start(ctx.currentTime + i * 0.12);
      osc.stop(ctx.currentTime + i * 0.12 + 0.35);
    });
  } catch {
    // AudioContext may be blocked before user interaction — silently ignore
  }
}

export default function LobbyClient({ initialRoom, playerId: serverPlayerId }: Props) {
  const router = useRouter();
  const [room, setRoom] = useState<Room>(initialRoom);
  const [connected, setConnected] = useState(false);
  const [starting, setStarting] = useState(false);
  const [lobbySynced, setLobbySynced] = useState(false);
  const connectedRef = useRef(true);
  const overlayTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Derive isHost directly from the server-supplied cookie value so it is
  // correct on the first render with no hydration flicker.
  const playerId = serverPlayerId ?? '';
  const isHost = room.hostId === playerId;

  // ── Config state (host only) ──────────────────────────────────────────────
  const [totalRounds, setTotalRounds] = useState<number>(
    initialRoom.totalRounds ?? DEFAULT_TOTAL_ROUNDS,
  );
  const [turnDuration, setTurnDuration] = useState<number>(
    Math.round((initialRoom.turnDuration ?? DEFAULT_TURN_DURATION) / 1000),
  );
  const [timerMode, setTimerMode] = useState<'classic' | 'draw'>(
    initialRoom.timerMode ?? DEFAULT_TIMER_MODE,
  );
  const [imposterGuess, setImposterGuess] = useState<boolean>(
    initialRoom.imposterGuess ?? DEFAULT_IMPOSTER_GUESS,
  );

  async function handleStart() {
    setStarting(true);
    try {
      const res = await fetch(`/api/rooms/${room.code}/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          totalRounds,
          turnDuration: turnDuration * 1000,
          timerMode,
          imposterGuess,
        }),
      });
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

  async function handleKick(targetPlayerId: string) {
    await fetch(`/api/rooms/${room.code}/kick`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetPlayerId }),
    });
    // PartyKit broadcasts player_kicked → handleMessage removes them from the list.
  }

  const handleMessage = useCallback((msg: ServerMessage) => {
    switch (msg.type) {
      case 'player_joined':
        setRoom((r) => {
          if (r.players.some((p) => p.id === msg.player.id)) return r;
          return { ...r, players: [...r.players, msg.player] };
        });
        playJoinChime();
        notifications.show({
          color: 'teal',
          message: `${msg.player.name} joined`,
          autoClose: 2000,
        });
        break;

      case 'lobby_sync':
        setRoom((r) => ({ ...r, players: msg.players }));
        setLobbySynced(true);
        break;

      case 'player_left':
        setRoom((r) => ({
          ...r,
          players: r.players.filter((p) => p.id !== msg.playerId),
        }));
        break;

      case 'player_kicked':
        if (msg.playerId === playerId) {
          notifications.show({
            color: 'red',
            title: 'Removed from lobby',
            message: 'The host removed you from the room.',
            autoClose: 4000,
          });
          router.push('/');
        } else {
          setRoom((r) => ({
            ...r,
            players: r.players.filter((p) => p.id !== msg.playerId),
          }));
        }
        break;

      case 'game_started':
        router.push(`/room/${room.code}/game`);
        break;
    }
  }, [room.code, router]);

  useEffect(() => {
    // Prefer the server-supplied cookie value; fall back to localStorage for
    // players who arrived via a shared link without a cookie on a fresh device.
    const pid = serverPlayerId || localStorage.getItem('lc_pid') || '';
    if (!pid) return;

    const playerName = room.players.find((p) => p.id === pid)?.name ?? 'Unknown';

    // Set to true in cleanup before socket.close() so the async 'close' event
    // that fires after the handshake doesn't schedule the disconnect notification
    // on whatever page the user has navigated to by then.
    let intentionalClose = false;

    const socket = new PartySocket({
      host: process.env.NEXT_PUBLIC_PARTYKIT_HOST!,
      room: room.code,
      query: { playerId: pid, playerName },
    });

    socket.addEventListener('open', () => {
      connectedRef.current = true;
      setConnected(true);
      if (overlayTimerRef.current) clearTimeout(overlayTimerRef.current);
      notifications.hide('lobby-disconnect');
    });
    socket.addEventListener('close', () => {
      connectedRef.current = false;
      setConnected(false);
      // Don't schedule the notification when we deliberately closed the socket
      // (e.g. navigating to the game page). The 'close' event fires asynchronously
      // after socket.close(), which is after the cleanup's clearTimeout has run.
      if (intentionalClose) return;
      overlayTimerRef.current = setTimeout(() => {
        if (!connectedRef.current) {
          notifications.show({
            id: 'lobby-disconnect',
            color: 'red',
            title: 'Connection lost',
            message: 'Trying to reconnect…',
            autoClose: false,
            loading: true,
          });
        }
      }, 5000);
    });
    socket.addEventListener('message', (event) => {
      try {
        const msg = JSON.parse(event.data) as ServerMessage;
        handleMessage(msg);
      } catch {
        // ignore malformed messages
      }
    });

    return () => {
      intentionalClose = true;
      socket.close();
      if (overlayTimerRef.current) clearTimeout(overlayTimerRef.current);
    };
  }, [room.code, handleMessage, serverPlayerId]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Stack gap="lg" w="100%" maw={560}>
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
                    {copied ? 'Copied' : 'Copy'}
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
            {lobbySynced ? room.players.length : '…'}
          </Badge>
        </Group>

        {lobbySynced ? (
          room.players.map((player) => (
            <PlayerRow
              key={player.id}
              player={player}
              isHost={room.hostId === player.id}
              isMe={player.id === playerId}
              canKick={isHost && room.hostId !== player.id}
              onKick={() => handleKick(player.id)}
            />
          ))
        ) : (
          <Center py="sm">
            <Loader size="sm" color="violet" />
          </Center>
        )}
      </Stack>

      <Divider />

      {/* Game config (host only) */}
      {isHost && (
        <>
          <Stack gap="xs">
            <Text fw={600} size="sm">Game settings</Text>

            <Group grow align="flex-start">
              <NumberInput
                label="Rounds"
                min={1}
                max={10}
                value={totalRounds}
                onChange={(v) => setTotalRounds(Number(v) || DEFAULT_TOTAL_ROUNDS)}
              />
              <NumberInput
                label="Turn duration (s)"
                min={1}
                max={10}
                value={turnDuration}
                onChange={(v) => setTurnDuration(Number(v) || Math.round(DEFAULT_TURN_DURATION / 1000))}
              />
            </Group>

            <Group grow>
              <Switch
                label="Pause timer when not drawing"
                checked={timerMode === 'draw'}
                onChange={(e) => setTimerMode(e.currentTarget.checked ? 'draw' : 'classic')}
              />
              <Switch
                label="Imposter gets to guess the word"
                checked={imposterGuess}
                onChange={(e) => setImposterGuess(e.currentTarget.checked)}
              />
            </Group>
          </Stack>

          <Divider />
        </>
      )}

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
  canKick,
  onKick,
}: {
  player: Player;
  isHost: boolean;
  isMe: boolean;
  canKick: boolean;
  onKick: () => void;
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
        <Group gap="xs">
          {isHost && (
            <Badge color="yellow" variant="light" size="xs">
              Host
            </Badge>
          )}
          {canKick && (
            <Button
              size="xs"
              variant="light"
              color="red"
              onClick={onKick}
              px={6}
              styles={{
                root: {
                  '&:hover': {
                    backgroundColor: 'var(--mantine-color-red-6)',
                    color: 'white',
                  },
                },
              }}
            >
              Kick
            </Button>
          )}
        </Group>
      </Group>
    </Paper>
  );
}
