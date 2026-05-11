'use client';

/**
 * DevNav — global dev-only floating button (top-right on every page).
 * Provides a one-click "Quick Start" that creates a ready-to-test game
 * without going through the full create → join → start flow.
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ActionIcon, Box, Button, Loader, Stack, Text } from '@mantine/core';

export default function DevNav() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function quickStart() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/dev/quick-start', { method: 'POST' });
      if (!res.ok) throw new Error(await res.text());
      const { code } = await res.json();
      router.push(`/room/${code}/game`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed');
      setLoading(false);
    }
  }

  return (
    <Box
      style={{
        position: 'fixed',
        top: 12,
        right: 12,
        zIndex: 9999,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-end',
        gap: 6,
      }}
    >
      {open && (
        <Stack
          gap={6}
          p="xs"
          style={{
            background: 'rgba(0,0,0,0.85)',
            borderRadius: 10,
            border: '1px solid rgba(255,255,255,0.12)',
            backdropFilter: 'blur(4px)',
            minWidth: 160,
          }}
        >
          <Text size="xs" fw={700} c="dimmed" tt="uppercase" style={{ letterSpacing: 1 }}>
            Dev tools
          </Text>
          <Button
            size="compact-sm"
            color="violet"
            variant="filled"
            fullWidth
            onClick={quickStart}
            disabled={loading}
            leftSection={loading ? <Loader size={12} color="white" /> : undefined}
          >
            {loading ? 'Starting…' : 'Quick Start'}
          </Button>
          {error && (
            <Text size="xs" c="red">{error}</Text>
          )}
        </Stack>
      )}
      <ActionIcon
        size="sm"
        variant="filled"
        color="violet"
        radius="xl"
        title={open ? 'Close dev tools' : 'Open dev tools'}
        onClick={() => setOpen((o) => !o)}
        style={{ opacity: 0.75 }}
      >
        <Text size="xs" lh={1}>{open ? '×' : '⚙'}</Text>
      </ActionIcon>
    </Box>
  );
}
