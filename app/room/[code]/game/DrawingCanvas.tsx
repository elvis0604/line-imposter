'use client';

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useCallback,
} from 'react';
import type { BroadcastedDrawEvent, DrawEvent } from '@/lib/types';

/** Fixed internal canvas resolution — all normalized coords map into this space. */
const CANVAS_W = 800;
const CANVAS_H = 600;

/** Eraser is always this wide regardless of the selected pen line width. */
const ERASER_LINE_WIDTH = 32;

export interface DrawingCanvasHandle {
  /** Replay a single stroke event from another player. */
  replayEvent: (event: BroadcastedDrawEvent) => void;
  /** Clear and replay all stored events (used on reconnect). */
  loadHistory: (events: BroadcastedDrawEvent[]) => void;
  /** Wipe the canvas back to white (new turn). */
  clear: () => void;
}

export interface DrawingCanvasProps {
  /** Only allow pointer input when it is this client's turn. */
  isDrawingAllowed: boolean;
  color: string;
  lineWidth: number;
  tool: 'pen' | 'eraser';
  /** Called whenever the local user draws a segment. */
  onDraw: (event: DrawEvent) => void;
}

/** Render a single stroke segment onto the 2D context. */
function renderStroke(ctx: CanvasRenderingContext2D, event: DrawEvent) {
  ctx.save();
  ctx.strokeStyle = event.tool === 'eraser' ? '#ffffff' : event.color;
  ctx.lineWidth = event.tool === 'eraser' ? ERASER_LINE_WIDTH : event.lineWidth;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(event.x0 * CANVAS_W, event.y0 * CANVAS_H);
  ctx.lineTo(event.x1 * CANVAS_W, event.y1 * CANVAS_H);
  ctx.stroke();
  ctx.restore();
}

const DrawingCanvas = forwardRef<DrawingCanvasHandle, DrawingCanvasProps>(
  function DrawingCanvas({ isDrawingAllowed, color, lineWidth, tool, onDraw }, ref) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const isDrawing = useRef(false);
    const lastPos = useRef<{ x: number; y: number } | null>(null);

    // Set fixed buffer size and fill white background once on mount
    useEffect(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      canvas.width = CANVAS_W;
      canvas.height = CANVAS_H;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
    }, []);

    useImperativeHandle(ref, () => ({
      replayEvent(event: BroadcastedDrawEvent) {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        renderStroke(ctx, event);
      },

      loadHistory(events: BroadcastedDrawEvent[]) {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
        for (const event of events) {
          renderStroke(ctx, event);
        }
      },

      clear() {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
      },
    }));

    /** Convert a pointer event to normalized [0,1] canvas coordinates. */
    const getNormalizedPos = useCallback(
      (e: React.PointerEvent<HTMLCanvasElement>) => {
        const rect = e.currentTarget.getBoundingClientRect();
        return {
          x: (e.clientX - rect.left) / rect.width,
          y: (e.clientY - rect.top) / rect.height,
        };
      },
      [],
    );

    const handlePointerDown = useCallback(
      (e: React.PointerEvent<HTMLCanvasElement>) => {
        if (!isDrawingAllowed) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        isDrawing.current = true;
        lastPos.current = getNormalizedPos(e);
      },
      [isDrawingAllowed, getNormalizedPos],
    );

    // Cancel any in-progress stroke the moment it's no longer our turn.
    // Without this, isDrawing.current stays true across a turn transition and
    // the next pointerMove (while still held) would still draw.
    useEffect(() => {
      if (!isDrawingAllowed) {
        isDrawing.current = false;
        lastPos.current = null;
      }
    }, [isDrawingAllowed]);

    const handlePointerMove = useCallback(
      (e: React.PointerEvent<HTMLCanvasElement>) => {
        if (!isDrawingAllowed || !isDrawing.current || !lastPos.current) return;
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        const pos = getNormalizedPos(e);
        const event: DrawEvent = {
          x0: lastPos.current.x,
          y0: lastPos.current.y,
          x1: pos.x,
          y1: pos.y,
          color,
          lineWidth,
          tool,
        };

        renderStroke(ctx, event);
        onDraw(event);
        lastPos.current = pos;
      },
      [isDrawingAllowed, color, lineWidth, tool, getNormalizedPos, onDraw],
    );

    const handlePointerUp = useCallback(
      (e: React.PointerEvent<HTMLCanvasElement>) => {
        if (!isDrawing.current) return;
        isDrawing.current = false;
        lastPos.current = null;
        e.currentTarget.releasePointerCapture(e.pointerId);
      },
      [],
    );

    return (
      <canvas
        ref={canvasRef}
        style={{
          display: 'block',
          width: '100%',
          height: 'auto',
          cursor: isDrawingAllowed
            ? tool === 'eraser'
              ? 'cell'
              : 'crosshair'
            : 'default',
          touchAction: 'none', // prevent scroll interference on mobile
        }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerUp}
      />
    );
  },
);

export default DrawingCanvas;
