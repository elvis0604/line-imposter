'use client';

import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
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
  Box,
  Divider,
  ThemeIcon,
  RingProgress,
  Progress,
  Modal,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import type {
  BroadcastedDrawEvent,
  DrawEvent,
  Room,
  ServerMessage,
  VotingResults,
} from '@/lib/types';
import DrawingCanvas, { type DrawingCanvasHandle } from './DrawingCanvas';
import Toolbar from './Toolbar';

// ── Helpers ───────────────────────────────────────────────────────────────────

function avatarLetters(name: string) {
  return name.slice(0, 2).toUpperCase();
}

function formatTime(ms: number) {
  const sec = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s < 10 ? '0' : ''}${s}`;
}

// ── Types ─────────────────────────────────────────────────────────────────────

type GamePhase = 'reveal' | 'prep' | 'playing' | 'voting' | 'results';

interface TurnState {
  drawerId: string;
  turnIndex: number;
  round: number;
  totalRounds: number;
  turnDuration: number;
}

// ── Component ─────────────────────────────────────────────────────────────────

interface Props {
  room: Room;
  word: string | null;
  isImposter: boolean;
  isHost: boolean;
  playerId: string;
}

export default function GameClient({ room, word, isImposter, isHost, playerId }: Props) {
  const router = useRouter();

  // ── Phase & turn state ────────────────────────────────────────────────────
  const [gamePhase, setGamePhase] = useState<GamePhase>('reveal');
  const [turnState, setTurnState] = useState<TurnState>({
    drawerId: room.turnOrder[0] ?? '',
    turnIndex: 0,
    round: room.currentRound,
    totalRounds: room.totalRounds,
    turnDuration: room.turnDuration ?? 60_000,
  });
  const [timeLeftMs, setTimeLeftMs] = useState(0);
  const turnEndTimeRef = useRef(0);
  const rafRef = useRef<number>(0);

  // ── Drawing tool state ────────────────────────────────────────────────────
  const [color, setColor] = useState('#000000');
  const [lineWidth, setLineWidth] = useState(3);
  const [tool, setTool] = useState<'pen' | 'eraser'>('pen');

  // ── Voting state ──────────────────────────────────────────────────────────
  const [myVote, setMyVote] = useState<string | null>(null);
  const [votedCount, setVotedCount] = useState(0);
  const [votingLoading, setVotingLoading] = useState(false);
  const [votingResults, setVotingResults] = useState<VotingResults | null>(null);

  // ── Play-again state ──────────────────────────────────────────────────────
  const [playAgainLoading, setPlayAgainLoading] = useState(false);

  // ── Canvas & socket refs ──────────────────────────────────────────────────
  const canvasRef = useRef<DrawingCanvasHandle>(null);
  const socketRef = useRef<PartySocket | null>(null);

  // ── Timer countdown ───────────────────────────────────────────────────────
  const startCountdown = useCallback((endTime: number) => {
    turnEndTimeRef.current = endTime;
    if (rafRef.current) cancelAnimationFrame(rafRef.current);

    function tick() {
      const remaining = Math.max(0, turnEndTimeRef.current - Date.now());
      setTimeLeftMs(remaining);
      if (remaining > 0) {
        rafRef.current = requestAnimationFrame(tick);
      }
    }
    rafRef.current = requestAnimationFrame(tick);
  }, []);

  useEffect(() => () => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
  }, []);

  // ── PartySocket message handler ───────────────────────────────────────────
  const handleMessage = useCallback(
    (msg: ServerMessage) => {
      switch (msg.type) {
        case 'draw': {
          if (msg.event.drawerId === playerId) return; // already drawn locally
          canvasRef.current?.replayEvent(msg.event as BroadcastedDrawEvent);
          break;
        }

        case 'canvas_history': {
          canvasRef.current?.loadHistory(msg.events);
          break;
        }

        case 'canvas_clear': {
          canvasRef.current?.clear();
          break;
        }

        case 'turn_prep': {
          const { drawerId, turnIndex, round, totalRounds } = msg;
          setTurnState((prev) => ({ ...prev, drawerId, turnIndex, round, totalRounds }));
          setGamePhase('prep');
          break;
        }

        case 'turn_started': {
          const { drawerId, turnIndex, round, totalRounds, turnDuration, timeLeft } = msg;
          setTurnState({ drawerId, turnIndex, round, totalRounds, turnDuration });
          // Canvas is NOT cleared between turns — the drawing accumulates across all turns.
          startCountdown(Date.now() + timeLeft);
          // Stay in reveal for the very first turn (round 1, turn 0) so the player
          // can read their role card. All other turns go straight to playing.
          const isFirstTurn = round === 1 && turnIndex === 0;
          if (!isFirstTurn) setGamePhase('playing');
          break;
        }

        case 'game_over': {
          if (rafRef.current) cancelAnimationFrame(rafRef.current);
          setVotedCount(0);
          setGamePhase('voting');
          break;
        }

        case 'vote_cast': {
          setVotedCount(msg.votedCount);
          break;
        }

        case 'voting_complete': {
          setVotingResults(msg.results);
          setGamePhase('results');
          break;
        }

        case 'game_reset': {
          // Host reset — return everyone to the lobby.
          router.push(`/room/${room.code}`);
          break;
        }

        // Lobby-only — ignore in game context
        case 'player_joined':
        case 'player_left':
        case 'game_started':
          break;
      }
    },
    [playerId, startCountdown],
  );

  // ── PartySocket connection ────────────────────────────────────────────────
  useEffect(() => {
    const pid = localStorage.getItem('lc_pid') ?? '';
    if (!pid) return;

    const pname =
      room.players.find((p) => p.id === pid)?.name ??
      localStorage.getItem('lc_pname') ??
      'Unknown';

    const socket = new PartySocket({
      host: process.env.NEXT_PUBLIC_PARTYKIT_HOST!,
      room: room.code,
      query: { playerId: pid, playerName: pname },
    });

    socketRef.current = socket;

    socket.addEventListener('message', (e) => {
      try {
        const msg = JSON.parse(e.data as string) as ServerMessage;
        handleMessage(msg);
      } catch {
        // ignore malformed messages
      }
    });

    return () => {
      socket.close();
      socketRef.current = null;
    };
  }, [room.code, room.players, handleMessage]);

  // ── Draw handler (local → server) ─────────────────────────────────────────
  const handleDraw = useCallback((event: DrawEvent) => {
    socketRef.current?.send(JSON.stringify({ type: 'draw', event }));
  }, []);

  // ── Ready handler (prep phase) ────────────────────────────────────────────
  const handleReady = useCallback(() => {
    socketRef.current?.send(JSON.stringify({ type: 'player_ready' }));
  }, []);

  // ── Skip turn handler ─────────────────────────────────────────────────────
  const handleSkipTurn = useCallback(() => {
    socketRef.current?.send(JSON.stringify({ type: 'skip_turn' }));
  }, []);

  // ── Vote handler ──────────────────────────────────────────────────────────
  const handleVote = useCallback(
    async (accusedId: string) => {
      setVotingLoading(true);
      try {
        const res = await fetch(`/api/rooms/${room.code}/vote`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ accusedId }),
        });
        if (res.ok) {
          setMyVote(accusedId);
          const data = await res.json() as { votedCount: number; totalPlayers: number };
          setVotedCount(data.votedCount);
        } else {
          const err = await res.json().catch(() => ({ error: 'Failed to vote' })) as { error: string };
          notifications.show({ color: 'red', title: 'Vote failed', message: err.error });
        }
      } catch {
        notifications.show({ color: 'red', title: 'Error', message: 'Could not reach server' });
      } finally {
        setVotingLoading(false);
      }
    },
    [room.code],
  );

  // ── Play-again handler (host only) ────────────────────────────────────────
  const handlePlayAgain = useCallback(async () => {
    setPlayAgainLoading(true);
    try {
      const res = await fetch(`/api/rooms/${room.code}/reset`, { method: 'POST' });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Failed to reset' })) as { error: string };
        notifications.show({ color: 'red', title: 'Error', message: err.error });
        setPlayAgainLoading(false);
      }
      // On success, PartyKit broadcasts game_reset → all clients redirect to lobby
    } catch {
      notifications.show({ color: 'red', title: 'Error', message: 'Could not reach server' });
      setPlayAgainLoading(false);
    }
  }, [room.code]);

  // ── Derived ───────────────────────────────────────────────────────────────
  const isMyTurn = turnState.drawerId === playerId;
  const drawerPlayer = room.players.find((p) => p.id === turnState.drawerId);
  const timerPercent = Math.round((timeLeftMs / turnState.turnDuration) * 100);
  const timerColor = timeLeftMs > 20_000 ? 'teal' : timeLeftMs > 10_000 ? 'yellow' : 'red';

  // ─────────────────────────────────────────────────────────────────────────
  // REVEAL PHASE
  // ─────────────────────────────────────────────────────────────────────────
  if (gamePhase === 'reveal') {
    return (
      <Stack gap="lg" w="100%" maw={440}>
        <Paper
          withBorder
          p="xl"
          radius="md"
          style={{
            borderColor: isImposter
              ? 'var(--mantine-color-red-6)'
              : 'var(--mantine-color-teal-6)',
            borderWidth: 2,
          }}
        >
          <Stack align="center" gap="lg">
            <ThemeIcon size={64} radius="xl" color={isImposter ? 'red' : 'teal'} variant="light">
              <Text size="2rem">{isImposter ? '🎭' : '🎨'}</Text>
            </ThemeIcon>

            <Stack align="center" gap={4}>
              <Text size="xs" tt="uppercase" fw={700} c="dimmed">Your role</Text>
              <Title order={2} c={isImposter ? 'red' : 'teal'}>
                {isImposter ? 'Imposter' : 'Artist'}
              </Title>
            </Stack>

            {isImposter ? (
              <Stack align="center" gap={4}>
                <Text size="sm" c="dimmed" ta="center">
                  You don&apos;t know the word. Blend in — draw convincingly without giving yourself away.
                </Text>
                <Badge color="red" variant="light" size="lg" mt="xs">Word: ???</Badge>
              </Stack>
            ) : (
              <Stack align="center" gap={4}>
                <Text size="sm" c="dimmed" ta="center">
                  Draw this word when it&apos;s your turn. Find the imposter!
                </Text>
                <Badge color="teal" variant="light" size="lg" mt="xs">Word: {word}</Badge>
              </Stack>
            )}

            <Button
              size="md"
              color={isImposter ? 'red' : 'teal'}
              fullWidth
              onClick={() => setGamePhase('playing')}
            >
              Got it — let&apos;s draw
            </Button>
          </Stack>
        </Paper>
      </Stack>
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // VOTING PHASE
  // ─────────────────────────────────────────────────────────────────────────
  if (gamePhase === 'voting') {
    const totalPlayers = room.players.length;
    const votedSoFar = myVote ? Math.max(votedCount, 1) : votedCount;
    const myVotedPlayer = room.players.find((p) => p.id === myVote);
    const otherPlayers = room.players.filter((p) => p.id !== playerId);

    return (
      <Stack gap="lg" w="100%" maw={480}>
        <Stack align="center" gap={4}>
          <Title order={2}>Who is the imposter?</Title>
          <Text c="dimmed" size="sm">Vote for the player you think doesn&apos;t know the word.</Text>
        </Stack>

        {/* Vote progress */}
        <Paper withBorder p="md" radius="md">
          <Stack gap="xs">
            <Group justify="space-between">
              <Text size="sm" fw={600}>Votes cast</Text>
              <Text size="sm" c="dimmed">{votedSoFar} / {totalPlayers}</Text>
            </Group>
            <Progress
              value={(votedSoFar / totalPlayers) * 100}
              color="violet"
              radius="xl"
              size="sm"
              animated={votedSoFar < totalPlayers}
            />
          </Stack>
        </Paper>

        {myVote ? (
          /* Already voted */
          <Paper withBorder p="lg" radius="md">
            <Stack align="center" gap="sm">
              <Text fw={600} c="dimmed" size="sm">Your vote</Text>
              <Group gap="sm">
                <Avatar color="violet" radius="xl">
                  {myVotedPlayer ? avatarLetters(myVotedPlayer.name) : '?'}
                </Avatar>
                <Text fw={700} size="lg">{myVotedPlayer?.name ?? '…'}</Text>
              </Group>
              <Text size="sm" c="dimmed">
                Waiting for {totalPlayers - votedSoFar} more player{totalPlayers - votedSoFar !== 1 ? 's' : ''}…
              </Text>
            </Stack>
          </Paper>
        ) : (
          /* Pick a player */
          <Stack gap="xs">
            {otherPlayers.map((player) => (
              <Button
                key={player.id}
                variant="light"
                color="violet"
                size="md"
                fullWidth
                loading={votingLoading}
                leftSection={
                  <Avatar color="violet" size="sm" radius="xl">
                    {avatarLetters(player.name)}
                  </Avatar>
                }
                onClick={() => handleVote(player.id)}
              >
                {player.name}
              </Button>
            ))}
          </Stack>
        )}
      </Stack>
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // RESULTS PHASE
  // ─────────────────────────────────────────────────────────────────────────
  if (gamePhase === 'results' && votingResults) {
    const { tally, imposterId, artistsWin } = votingResults;
    const revealedWord = votingResults.word;
    const imposterPlayer = room.players.find((p) => p.id === imposterId);
    const wasImposter = playerId === imposterId;

    // Sort players by votes received (descending)
    const sortedPlayers = [...room.players].sort(
      (a, b) => (tally[b.id] ?? 0) - (tally[a.id] ?? 0),
    );

    return (
      <Stack gap="lg" w="100%" maw={480}>
        {/* Outcome banner */}
        <Paper
          withBorder
          p="xl"
          radius="md"
          style={{
            borderColor: artistsWin
              ? 'var(--mantine-color-teal-6)'
              : 'var(--mantine-color-red-6)',
            borderWidth: 2,
          }}
        >
          <Stack align="center" gap="sm">
            <Text size="3rem" style={{ lineHeight: 1 }}>
              {artistsWin ? '🎉' : '🎭'}
            </Text>
            <Title order={2} c={artistsWin ? 'teal' : 'red'}>
              {artistsWin ? 'Artists win!' : 'Imposter wins!'}
            </Title>
            <Text size="sm" c="dimmed" ta="center">
              {artistsWin
                ? 'The imposter was caught. Good detective work!'
                : wasImposter
                  ? 'You fooled them all. Well played!'
                  : 'The imposter blended in perfectly.'}
            </Text>
          </Stack>
        </Paper>

        {/* Reveal cards */}
        <Group grow>
          <Paper withBorder p="md" radius="md">
            <Stack gap={4} align="center">
              <Text size="xs" tt="uppercase" fw={700} c="dimmed">The word was</Text>
              <Badge color="teal" variant="light" size="xl" radius="md">
                {revealedWord}
              </Badge>
            </Stack>
          </Paper>

          <Paper withBorder p="md" radius="md">
            <Stack gap={4} align="center">
              <Text size="xs" tt="uppercase" fw={700} c="dimmed">The imposter</Text>
              <Group gap="xs">
                <Avatar color="red" size="sm" radius="xl">
                  {imposterPlayer ? avatarLetters(imposterPlayer.name) : '?'}
                </Avatar>
                <Text fw={700}>{imposterPlayer?.name ?? '?'}</Text>
              </Group>
            </Stack>
          </Paper>
        </Group>

        {/* Vote tally */}
        <Stack gap="xs">
          <Text fw={600} size="sm">Vote tally</Text>
          {sortedPlayers.map((player) => {
            const votes = tally[player.id] ?? 0;
            const isImposterPlayer = player.id === imposterId;
            return (
              <Paper key={player.id} withBorder px="md" py="sm" radius="md">
                <Group justify="space-between">
                  <Group gap="sm">
                    <Avatar
                      color={isImposterPlayer ? 'red' : 'violet'}
                      size="sm"
                      radius="xl"
                    >
                      {avatarLetters(player.name)}
                    </Avatar>
                    <Text size="sm" fw={player.id === playerId ? 700 : 400}>
                      {player.name}
                      {player.id === playerId && (
                        <Text span size="xs" c="dimmed"> (you)</Text>
                      )}
                    </Text>
                    {isImposterPlayer && (
                      <Badge color="red" variant="light" size="xs">Imposter</Badge>
                    )}
                  </Group>
                  <Badge
                    color={votes > 0 ? 'violet' : 'gray'}
                    variant={votes > 0 ? 'filled' : 'light'}
                    size="sm"
                  >
                    {votes} vote{votes !== 1 ? 's' : ''}
                  </Badge>
                </Group>
              </Paper>
            );
          })}
        </Stack>

        <Button size="md" onClick={() => router.push('/')}>
          Leave
        </Button>

        {isHost ? (
          <Button
            size="md"
            color="violet"
            loading={playAgainLoading}
            onClick={handlePlayAgain}
          >
            Play again
          </Button>
        ) : (
          <Text size="sm" c="dimmed" ta="center">
            Waiting for host to start a new game…
          </Text>
        )}
      </Stack>
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // PLAYING PHASE  (also rendered during 'prep' so the canvas stays mounted)
  // ─────────────────────────────────────────────────────────────────────────
  return (
    <Stack gap="sm" w="100%" maw={900}>
      {/* ── Prep-phase modal — shown between turns while waiting for drawer ── */}
      <Modal
        opened={gamePhase === 'prep'}
        onClose={() => {}}
        withCloseButton={false}
        centered
        title={
          <Text fw={700} size="sm" c="dimmed" tt="uppercase">
            Round {turnState.round}/{turnState.totalRounds} — next up
          </Text>
        }
      >
        <Stack align="center" gap="lg" py="sm">
          <Group gap="sm">
            <Avatar color="violet" radius="xl" size="lg">
              {drawerPlayer ? avatarLetters(drawerPlayer.name) : '?'}
            </Avatar>
            <Text fw={700} size="xl">
              {isMyTurn ? 'You!' : (drawerPlayer?.name ?? '…')}
            </Text>
          </Group>

          {isMyTurn ? (
            <Button size="md" color="violet" fullWidth onClick={handleReady}>
              Ready to draw!
            </Button>
          ) : (
            <Text size="sm" c="dimmed" ta="center">
              Waiting for {drawerPlayer?.name ?? '…'} to get ready…
            </Text>
          )}
        </Stack>
      </Modal>
      {/* ── Header ──────────────────────────────────────────────────────── */}
      <Group justify="space-between" align="center" wrap="nowrap">
        <Badge variant="light" color="violet" size="lg">
          Round {turnState.round}/{turnState.totalRounds}
        </Badge>

        <Group gap="xs" align="center">
          <Avatar color="violet" size="sm" radius="xl">
            {drawerPlayer ? avatarLetters(drawerPlayer.name) : '?'}
          </Avatar>
          <Text size="sm" fw={600}>
            {isMyTurn ? 'Your turn!' : `${drawerPlayer?.name ?? '…'}'s turn`}
          </Text>
        </Group>

        <Group gap={6} align="center">
          <RingProgress
            size={40}
            thickness={4}
            roundCaps
            sections={[{ value: timerPercent, color: timerColor }]}
          />
          <Text size="sm" fw={700} c={timerColor} ff="monospace">
            {formatTime(timeLeftMs)}
          </Text>
        </Group>
      </Group>

      {/* ── Word reminder ────────────────────────────────────────────────── */}
      <Group justify="space-between" align="center">
        <Group gap="xs">
          {isImposter ? (
            <Badge color="red" variant="light">Imposter — blend in!</Badge>
          ) : (
            <Badge color="teal" variant="light">Word: {word}</Badge>
          )}
          {isMyTurn && <Badge color="violet" variant="filled">Draw now!</Badge>}
        </Group>

        {/* Skip / done button — only for the active drawer */}
        {isMyTurn && (
          <Button
            size="xs"
            variant="subtle"
            color="gray"
            onClick={handleSkipTurn}
          >
            Done drawing
          </Button>
        )}
      </Group>

      <Divider />

      {/* ── Canvas + turn order side by side ────────────────────────────── */}
      <Group align="flex-start" wrap="nowrap" gap="sm">
        {/* Canvas */}
        <Box
          style={{
            flex: 1,
            border: '2px solid var(--mantine-color-gray-3)',
            borderRadius: 8,
            overflow: 'hidden',
            background: '#fff',
          }}
        >
          <DrawingCanvas
            ref={canvasRef}
            isDrawingAllowed={isMyTurn}
            color={color}
            lineWidth={lineWidth}
            tool={tool}
            onDraw={handleDraw}
          />
        </Box>

        {/* Turn order */}
        <Paper withBorder p="sm" radius="md" w={140} style={{ flexShrink: 0 }}>
          <Stack gap={6}>
            <Text size="xs" tt="uppercase" fw={700} c="dimmed">Turn order</Text>
            {room.turnOrder.map((pid, idx) => {
              const p = room.players.find((pl) => pl.id === pid);
              if (!p) return null;
              const isCurrent = idx === turnState.turnIndex;
              return (
                <Group key={pid} gap={4} wrap="nowrap">
                  <Text size="xs" c="dimmed" w={14} style={{ flexShrink: 0 }}>{idx + 1}.</Text>
                  <Text
                    size="xs"
                    fw={isCurrent ? 700 : 400}
                    c={isCurrent ? 'violet' : undefined}
                    style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                  >
                    {p.name}{pid === playerId && ' (you)'}
                  </Text>
                  {isCurrent && (
                    <Badge size="xs" color="violet" variant="dot" style={{ flexShrink: 0 }} />
                  )}
                </Group>
              );
            })}
          </Stack>
        </Paper>
      </Group>

      {/* ── Toolbar ─────────────────────────────────────────────────────── */}
      <Paper withBorder p="sm" radius="md">
        {isMyTurn ? (
          <Toolbar
            color={color}
            lineWidth={lineWidth}
            tool={tool}
            onColorChange={setColor}
            onLineWidthChange={setLineWidth}
            onToolChange={setTool}
            disabled={false}
          />
        ) : (
          <Group justify="center">
            <Text size="sm" c="dimmed">
              Watching {drawerPlayer?.name ?? '…'} draw…
            </Text>
          </Group>
        )}
      </Paper>
    </Stack>
  );
}
