'use client';

import { useEffect, useRef, useState } from 'react';

const RESET_DELAY_MS = 2_000;

async function writeToClipboard(value: string) {
  if (navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(value);
      return;
    } catch {
      // Fall back for local or restricted browser contexts.
    }
  }

  const textarea = document.createElement('textarea');
  textarea.value = value;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.append(textarea);
  textarea.select();
  let copied;
  try {
    copied = document.execCommand('copy');
  } finally {
    textarea.remove();
  }
  if (!copied) throw new Error('Clipboard copy is unavailable.');
}

export function CopyCommand({ command }: { command: string }) {
  const [status, setStatus] = useState<'idle' | 'copied' | 'failed'>('idle');
  const resetTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(
    () => () => {
      if (resetTimer.current) clearTimeout(resetTimer.current);
    },
    [],
  );

  async function copy() {
    try {
      await writeToClipboard(command);
      setStatus('copied');
    } catch {
      setStatus('failed');
    }
    if (resetTimer.current) clearTimeout(resetTimer.current);
    resetTimer.current = setTimeout(() => setStatus('idle'), RESET_DELAY_MS);
  }

  return (
    <div className="hero-command">
      <span aria-hidden="true">$</span>
      <code>{command}</code>
      <button
        aria-label={`Copy ${command}`}
        className="hero-command-copy"
        onClick={() => void copy()}
        type="button"
      >
        {status === 'copied' ? 'Copied' : status === 'failed' ? 'Retry' : 'Copy'}
      </button>
      <span
        aria-atomic="true"
        aria-live="polite"
        className="sr-only"
        role="status"
      >
        {status === 'copied'
          ? 'Command copied to clipboard.'
          : status === 'failed'
            ? 'Copy failed. Try again.'
            : ''}
      </span>
    </div>
  );
}
