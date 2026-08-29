import type { AppServerAggregator } from "./aggregator.ts";
import type { MessageSink } from "./jsonl.ts";
import {
  errorOutcome,
  idKey,
  isNotification,
  isRequest,
  isResponse,
  response,
  type RpcId,
  type RpcMessage,
  type RpcNotification,
  type RpcOutcome,
  type RpcRequest,
} from "./protocol.ts";

const DEFAULT_EVENT_LIMIT = 100;
const MAX_EVENT_LIMIT = 500;
const MAX_RETAINED_EVENTS = 2_000;
const MAX_QUEUED_CLIENT_MESSAGES = 256;
const MAX_QUEUED_CLIENT_BYTES = 16 * 1024 * 1024;

const DEFAULT_INITIALIZE_PARAMS = {
  clientInfo: {
    name: "skizzles-rest",
    title: "Skizzles REST API",
    version: "0.1.0",
  },
  capabilities: {
    experimentalApi: true,
    requestAttestation: false,
  },
};

type PendingCall = (outcome: RpcOutcome) => void;

type ActiveClient = {
  delivery: ClientDelivery;
  disconnect: () => void;
  initialized: boolean;
  initializing: boolean;
  optOutNotifications: Set<string>;
  queuedNotifications: RpcNotification[];
  queuedNotificationBytes: number;
};

export type EventRecord = {
  cursor: number;
  event: RpcNotification;
};

export type EventPage = {
  data: EventRecord[];
  nextCursor: number;
  oldestCursor: number;
  streamId: string;
  gap: boolean;
  restarted: boolean;
};

export class AggregatorBridge implements MessageSink {
  private aggregator: AppServerAggregator | undefined;
  private activeClient: ActiveClient | undefined;
  private readonly pendingCalls = new Map<string, PendingCall>();
  private readonly serverRequests = new Map<string, RpcRequest>();
  private readonly events: EventRecord[] = [];
  private readonly streamId = crypto.randomUUID();
  private nextEventCursor = 1;
  private initialization: Promise<RpcOutcome> | undefined;
  private initializeOutcome: RpcOutcome | undefined;
  private initialized = false;

  constructor(private readonly log: (message: string) => void = () => undefined) {}

  bind(aggregator: AppServerAggregator): void {
    if (this.aggregator) throw new Error("aggregator bridge is already bound");
    this.aggregator = aggregator;
  }

  attachClient(output: MessageSink, disconnect: () => void = () => undefined): AggregatorClientSession {
    if (this.activeClient) throw new Error("aggregator already has an active client");
    let client!: ActiveClient;
    const delivery = new ClientDelivery(output, (reason) => this.disconnectClient(client, reason));
    client = {
      delivery,
      disconnect,
      initialized: false,
      initializing: false,
      optOutNotifications: new Set(),
      queuedNotifications: [],
      queuedNotificationBytes: 0,
    };
    this.activeClient = client;
    return new AggregatorClientSession(this, client);
  }

  detachClient(client: ActiveClient): void {
    if (this.activeClient === client) this.activeClient = undefined;
    client.delivery.close();
    client.queuedNotifications.length = 0;
    client.queuedNotificationBytes = 0;
  }

  async call(method: string, params?: unknown): Promise<RpcOutcome> {
    if (!method.startsWith("skizzles/project/")) {
      const initialized = await this.ensureInitialized();
      if ("error" in initialized) return initialized;
      await this.ensureInitializedNotification();
    }
    return this.callCore(method, params);
  }

  eventPage(after = 0, requestedLimit = DEFAULT_EVENT_LIMIT, expectedStreamId?: string): EventPage {
    const limit = Math.min(Math.max(Math.trunc(requestedLimit), 1), MAX_EVENT_LIMIT);
    const oldestCursor = this.events[0]?.cursor ?? this.nextEventCursor;
    const currentCursor = this.nextEventCursor - 1;
    const restarted = expectedStreamId !== undefined && expectedStreamId !== this.streamId;
    const gap = restarted || after < oldestCursor - 1 || after > currentCursor;
    const data = gap ? [] : this.events.filter((record) => record.cursor > after).slice(0, limit);
    return {
      data: structuredClone(data),
      nextCursor: data.at(-1)?.cursor ?? Math.max(after, this.nextEventCursor - 1),
      oldestCursor,
      streamId: this.streamId,
      gap,
      restarted,
    };
  }

  pendingServerRequests(): RpcRequest[] {
    return [...this.serverRequests.values()].map((request) => structuredClone(request));
  }

