'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import {
  TextInput,
  Button,
  Stack,
  Title,
  Text,
  Divider,
  Paper,
  Group,
  Tabs,
  Alert,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';

function getOrCreatePlayerId(): string {
  if (typeof window === 'undefined') return '';
  let id = localStorage.getItem('lc_pid');
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem('lc_pid', id);
  }
  return id;
}

export default function HomeForm() {
  const router = useRouter();
  const [playerId, setPlayerId] = useState('');
  const [activeTab, setActiveTab] = useState<string | null>('create');

  useEffect(() => {
    setPlayerId(getOrCreatePlayerId());
  }, []);

  const createForm = useForm({
    initialValues: { playerName: '' },
    validate: {
      playerName: (v) =>
        v.trim().length < 1
          ? 'Enter your name'
          : v.trim().length > 20
            ? 'Max 20 characters'
            : null,
    },
  });

  const joinForm = useForm({
    initialValues: { playerName: '', code: '' },
    validate: {
      playerName: (v) =>
        v.trim().length < 1
          ? 'Enter your name'
          : v.trim().length > 20
            ? 'Max 20 characters'
            : null,
      code: (v) =>
        v.trim().length !== 4 ? 'Room code is 4 characters' : null,
    },
  });

  async function handleCreate(values: typeof createForm.values) {
    if (!playerId) return;
    const res = await fetch('/api/rooms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playerName: values.playerName.trim(), playerId }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Unknown error' }));
      notifications.show({ color: 'red', title: 'Error', message: err.error });
      return;
    }
    const { code } = await res.json();
    localStorage.setItem('lc_pname', values.playerName.trim());
    router.push(`/room/${code}`);
  }

  async function handleJoin(values: typeof joinForm.values) {
    if (!playerId) return;
    const code = values.code.trim().toUpperCase();
    const res = await fetch(`/api/rooms/${code}/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playerName: values.playerName.trim(), playerId }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Unknown error' }));
      notifications.show({ color: 'red', title: 'Could not join', message: err.error });
      return;
    }
    localStorage.setItem('lc_pname', values.playerName.trim());
    router.push(`/room/${code}`);
  }

  return (
    <Paper withBorder p="xl" radius="md" w="100%" maw={400}>
      <Stack gap="md">
        <Stack gap={4} align="center">
          <Title order={2}>Line Chaser</Title>
          <Text size="sm" c="dimmed" ta="center">
            Drawing &amp; deception — find the imposter
          </Text>
        </Stack>

        <Divider />

        <Tabs value={activeTab} onChange={setActiveTab}>
          <Tabs.List grow>
            <Tabs.Tab value="create">Create room</Tabs.Tab>
            <Tabs.Tab value="join">Join room</Tabs.Tab>
          </Tabs.List>

          <Tabs.Panel value="create" pt="md">
            <form onSubmit={createForm.onSubmit(handleCreate)}>
              <Stack gap="sm">
                <TextInput
                  label="Your name"
                  placeholder="e.g. Picasso"
                  maxLength={20}
                  {...createForm.getInputProps('playerName')}
                />
                <Button type="submit" fullWidth disabled={!playerId}>
                  Create room
                </Button>
              </Stack>
            </form>
          </Tabs.Panel>

          <Tabs.Panel value="join" pt="md">
            <form onSubmit={joinForm.onSubmit(handleJoin)}>
              <Stack gap="sm">
                <TextInput
                  label="Your name"
                  placeholder="e.g. Picasso"
                  maxLength={20}
                  {...joinForm.getInputProps('playerName')}
                />
                <TextInput
                  label="Room code"
                  placeholder="ABCD"
                  maxLength={4}
                  styles={{ input: { textTransform: 'uppercase', letterSpacing: '0.2em', fontWeight: 700 } }}
                  {...joinForm.getInputProps('code')}
                  onChange={(e) =>
                    joinForm.setFieldValue('code', e.currentTarget.value.toUpperCase())
                  }
                />
                <Button type="submit" fullWidth disabled={!playerId}>
                  Join room
                </Button>
              </Stack>
            </form>
          </Tabs.Panel>
        </Tabs>

        {!playerId && (
          <Alert color="yellow" title="Loading…" variant="light">
            Initialising player session…
          </Alert>
        )}
      </Stack>
    </Paper>
  );
}
