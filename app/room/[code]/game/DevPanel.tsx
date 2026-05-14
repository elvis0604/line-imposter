'use client';

/**
 * DevPanel — floating phase-switcher, only rendered in development.
 * Lets you jump to any game phase without needing a full multiplayer session.
 */

import { useState } from 'react';
import { ActionIcon, Badge, Box, Button, Group, Stack, Text } from '@mantine/core';
import type { Room, VotingResults } from '@/lib/types';

type GamePhase = 'reveal' | 'prep' | 'playing' | 'guessing' | 'voting' | 'results';

interface DevPanelProps {
  currentPhase: GamePhase;
  room: Room;
  word: string | null;
  playerId: string;
  onPhase: (phase: GamePhase) => void;
  setVotingResults: (r: VotingResults | null) => void;
  setRevealAcknowledged: (v: boolean) => void;
  setRevealReadyCount: (n: number) => void;
  setMyVote: (v: string | null) => void;
}

const PHASES: { value: GamePhase; label: string }[] = [
  { value: 'reveal', label: 'Reveal' },
  { value: 'prep', label: 'Prep' },
  { value: 'playing', label: 'Drawing' },
  { value: 'guessing', label: 'Guessing' },
  { value: 'voting', label: 'Voting' },
  { value: 'results', label: 'Results' },
];

export default function DevPanel({
  currentPhase,
  room,
  word,
  playerId,
  onPhase,
  setVotingResults,
  setRevealAcknowledged,
  setRevealReadyCount,
  setMyVote,
}: DevPanelProps) {
  const [collapsed, setCollapsed] = useState(false);

  function jumpTo(phase: GamePhase) {
    // Reset phase-specific state before switching.
    if (phase === 'reveal') {
      setRevealAcknowledged(false);
      setRevealReadyCount(0);
    }
    if (phase === 'voting') {
      setMyVote(null);
    }
    if (phase === 'results') {
      // Build a plausible mock result so the results screen renders.
      const imposter = room.players.find((p) => p.id !== playerId) ?? room.players[0];
      const tally: Record<string, number> = {};
      room.players.forEach((p, i) => { tally[p.id] = i === 0 ? 2 : 1; });
      setVotingResults({
        tally,
        imposterId: imposter?.id ?? '',
        word: 'SUPERLONG WORD',
        artistsWin: true,
      });
    }
    onPhase(phase);
  }

  return (
    <Box
      style={{
        position: 'fixed',
        bottom: 16,
        right: 16,
        zIndex: 9999,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-end',
        gap: 6,
      }}
    >
      {!collapsed && (
        <Stack
          gap={6}
          p="xs"
          style={{
            background: 'rgba(0,0,0,0.85)',
            borderRadius: 10,
            border: '1px solid rgba(255,255,255,0.12)',
            backdropFilter: 'blur(4px)',
          }}
        >
          <Text size="xs" fw={700} c="dimmed" tt="uppercase" style={{ letterSpacing: 1 }}>
            Dev — phase jump
          </Text>
          <Group gap={4}>
            {PHASES.map(({ value, label }) => (
              <Button
                key={value}
                size="compact-xs"
                variant={currentPhase === value ? 'filled' : 'subtle'}
                color={currentPhase === value ? 'violet' : 'gray'}
                onClick={() => jumpTo(value)}
              >
                {label}
              </Button>
            ))}
          </Group>
          <Group gap={4} justify="space-between">
            <Badge size="xs" color="violet" variant="dot">
              {currentPhase}
            </Badge>
            <Text size="xs" c="dimmed">{room.players.length} player{room.players.length !== 1 ? 's' : ''}</Text>
          </Group>
        </Stack>
      )}
      <ActionIcon
        size="sm"
        variant="filled"
        color="violet"
        radius="xl"
        title={collapsed ? 'Show dev panel' : 'Hide dev panel'}
        onClick={() => setCollapsed((c) => !c)}
        style={{ opacity: 0.8 }}
      >
        <Text size="xs">{collapsed ? '⚙' : '×'}</Text>
      </ActionIcon>
    </Box>
  );
}