  settleServerRequest(id: RpcId): void {
    this.serverRequests.delete(idKey(id));
  }

  async respondToServerRequest(id: RpcId, outcome: RpcOutcome): Promise<boolean> {
    const key = idKey(id);
    if (!this.serverRequests.has(key)) return false;
    this.serverRequests.delete(key);
    await this.requiredAggregator().handle(response(id, outcome));
    return true;
  }

  async send(message: RpcMessage): Promise<void> {
    if (isResponse(message)) {
      const pending = this.pendingCalls.get(idKey(message.id));
      if (!pending) {
        this.log(`ignored response for unknown daemon request ${String(message.id)}`);
        return;
      }
      this.pendingCalls.delete(idKey(message.id));
      pending("error" in message ? { error: message.error } : { result: message.result });
      return;
    }
    if (isNotification(message)) {
      this.appendEvent(message);
      const client = this.activeClient;
      if (client && !client.optOutNotifications.has(message.method)) {
        if (client.initialized) client.delivery.enqueue(message);
        else if (client.initializing) this.queueInitializingNotification(client, message);
      }
      return;
    }
    if (isRequest(message)) {
      this.serverRequests.set(idKey(message.id), structuredClone(message));
      const client = this.activeClient;
      if (client?.initialized) client.delivery.enqueue(message);
    }
  }

  async close(): Promise<void> {
    for (const resolve of this.pendingCalls.values()) {
      resolve(errorOutcome(-32003, "aggregator daemon closed"));
    }
    this.pendingCalls.clear();
    this.serverRequests.clear();
    const client = this.activeClient;
    this.activeClient = undefined;
    client?.delivery.close();
  }

  async initializeClient(client: ActiveClient, id: RpcId, params: unknown): Promise<void> {
    client.optOutNotifications = new Set(initializeOptOutMethods(params));
    client.initializing = true;
    const outcome = await this.ensureInitialized(params);
    client.delivery.enqueue(response(id, outcome));
    client.initializing = false;
    if ("result" in outcome) {
      client.initialized = true;
      const notifications = client.queuedNotifications.splice(0);
      client.queuedNotificationBytes = 0;
      for (const notification of notifications) client.delivery.enqueue(notification);
      for (const request of this.serverRequests.values()) client.delivery.enqueue(request);
    } else {
      client.queuedNotifications.length = 0;
      client.queuedNotificationBytes = 0;
    }
  }

  async handleClientMessage(client: ActiveClient, message: RpcMessage): Promise<void> {
    if (this.activeClient !== client) return;
    if (isResponse(message)) {
      if (this.serverRequests.has(idKey(message.id))) this.serverRequests.delete(idKey(message.id));
      await this.requiredAggregator().handle(message);
      return;
    }
    if (isNotification(message)) {
      if (message.method === "initialized" && client.initialized) await this.ensureInitializedNotification(message.params);
      else if (message.method !== "initialized") await this.requiredAggregator().handle(message);
      return;
    }
    if (message.method === "initialize") {
      if (client.initializing || client.initialized) {
        client.delivery.enqueue(response(message.id, errorOutcome(-32600, "Already initialized")));
        return;
      }
      await this.initializeClient(client, message.id, message.params);
      return;
    }
    if (!client.initialized && !message.method.startsWith("skizzles/project/")) {
      client.delivery.enqueue(response(message.id, errorOutcome(-32000, "Not initialized")));
      return;
    }
    const outcome = await this.callCore(message.method, message.params);
    client.delivery.enqueue(response(message.id, outcome));
  }

  private async ensureInitialized(params: unknown = DEFAULT_INITIALIZE_PARAMS): Promise<RpcOutcome> {
    if (this.initializeOutcome) return this.initializeOutcome;
    if (!this.initialization) {
      const attempt = this.callCore("initialize", params).then((outcome) => {
        if ("result" in outcome) this.initializeOutcome = outcome;
        return outcome;
      });
      this.initialization = attempt;
      attempt.finally(() => {
        if (this.initialization === attempt && !this.initializeOutcome) this.initialization = undefined;
      }).catch(() => undefined);
    }
    return this.initialization;
  }

