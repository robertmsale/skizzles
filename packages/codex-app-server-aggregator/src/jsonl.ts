import { parseRpcMessage, type RpcMessage } from "./protocol.ts";

export interface MessageSink {
  send(message: RpcMessage): Promise<void>;
}

export async function* readJsonLines(input: ReadableStream<Uint8Array>): AsyncGenerator<RpcMessage> {
  const reader = input.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffered += decoder.decode(value, { stream: true });
    let newline = buffered.indexOf("\n");
    while (newline >= 0) {
      const line = buffered.slice(0, newline).replace(/\r$/, "");
      buffered = buffered.slice(newline + 1);
      if (line.trim()) yield parseRpcMessage(JSON.parse(line));
      newline = buffered.indexOf("\n");
    }
  }
  buffered += decoder.decode();
  if (buffered.trim()) yield parseRpcMessage(JSON.parse(buffered));
}

export class SerialMessageSink implements MessageSink {
  private tail = Promise.resolve();

  constructor(private readonly write: (line: string) => void | Promise<void>) {}

  send(message: RpcMessage): Promise<void> {
    const line = `${JSON.stringify(message)}\n`;
    const next = this.tail.then(() => this.write(line));
    this.tail = next.catch(() => undefined);
    return next;
  }
}
