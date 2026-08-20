import { describe, expect, test } from "bun:test";
import { couldBecomeSpuriousNetworkDeath, extractAssistantText, isSpuriousNetworkDeath } from "../src/fingerprint.ts";

describe("spurious Cursor ACP network death fingerprint", () => {
  test("matches the Cursor ACP adapter Error: ConnectError death-as-text class", () => {
    expect(isSpuriousNetworkDeath("\n\nError: ConnectError: [unavailable] HTTP/2 stream cancelled (NGHTTP2_CANCEL)")).toBe(true);
    expect(isSpuriousNetworkDeath("Error: ConnectError: [aborted] aborted")).toBe(true);
    expect(isSpuriousNetworkDeath("Error: ConnectError: [unavailable] getaddrinfo ENOTFOUND api2.cursor.sh")).toBe(true);
    expect(isSpuriousNetworkDeath("Error: ConnectError: [unavailable] ECONNRESET")).toBe(true);
    expect(isSpuriousNetworkDeath("Error: HTTP/2 stream reset")).toBe(true);
    expect(isSpuriousNetworkDeath("Something went wrong communicating with the server. Please try again.")).toBe(true);
    expect(isSpuriousNetworkDeath("ConnectError: [unavailable] getaddrinfo ENOTFOUND api2.cursor.sh")).toBe(true);
    expect(isSpuriousNetworkDeath("HTTP/2 stream was reset (NGHTTP2_CANCEL)")).toBe(true);
  });

  test("does not match genuine app-under-debug HTTP failures or unrelated errors", () => {
    expect(isSpuriousNetworkDeath("The HTTP request failed in the app you are debugging because /health returned 500.")).toBe(false);
    expect(isSpuriousNetworkDeath("Error: file not found: src/http2.ts")).toBe(false);
    expect(isSpuriousNetworkDeath("Please sign in to continue")).toBe(false);
    expect(isSpuriousNetworkDeath("\n\nError: [unauthenticated] Backend rejected authentication. Verify this is a User API Key")).toBe(false);
    expect(isSpuriousNetworkDeath("Upgrade your plan to continue")).toBe(false);
    expect(isSpuriousNetworkDeath("")).toBe(false);
    expect(isSpuriousNetworkDeath(`Here is the HTTP/2 CANCEL handling I added to the product:\n\n${"x".repeat(200)}`)).toBe(false);
    expect(isSpuriousNetworkDeath("```\nNGHTTP2_CANCEL\n```\n" + "notes\n".repeat(40))).toBe(false);
    expect(isSpuriousNetworkDeath("The API threw Error: ConnectError: [unavailable] ECONNRESET")).toBe(false);
    expect(isSpuriousNetworkDeath("Retry the webhook.")).toBe(false);
  });

  test("does not treat thought-shaped quotes as visible assistant death", () => {
    expect(extractAssistantText({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "s",
        update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Error: ConnectError: [unavailable] ECONNRESET" } },
      },
    })).toBe("");
  });

  test("keeps buffering only while text could still become a death dump", () => {
    expect(couldBecomeSpuriousNetworkDeath("")).toBe(true);
    expect(couldBecomeSpuriousNetworkDeath("E")).toBe(true);
    expect(couldBecomeSpuriousNetworkDeath("Error:")).toBe(true);
    expect(couldBecomeSpuriousNetworkDeath("Error: Con")).toBe(true);
    expect(couldBecomeSpuriousNetworkDeath("hello from cursor")).toBe(false);
    expect(couldBecomeSpuriousNetworkDeath("Retry the webhook.")).toBe(false);
    expect(couldBecomeSpuriousNetworkDeath("Error: file not found: src/http2.ts")).toBe(false);
  });

  test("extracts ACP agent_message_chunk text", () => {
    expect(extractAssistantText({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "s",
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Error: boom" } },
      },
    })).toBe("Error: boom");
  });
});
