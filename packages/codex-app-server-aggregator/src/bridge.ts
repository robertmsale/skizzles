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
const MAX_RETAINED_EVENT_BYTES = 32 * 1024 * 1024;
const MAX_SINGLE_JOURNAL_EVENT_BYTES = 4 * 1024 * 1024;
const MAX_SUBSCRIPTION_EVENTS = MAX_RETAINED_EVENTS;
const MAX_SUBSCRIPTION_BYTES = 16 * 1024 * 1024;
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

type EventListener = (record: EventRecord) => boolean;

export class EventSubscription {
  private readonly records: Array<{ record: EventRecord; bytes: number }> = [];
  private queuedBytes = 0;
  private listener: EventListener | undefined;
  private closed = false;
  private didOverflow = false;

  constructor(
    readonly cursor: number,
    readonly streamId: string,
    readonly gap: boolean,
    readonly restarted: boolean,
    private readonly release: () => void,
  ) {}

  get overflowed(): boolean {
    return this.didOverflow;
  }

  enqueue(record: EventRecord): void {
    if (this.closed) return;
    if (this.listener) {
      if (!this.listener(record)) this.close();
      return;
    }
    this.buffer(record);
  }

  start(listener: EventListener): boolean {
    if (this.closed || this.didOverflow) return false;
    this.listener = listener;
    for (const queued of this.records.splice(0)) {
      this.queuedBytes -= queued.bytes;
      if (!listener(queued.record)) {
        this.close();
        return false;
      }
    }
    return true;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.listener = undefined;
    this.records.length = 0;
    this.queuedBytes = 0;
    this.release();
  }

  private buffer(record: EventRecord): boolean {
    const copy = structuredClone(record);
    const bytes = eventRecordBytes(copy);
    if (this.records.length >= MAX_SUBSCRIPTION_EVENTS || this.queuedBytes + bytes > MAX_SUBSCRIPTION_BYTES) {
      this.didOverflow = true;
      this.close();
      return false;
    }
    this.records.push({ record: copy, bytes });
    this.queuedBytes += bytes;
    return true;
  }
}

export class AggregatorBridge implements MessageSink {
  private aggregator: AppServerAggregator | undefined;
  private activeClient: ActiveClient | undefined;
  private readonly pendingCalls = new Map<string, PendingCall>();
  private readonly serverRequests = new Map<string, RpcRequest>();
  private readonly events: EventRecord[] = [];
  private retainedEventBytes = 0;
  private readonly eventSubscriptions = new Set<EventSubscription>();
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

  openEventSubscription(after?: number, expectedStreamId?: string): EventSubscription {
    const oldestCursor = this.events[0]?.cursor ?? this.nextEventCursor;
    const currentCursor = this.nextEventCursor - 1;
    const restarted = expectedStreamId !== undefined && expectedStreamId !== this.streamId;
    const gap = after !== undefined && (restarted || after < oldestCursor - 1 || after > currentCursor);
    const replay = after === undefined || gap
      ? []
      : this.events.filter((record) => record.cursor > after);
    let subscription!: EventSubscription;
    subscription = new EventSubscription(
      after ?? currentCursor,
      this.streamId,
      gap,
      restarted,
      () => this.eventSubscriptions.delete(subscription),
    );
    this.eventSubscriptions.add(subscription);
    for (const record of replay) subscription.enqueue(record);
    return subscription;
  }

  get eventSubscriberCount(): number {
    return this.eventSubscriptions.size;
  }

  pendingServerRequests(): RpcRequest[] {
    return [...this.serverRequests.values()].map((request) => structuredClone(request));
  }

  settleServerRequest(id: RpcId): void {
    const key = idKey(id);
    const request = this.serverRequests.get(key);
    if (!request) return;
    this.serverRequests.delete(key);
    this.appendEvent(serverRequestNotification("resolved", request));
  }

  async respondToServerRequest(id: RpcId, outcome: RpcOutcome): Promise<boolean> {
    const key = idKey(id);
    const request = this.serverRequests.get(key);
    if (!request) return false;
    this.serverRequests.delete(key);
    this.appendEvent(serverRequestNotification("resolved", request));
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
      this.appendEvent(serverRequestNotification("pending", message));
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
    for (const subscription of [...this.eventSubscriptions]) subscription.close();
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
    const retained = boundedJournalEvent(event);
    const record = { cursor: this.nextEventCursor++, event: retained };
    const bytes = eventRecordBytes(record);
    this.events.push(record);
    this.retainedEventBytes += bytes;
    while (this.events.length > MAX_RETAINED_EVENTS || this.retainedEventBytes > MAX_RETAINED_EVENT_BYTES) {
      const removed = this.events.shift();
      if (!removed) break;
      this.retainedEventBytes -= eventRecordBytes(removed);
    }
    for (const subscription of [...this.eventSubscriptions]) subscription.enqueue(record);
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

function eventRecordBytes(record: EventRecord): number {
  return Buffer.byteLength(JSON.stringify(record));
}

function boundedJournalEvent(event: RpcNotification): RpcNotification {
  const copy = structuredClone(event);
  const bytes = messageBytes(copy);
  if (bytes <= MAX_SINGLE_JOURNAL_EVENT_BYTES) return copy;
  const params = asRecord(copy.params);
  if (copy.method === "skizzles/server-request/pending") {
    const request = asRecord(params.request);
    const requestParams = asRecord(request.params);
    return {
      method: copy.method,
      params: {
        request: {
          id: request.id,
          method: request.method,
          params: {
            ...(typeof requestParams.threadId === "string" ? { threadId: requestParams.threadId } : {}),
            ...(typeof requestParams.cwd === "string" ? { cwd: requestParams.cwd } : {}),
          },
        },
        oversizedBytes: bytes,
      },
    };
  }
  const item = asRecord(params.item);
  const thread = asRecord(params.thread);
  const turn = asRecord(params.turn);
  return {
    method: "skizzles/event/oversized",
    params: {
      originalMethod: copy.method,
      bytes,
      ...(typeof params.threadId === "string"
        ? { threadId: params.threadId }
        : typeof thread.id === "string" ? { threadId: thread.id } : {}),
      ...(typeof item.id === "string" ? { itemId: item.id } : {}),
      ...(typeof turn.id === "string" ? { turnId: turn.id } : {}),
    },
  };
}

function serverRequestNotification(state: "pending" | "resolved", request: RpcRequest): RpcNotification {
  const params = asRecord(request.params);
  return {
    method: `skizzles/server-request/${state}`,
    params: state === "pending"
      ? { request: structuredClone(request) }
      : {
        id: request.id,
        method: request.method,
        ...(typeof params.threadId === "string" ? { threadId: params.threadId } : {}),
        ...(typeof params.cwd === "string" ? { cwd: params.cwd } : {}),
      },
  };
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
