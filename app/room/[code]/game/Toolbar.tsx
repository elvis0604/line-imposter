'use client';

import { Tooltip, Group, Box, Stack } from '@mantine/core';

const COLORS = [
  { label: 'Black', value: '#000000' },
  { label: 'Dark gray', value: '#6b7280' },
  { label: 'Red', value: '#ef4444' },
  { label: 'Orange', value: '#f97316' },
  { label: 'Yellow', value: '#eab308' },
  { label: 'Green', value: '#22c55e' },
  { label: 'Blue', value: '#3b82f6' },
  { label: 'Purple', value: '#a855f7' },
  { label: 'Pink', value: '#ec4899' },
  { label: 'Brown', value: '#92400e' },
];

const LINE_WIDTHS: { label: string; value: number; displayHeight: number }[] = [
  { label: 'Thin', value: 3, displayHeight: 2 },
  { label: 'Medium', value: 8, displayHeight: 5 },
  { label: 'Thick', value: 20, displayHeight: 10 },
];

interface Props {
  color: string;
  lineWidth: number;
  tool: 'pen' | 'eraser';
  onColorChange: (color: string) => void;
  onLineWidthChange: (lw: number) => void;
  onToolChange: (tool: 'pen' | 'eraser') => void;
  /** When disabled, the toolbar is dimmed and non-interactive. */
  disabled?: boolean;
}

export default function Toolbar({
  color,
  lineWidth,
  tool,
  onColorChange,
  onLineWidthChange,
  onToolChange,
  disabled,
}: Props) {
  const isActive = !disabled;

  return (
    <Stack
      gap="xs"
      style={{
        opacity: disabled ? 0.45 : 1,
        pointerEvents: disabled ? 'none' : 'auto',
        transition: 'opacity 0.2s',
      }}
    >
      {/* Color swatches */}
      <Group gap={6} wrap="wrap">
        {COLORS.map((c) => {
          const selected = tool === 'pen' && color === c.value;
          return (
            <Tooltip key={c.value} label={c.label} withArrow position="top">
              <Box
                component="button"
                aria-label={c.label}
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: '50%',
                  background: c.value,
                  border: selected
                    ? '3px solid var(--mantine-color-violet-5)'
                    : '2px solid var(--mantine-color-gray-3)',
                  boxShadow: selected ? '0 0 0 2px var(--mantine-color-violet-2)' : 'none',
                  cursor: isActive ? 'pointer' : 'default',
                  padding: 0,
                  flexShrink: 0,
                }}
                onClick={() => {
                  onColorChange(c.value);
                  onToolChange('pen');
                }}
              />
            </Tooltip>
          );
        })}
      </Group>

      {/* Line widths + eraser */}
      <Group gap="xs">
        {LINE_WIDTHS.map((lw) => {
          const selected = tool === 'pen' && lineWidth === lw.value;
          return (
            <Tooltip key={lw.value} label={lw.label} withArrow position="top">
              <Box
                component="button"
                aria-label={lw.label}
                style={{
                  width: 44,
                  height: 36,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  borderRadius: 8,
                  border: selected
                    ? '2px solid var(--mantine-color-violet-5)'
                    : '1px solid var(--mantine-color-gray-3)',
                  background: selected
                    ? 'var(--mantine-color-violet-0)'
                    : 'transparent',
                  cursor: isActive ? 'pointer' : 'default',
                  padding: 0,
                }}
                onClick={() => {
                  onLineWidthChange(lw.value);
                  onToolChange('pen');
                }}
              >
                <Box
                  style={{
                    width: 24,
                    height: lw.displayHeight,
                    background: '#000',
                    borderRadius: lw.displayHeight,
                  }}
                />
              </Box>
            </Tooltip>
          );
        })}

        {/* Eraser */}
        <Tooltip label="Eraser" withArrow position="top">
          <Box
            component="button"
            aria-label="Eraser"
            style={{
              width: 44,
              height: 36,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: 8,
              border: tool === 'eraser'
                ? '2px solid var(--mantine-color-violet-5)'
                : '1px solid var(--mantine-color-gray-3)',
              background: tool === 'eraser'
                ? 'var(--mantine-color-violet-0)'
                : 'transparent',
              cursor: isActive ? 'pointer' : 'default',
              padding: 0,
              fontSize: 18,
              lineHeight: 1,
            }}
            onClick={() => onToolChange('eraser')}
          >
            ⌫
          </Box>
        </Tooltip>
      </Group>
    </Stack>
  );
}
