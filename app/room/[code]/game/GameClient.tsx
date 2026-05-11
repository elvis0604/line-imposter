'use client';

import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { useRouter } from 'next/navigation';
import PartySocket from 'partysocket';
import { AnimatePresence, motion } from 'framer-motion';
import { useMediaQuery } from '@mantine/hooks';
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
  Loader,
  Overlay,
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
import DevPanel from './DevPanel';

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

// ── Animation ─────────────────────────────────────────────────────────────────

const fade = {
  hidden:  { opacity: 0 },
  visible: { opacity: 1 },
};
const fadeTrans = { duration: 0.15 };

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
  const isMobile = useMediaQuery('(max-width: 600px)') ?? false;

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
  const [timerPaused, setTimerPaused] = useState(true);
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

  // ── Reveal-acknowledged state ──────────────────────────────────────────────
  const [revealAcknowledged, setRevealAcknowledged] = useState(false);
  const [revealReadyCount, setRevealReadyCount] = useState(0);
  const [revealTimeLeftMs, setRevealTimeLeftMs] = useState(0);
  const revealDeadlineRef = useRef(0);
  const revealRafRef = useRef<number>(0);

  // ── Play-again state ──────────────────────────────────────────────────────
  const [playAgainLoading, setPlayAgainLoading] = useState(false);

  // ── Connection state ──────────────────────────────────────────────────────
  const [showDisconnectOverlay, setShowDisconnectOverlay] = useState(false);
  const connectedRef = useRef(true);
  const overlayTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Canvas & socket refs ──────────────────────────────────────────────────
  const canvasRef = useRef<DrawingCanvasHandle>(null);
  const socketRef = useRef<PartySocket | null>(null);
  /**
   * Buffer for canvas events (history snapshot + live draw strokes) that
   * arrive while the canvas isn't mounted yet (i.e. during the reveal phase).
   * Flushed onto the canvas as soon as the player dismisses the reveal screen.
   */
  const pendingCanvasEventsRef = useRef<BroadcastedDrawEvent[]>([]);
  /**
   * Tracks the phase the server wants us to be in.
   * Starts as 'reveal' — updated when turn_prep/turn_started arrive.
   * The actual gamePhase state is only updated once the player has
   * acknowledged the reveal screen.
   */
  const desiredPhaseRef = useRef<GamePhase>('reveal');
  /** Set to true when the player clicks "Got it" on the reveal screen. */
  const revealDismissedRef = useRef(false);

  // ── Flush buffered canvas events once the canvas mounts ──────────────────
  // AnimatePresence (mode="wait") delays mounting of DrawingCanvas until
  // after the reveal exit animation (~150ms). A simple useEffect([gamePhase])
  // fires too early — the canvas ref is still null. Instead, poll with rAF
  // until canvasRef is populated, then replay everything in the buffer.
  useEffect(() => {
    if (gamePhase !== 'playing' && gamePhase !== 'prep') return;

    let raf: number;
    const flush = () => {
      if (!canvasRef.current) {
        raf = requestAnimationFrame(flush);
        return;
      }
      if (pendingCanvasEventsRef.current.length > 0) {
        canvasRef.current.loadHistory(pendingCanvasEventsRef.current);
        pendingCanvasEventsRef.current = [];
      }
    };
    raf = requestAnimationFrame(flush);
    return () => cancelAnimationFrame(raf);
  }, [gamePhase]);

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
    if (revealRafRef.current) cancelAnimationFrame(revealRafRef.current);
  }, []);

  // ── PartySocket message handler ───────────────────────────────────────────
  const handleMessage = useCallback(
    (msg: ServerMessage) => {
      switch (msg.type) {
        case 'draw': {
          if (msg.event.drawerId === playerId) return;
          if (canvasRef.current) {
            canvasRef.current.replayEvent(msg.event as BroadcastedDrawEvent);
          } else {
            // Canvas not mounted yet (reveal screen) — buffer for later.
            pendingCanvasEventsRef.current.push(msg.event as BroadcastedDrawEvent);
          }
          break;
        }

        case 'canvas_history': {
          if (canvasRef.current) {
            canvasRef.current.loadHistory(msg.events);
          } else {
            // Canvas not mounted yet — replace buffer with the full snapshot,
            // then any subsequent live draw events will be appended on top.
            pendingCanvasEventsRef.current = [...msg.events];
          }
          break;
        }

        case 'canvas_clear': {
          pendingCanvasEventsRef.current = [];
          canvasRef.current?.clear();
          break;
        }

        case 'reveal_progress': {
          setRevealReadyCount(msg.readyCount);
          // Start (or update) the countdown using the server deadline.
          if (revealDeadlineRef.current !== msg.deadline) {
            revealDeadlineRef.current = msg.deadline;
            if (revealRafRef.current) cancelAnimationFrame(revealRafRef.current);
            const tick = () => {
              const remaining = Math.max(0, revealDeadlineRef.current - Date.now());
              setRevealTimeLeftMs(remaining);
              if (remaining > 0) revealRafRef.current = requestAnimationFrame(tick);
            };
            revealRafRef.current = requestAnimationFrame(tick);
          }
          break;
        }

        case 'turn_prep': {
          const { drawerId, turnIndex, round, totalRounds } = msg;
          setTurnState((prev) => ({ ...prev, drawerId, turnIndex, round, totalRounds }));
          setTimerPaused(true);
          if (rafRef.current) cancelAnimationFrame(rafRef.current);
          desiredPhaseRef.current = 'prep';
          // Only update the visible phase once the player has dismissed the reveal screen.
          if (revealDismissedRef.current) setGamePhase('prep');
          break;
        }

        case 'turn_started': {
          const { drawerId, turnIndex, round, totalRounds, turnDuration, timeLeft } = msg;
          setTurnState({ drawerId, turnIndex, round, totalRounds, turnDuration });
          if (room.timerMode === 'classic') {
            // Classic: countdown starts immediately when the turn starts.
            setTimerPaused(false);
            startCountdown(Date.now() + timeLeft);
          } else {
            // Draw mode: timer starts paused, waits for timer_update from server.
            setTimerPaused(true);
            if (rafRef.current) cancelAnimationFrame(rafRef.current);
            setTimeLeftMs(timeLeft);
          }
          desiredPhaseRef.current = 'playing';
          if (revealDismissedRef.current) setGamePhase('playing');
          break;
        }

        case 'timer_started':
          // Legacy — ignore (superseded by timer_update).
          break;

        case 'timer_update': {
          if (msg.paused) {
            setTimerPaused(true);
            if (rafRef.current) cancelAnimationFrame(rafRef.current);
            setTimeLeftMs(msg.remainingMs);
          } else {
            setTimerPaused(false);
            startCountdown(msg.turnEndTime);
          }
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
          router.push(`/room/${room.code}`);
          break;
        }

        case 'player_joined':
        case 'player_left':
        case 'game_started':
          break;
      }
    },
    [playerId, startCountdown, router, room.code],
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

    socket.addEventListener('open', () => {
      connectedRef.current = true;
      setShowDisconnectOverlay(false);
      if (overlayTimerRef.current) clearTimeout(overlayTimerRef.current);
    });

    socket.addEventListener('close', () => {
      connectedRef.current = false;
      overlayTimerRef.current = setTimeout(() => {
        if (!connectedRef.current) setShowDisconnectOverlay(true);
      }, 1500);
    });

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
      if (overlayTimerRef.current) clearTimeout(overlayTimerRef.current);
    };
  }, [room.code, room.players, handleMessage]);

  // ── Draw handler ──────────────────────────────────────────────────────────
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
    } catch {
      notifications.show({ color: 'red', title: 'Error', message: 'Could not reach server' });
      setPlayAgainLoading(false);
    }
  }, [room.code]);

  // ── Derived ───────────────────────────────────────────────────────────────
  const isMyTurn = turnState.drawerId === playerId;
  const drawerPlayer = room.players.find((p) => p.id === turnState.drawerId);
  const timerPercent = Math.round((timeLeftMs / turnState.turnDuration) * 100);
  const timerColor = timerPaused ? 'green'
    : timeLeftMs > 20_00 ? 'yellow'
    : 'red';

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <>
      {/* ── Disconnect overlay ───────────────────────────────────────────── */}
      {showDisconnectOverlay && (
        <Box
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 9999,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Overlay color="#000" backgroundOpacity={0.65} blur={4} />
          <Stack align="center" gap="md" style={{ position: 'relative', zIndex: 1 }}>
            <Loader color="white" size="lg" />
            <Text c="white" fw={700} size="lg">Reconnecting…</Text>
            <Text c="dimmed" size="sm">Your progress is saved.</Text>
          </Stack>
        </Box>
      )}

      {/* ── Phase views ──────────────────────────────────────────────────── */}
      <AnimatePresence mode="wait">

        {/* ── REVEAL ─────────────────────────────────────────────────────── */}
        {gamePhase === 'reveal' && (
          <motion.div
            key="reveal"
            variants={fade}
            initial="hidden"
            animate="visible"
            exit="hidden"
            transition={fadeTrans}
          >
            <Stack gap="lg" w="100%" maw={560}>
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
                      <Badge color="teal" variant="light" size="lg" mt="xs" style={{ whiteSpace: 'normal', height: 'auto', textAlign: 'center' }}>Word: {word}</Badge>
                    </Stack>
                  )}

                  {revealAcknowledged ? (
                    <Stack gap="sm" w="100%" align="center">
                      <Progress
                        value={(Math.max(revealReadyCount, 1) / room.players.length) * 100}
                        color={isImposter ? 'red' : 'teal'}
                        size="sm"
                        radius="xl"
                        w="100%"
                        animated={revealReadyCount < room.players.length}
                      />
                      <Group gap="xs">
                        <Loader size="xs" color={isImposter ? 'red' : 'teal'} />
                        <Text size="sm" c="dimmed">
                          Waiting for{' '}
                          {room.players.length - Math.max(revealReadyCount, 1)} more player
                          {room.players.length - Math.max(revealReadyCount, 1) !== 1 ? 's' : ''}
                          …
                        </Text>
                        {revealTimeLeftMs > 0 && (
                          <Text size="sm" c="dimmed" ff="monospace">
                            ({Math.ceil(revealTimeLeftMs / 1000)}s)
                          </Text>
                        )}
                      </Group>
                    </Stack>
                  ) : (
                    <Stack gap="xs" w="100%">
                      {revealTimeLeftMs > 0 && (
                        <Text size="xs" c="dimmed" ta="center">
                          Auto-starting in {Math.ceil(revealTimeLeftMs / 1000)}s
                        </Text>
                      )}
                      <Button
                        size="md"
                        color={isImposter ? 'red' : 'teal'}
                        fullWidth
                        onClick={() => {
                          revealDismissedRef.current = true;
                          setRevealAcknowledged(true);
                          socketRef.current?.send(
                            JSON.stringify({ type: 'reveal_acknowledged' }),
                          );
                          // Edge case: server already advanced past reveal
                          // (timeout fired before player clicked).
                          if (desiredPhaseRef.current !== 'reveal') {
                            setGamePhase(desiredPhaseRef.current);
                          }
                        }}
                      >
                        Got it — let&apos;s draw
                      </Button>
                    </Stack>
                  )}
                </Stack>
              </Paper>
            </Stack>
          </motion.div>
        )}

        {/* ── VOTING ─────────────────────────────────────────────────────── */}
        {gamePhase === 'voting' && (
          <motion.div
            key="voting"
            variants={fade}
            initial="hidden"
            animate="visible"
            exit="hidden"
            transition={fadeTrans}
          >
            <Stack gap="lg" w="100%" maw={560}>
              <Stack align="center" gap={4}>
                <Title order={2}>Who is the imposter?</Title>
                <Text c="dimmed" size="sm">Vote for the player you think doesn&apos;t know the word.</Text>
              </Stack>

              <Paper withBorder p="md" radius="md">
                <Stack gap="xs">
                  <Group justify="space-between">
                    <Text size="sm" fw={600}>Votes cast</Text>
                    <Text size="sm" c="dimmed">
                      {myVote ? Math.max(votedCount, 1) : votedCount} / {room.players.length}
                    </Text>
                  </Group>
                  <Progress
                    value={((myVote ? Math.max(votedCount, 1) : votedCount) / room.players.length) * 100}
                    color="violet"
                    radius="xl"
                    size="sm"
                    animated={(myVote ? Math.max(votedCount, 1) : votedCount) < room.players.length}
                  />
                </Stack>
              </Paper>

              {myVote ? (
                <Paper withBorder p="lg" radius="md">
                  <Stack align="center" gap="sm">
                    <Text fw={600} c="dimmed" size="sm">Your vote</Text>
                    <Group gap="sm">
                      <Avatar color="violet" radius="xl">
                        {avatarLetters(room.players.find((p) => p.id === myVote)?.name ?? '?')}
                      </Avatar>
                      <Text fw={700} size="lg">
                        {room.players.find((p) => p.id === myVote)?.name ?? '…'}
                      </Text>
                    </Group>
                    <Text size="sm" c="dimmed">
                      Waiting for {room.players.length - Math.max(votedCount, 1)} more player
                      {room.players.length - Math.max(votedCount, 1) !== 1 ? 's' : ''}…
                    </Text>
                  </Stack>
                </Paper>
              ) : (
                <Stack gap="xs">
                  {room.players.filter((p) => p.id !== playerId).map((player) => (
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
          </motion.div>
        )}

        {/* ── RESULTS ────────────────────────────────────────────────────── */}
        {gamePhase === 'results' && votingResults && (
          <motion.div
            key="results"
            variants={fade}
            initial="hidden"
            animate="visible"
            exit="hidden"
            transition={fadeTrans}
          >
            {(() => {
              const { tally, imposterId, artistsWin } = votingResults;
              const revealedWord = votingResults.word;
              const imposterPlayer = room.players.find((p) => p.id === imposterId);
              const wasImposter = playerId === imposterId;
              const sortedPlayers = [...room.players].sort(
                (a, b) => (tally[b.id] ?? 0) - (tally[a.id] ?? 0),
              );

              return (
                <Stack gap="lg" w="100%" maw={560}>
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

                  <Stack gap="md">
                    <Paper withBorder p="md" radius="md">
                       <Stack gap={4} align="center">
                         <Text size="xs" tt="uppercase" fw={700} c="dimmed">The word was</Text>
                         <Text
                           fw={700}
                           size="md"
                           ta="center"
                           px="sm"
                           py={4}
                           w="100%"
                           style={{
                             background: 'var(--mantine-color-teal-light)',
                             color: 'var(--mantine-color-teal-light-color)',
                             borderRadius: 'var(--mantine-radius-md)',
                             wordBreak: 'break-word',
                           }}
                         >
                           {revealedWord}
                         </Text>
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
                  </Stack>

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

                  <Group>
                    <Button flex={1} variant="default" onClick={() => router.push('/')}>
                      Leave
                    </Button>
                    {isHost ? (
                      <Button
                        flex={1}
                        color="violet"
                        loading={playAgainLoading}
                        onClick={handlePlayAgain}
                      >
                        Play again
                      </Button>
                    ) : (
                      <Text size="sm" c="dimmed" ta="center" style={{ flex: 1 }}>
                        Waiting for host…
                      </Text>
                    )}
                  </Group>
                </Stack>
              );
            })()}
          </motion.div>
        )}

        {/* ── PLAYING / PREP ─────────────────────────────────────────────── */}
        {(gamePhase === 'playing' || gamePhase === 'prep') && (
          <motion.div
            key="playing"
            variants={fade}
            initial="hidden"
            animate="visible"
            exit="hidden"
            transition={fadeTrans}
          >
            <Stack gap="sm" w="100%" maw={900}>
              {/* Prep modal */}
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

              {/* Header */}
              <Group justify="space-between" align="center" gap="xs" wrap="wrap">
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
                    {formatTime(timeLeftMs)}{room.timerMode === 'draw' && timerPaused}
                  </Text>
                </Group>
              </Group>

              {/* Word reminder + done button */}
              <Group justify="space-between" align="center">
                <Group gap="xs">
                  {isImposter ? (
                    <Badge color="red" variant="light">Imposter — blend in!</Badge>
                  ) : (
                    <Badge color="teal" variant="light" style={{ whiteSpace: 'normal', height: 'auto', textAlign: 'center' }}>Word: {word}</Badge>
                  )}
                  {isMyTurn && <Badge color="violet" variant="filled">Draw now!</Badge>}
                </Group>
                {isMyTurn && (
                  <Button size="xs" variant="subtle" color="gray" onClick={handleSkipTurn}>
                    Done drawing
                  </Button>
                )}
              </Group>

              <Divider />

              {/* Canvas + turn order */}
              <Group align="flex-start" wrap={isMobile ? 'wrap' : 'nowrap'} gap="sm">
                {/* Canvas */}
                <Box
                  style={{
                    flex: 1,
                    minWidth: 0,
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
                     onDrawStart={isMyTurn && room.timerMode === 'draw' ? () => socketRef.current?.send(JSON.stringify({ type: 'draw_start' })) : undefined}
                     onDrawStop={isMyTurn && room.timerMode === 'draw' ? () => socketRef.current?.send(JSON.stringify({ type: 'draw_pause' })) : undefined}
                   />
                </Box>

                {/* Turn order */}
                <Paper
                  withBorder
                  p="sm"
                  radius="md"
                  w={isMobile ? '100%' : 140}
                  style={{ flexShrink: 0 }}
                >
                  <Stack gap={6}>
                    <Text size="xs" tt="uppercase" fw={700} c="dimmed">Turn order</Text>
                    {room.turnOrder.map((pid, idx) => {
                      const p = room.players.find((pl) => pl.id === pid);
                      if (!p) return null;
                      const isCurrent = idx === turnState.turnIndex;
                      return (
                        <Group key={pid} gap={4} wrap="nowrap">
                          <Text size="xs" c="dimmed" w={14} style={{ flexShrink: 0 }}>
                            {idx + 1}.
                          </Text>
                          <Text
                            size="xs"
                            fw={isCurrent ? 700 : 400}
                            c={isCurrent ? 'violet' : undefined}
                            style={{
                              flex: 1,
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                            }}
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

              {/* Toolbar */}
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
          </motion.div>
        )}

      </AnimatePresence>

      {process.env.NODE_ENV === 'development' && (
        <DevPanel
          currentPhase={gamePhase}
          room={room}
          word={word}
          playerId={playerId}
          onPhase={(phase) => {
            desiredPhaseRef.current = phase;
            setGamePhase(phase);
          }}
          setVotingResults={setVotingResults}
          setRevealAcknowledged={setRevealAcknowledged}
          setRevealReadyCount={setRevealReadyCount}
          setMyVote={setMyVote}
        />
      )}
    </>
  );
}