  private async ensureInitializedNotification(params?: unknown): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    await this.requiredAggregator().handle(params === undefined ? { method: "initialized" } : { method: "initialized", params });
  }

  private async callCore(method: string, params?: unknown): Promise<RpcOutcome> {
    const id = `daemon/client/${crypto.randomUUID()}`;
    const outcome = new Promise<RpcOutcome>((resolve) => this.pendingCalls.set(idKey(id), resolve));
    try {
      await this.requiredAggregator().handle(params === undefined ? { method, id } : { method, id, params });
    } catch (error) {
      this.pendingCalls.delete(idKey(id));
      throw error;
    }
    return outcome;
  }

  private appendEvent(event: RpcNotification): void {
    this.events.push({ cursor: this.nextEventCursor++, event: structuredClone(event) });
    if (this.events.length > MAX_RETAINED_EVENTS) this.events.splice(0, this.events.length - MAX_RETAINED_EVENTS);
  }

  private queueInitializingNotification(client: ActiveClient, notification: RpcNotification): void {
    const bytes = messageBytes(notification);
    if (
      client.queuedNotifications.length >= MAX_QUEUED_CLIENT_MESSAGES
      || client.queuedNotificationBytes + bytes > MAX_QUEUED_CLIENT_BYTES
    ) {
      this.disconnectClient(client, "relay initialization queue exceeded its limit");
      return;
    }
    client.queuedNotifications.push(structuredClone(notification));
    client.queuedNotificationBytes += bytes;
  }

  private disconnectClient(client: ActiveClient, reason: string): void {
    if (this.activeClient !== client) return;
    this.log(`disconnecting client: ${reason}`);
    this.activeClient = undefined;
    client.delivery.close();
    client.queuedNotifications.length = 0;
    client.queuedNotificationBytes = 0;
    try {
      client.disconnect();
    } catch (error) {
      this.log(`failed to disconnect client: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private requiredAggregator(): AppServerAggregator {
    if (!this.aggregator) throw new Error("aggregator bridge is not bound");
    return this.aggregator;
  }
}

type QueuedClientMessage = { message: RpcMessage; bytes: number };

class ClientDelivery {
  private readonly queue: QueuedClientMessage[] = [];
  private queuedBytes = 0;
  private active = false;
  private closed = false;
  private delivery: Promise<void> | undefined;

  constructor(private readonly output: MessageSink, private readonly disconnect: (reason: string) => void) {}

  enqueue(message: RpcMessage): void {
    if (this.closed) return;
    if (!this.active) {
      this.active = true;
      const delivery = this.deliver(structuredClone(message));
      this.delivery = delivery;
      delivery.finally(() => {
        if (this.delivery === delivery) this.delivery = undefined;
      }).catch(() => undefined);
      return;
    }
    const bytes = messageBytes(message);
    if (this.queue.length >= MAX_QUEUED_CLIENT_MESSAGES || this.queuedBytes + bytes > MAX_QUEUED_CLIENT_BYTES) {
      this.fail("relay output queue exceeded its limit");
      return;
    }
    this.queue.push({ message: structuredClone(message), bytes });
    this.queuedBytes += bytes;
  }

  drain(): Promise<void> {
    return this.delivery ?? Promise.resolve();
  }

  close(): void {
    this.closed = true;
    this.queue.length = 0;
    this.queuedBytes = 0;
  }

  private async deliver(first: RpcMessage): Promise<void> {
    let message: RpcMessage | undefined = first;
    while (message && !this.closed) {
      try {
        await this.output.send(message);
      } catch (error) {
        this.fail(`relay write failed: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      if (this.closed) return;
      const next = this.queue.shift();
      if (!next) {
        this.active = false;
        return;
      }
      this.queuedBytes -= next.bytes;
      message = next.message;
    }
  }

  private fail(reason: string): void {
    if (this.closed) return;
    this.close();
    this.disconnect(reason);
  }
}

function messageBytes(message: RpcMessage): number {
  return Buffer.byteLength(JSON.stringify(message));
}

export class AggregatorClientSession {
  private closed = false;

  constructor(private readonly bridge: AggregatorBridge, private readonly client: ActiveClient) {}

  async handle(message: RpcMessage): Promise<void> {
    if (!this.closed) await this.bridge.handleClientMessage(this.client, message);
  }

  drain(): Promise<void> {
    return this.client.delivery.drain();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.bridge.detachClient(this.client);
  }
}

function initializeOptOutMethods(params: unknown): string[] {
  const root = asRecord(params);
  const capabilities = asRecord(root.capabilities);
  const methods = capabilities.optOutNotificationMethods;
  return Array.isArray(methods) ? methods.filter((method): method is string => typeof method === "string") : [];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
