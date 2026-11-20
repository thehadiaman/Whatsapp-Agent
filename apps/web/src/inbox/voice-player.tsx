'use client';

import { useRef, useState } from 'react';

function clock(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return '–:––';
  const seconds = Math.max(0, Math.round(ms / 1000));
  return `${String(Math.floor(seconds / 60))}:${String(seconds % 60).padStart(2, '0')}`;
}

/**
 * A voice note's player, drawn like the rest of the counter: a play button,
 * the time in mono and a ruled progress line. The browser's own player looks
 * different in every browser and cannot show the length before loading.
 */
export function VoicePlayer({
  src,
  durationMs,
  label,
}: {
  src: string;
  durationMs: number | null;
  /** What is playing, for screen readers: "voice note from the customer". */
  label: string;
}) {
  const audio = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [length, setLength] = useState<number | null>(durationMs);
  const [failed, setFailed] = useState(false);

  const toggle = () => {
    const element = audio.current;
    if (!element) return;
    if (element.paused) {
      element.play().catch(() => {
        setFailed(true);
      });
    } else {
      element.pause();
    }
  };

  if (failed) {
    return (
      <p className="mono text-meta text-graphite">
        This browser can&apos;t play it.{' '}
        <a href={src} download className="font-semibold underline">
          Download the voice note
        </a>
      </p>
    );
  }

  const progress = length ? Math.min(100, (position / length) * 100) : 0;
  return (
    <div className="flex w-full max-w-60 items-center gap-2">
      <button
        type="button"
        className="button button-quiet h-8 w-8 shrink-0 justify-center p-0"
        aria-label={`${playing ? 'Pause' : 'Play'} ${label}`}
        onClick={toggle}
      >
        <svg aria-hidden viewBox="0 0 12 12" className="h-3 w-3 fill-current">
          {playing ? <path d="M2 1h3v10H2zM7 1h3v10H7z" /> : <path d="M2.5 1v10l8.5-5z" />}
        </svg>
      </button>
      <span
        className="mono shrink-0 text-meta"
        aria-label={`${clock(position)} of ${clock(length)}`}
      >
        {clock(position)} / {clock(length)}
      </span>
      <span aria-hidden className="relative h-px min-w-6 flex-1 bg-rule-strong">
        <span
          className="absolute -top-px left-0 h-[3px] bg-ink"
          style={{ width: `${String(progress)}%` }}
        />
      </span>
      <audio
        ref={audio}
        src={src}
        preload="none"
        onPlay={() => {
          setPlaying(true);
        }}
        onPause={() => {
          setPlaying(false);
        }}
        onEnded={() => {
          setPlaying(false);
          setPosition(0);
        }}
        onTimeUpdate={(event) => {
          setPosition(event.currentTarget.currentTime * 1000);
        }}
        onLoadedMetadata={(event) => {
          const seconds = event.currentTarget.duration;
          if (Number.isFinite(seconds)) setLength(seconds * 1000);
        }}
        onError={() => {
          setFailed(true);
        }}
      />
    </div>
  );
}
