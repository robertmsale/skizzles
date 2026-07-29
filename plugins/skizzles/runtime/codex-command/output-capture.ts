import { writeSync } from "node:fs";

export type CaptureState = {
  observedBytes: number;
  storedBytes: number;
  truncated: boolean;
  finished: boolean;
};

type StreamName = "stdout" | "stderr";

export function initialCaptureState(): CaptureState {
  return {
    observedBytes: 0,
    storedBytes: 0,
    truncated: false,
    finished: false,
  };
}

export function captureOutput(
  stream: ReadableStream<Uint8Array> | null,
  streamName: StreamName,
  artifact: number | undefined,
  maximumBytes: number,
  forward: boolean,
  state: CaptureState,
): { done: Promise<void>; cancel: () => Promise<void> } {
  if (!stream) {
    state.finished = true;
    return { done: Promise.resolve(), cancel: async () => {} };
  }
  const reader = stream.getReader();
  const done = (async () => {
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        const chunk = next.value;
        state.observedBytes += chunk.length;
        if (forward) {
          (streamName === "stdout" ? process.stdout : process.stderr).write(chunk);
        }
        if (artifact !== undefined) {
          const remaining = maximumBytes - state.storedBytes;
          if (remaining > 0) {
            const stored = chunk.subarray(0, remaining);
            try {
              const written = writeSync(artifact, stored);
              state.storedBytes += written;
              if (written !== chunk.length) state.truncated = true;
            } catch {
              state.truncated = true;
            }
          } else {
            state.truncated = true;
          }
        }
      }
    } catch {
      state.truncated = true;
    } finally {
      state.finished = true;
      reader.releaseLock();
    }
  })();
  return { done, cancel: () => reader.cancel().catch(() => {}) };
}

export function printCapturedOutput(label: string, content: string): void {
  if (!content) return;
  process.stdout.write(`[codex-command] ${label}:\n${content}`);
  if (!content.endsWith("\n")) process.stdout.write("\n");
}
