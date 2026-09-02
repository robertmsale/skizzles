import { createServer, type Server, type Socket } from "node:net";
import { MAX_REQUEST_BYTES, ServiceError, isRecord, type DaemonResponse } from "./protocol.ts";
import { executeCommand } from "./commands.ts";
import type { OmpManager } from "./manager.ts";

export type LocalServer = Server & { closeActiveConnections: () => void };

export function createLocalServer(manager: OmpManager): LocalServer {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.setEncoding("utf8");
    let buffer = "";
    let work = Promise.resolve();
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, "utf8") > MAX_REQUEST_BYTES) {
        socket.end(`${JSON.stringify(failure(new ServiceError("request exceeds 1 MiB", "too_large", 413)))}\n`);
        return;
      }
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        work = work.then(async () => {
          let response: DaemonResponse;
          try {
            let parsed: unknown;
            try { parsed = JSON.parse(line); }
            catch { throw new ServiceError("command must be valid JSON", "invalid_request"); }
            if (!isRecord(parsed)) throw new ServiceError("command must be an object", "invalid_request");
            response = { ok: true, result: await executeCommand(parsed, manager) };
          } catch (error) { response = failure(error); }
          socket.write(`${JSON.stringify(response)}\n`);
        });
      }
    });
    socket.on("error", () => undefined);
  });
  return Object.assign(server, {
    closeActiveConnections: () => { for (const socket of sockets) socket.destroy(); },
  });
}

export function failure(error: unknown): Extract<DaemonResponse, { ok: false }> {
  if (error instanceof ServiceError) return { ok: false, error: error.message, code: error.code };
  return { ok: false, error: error instanceof Error ? error.message : String(error), code: "internal_error" };
}
