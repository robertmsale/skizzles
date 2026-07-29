export type Usage = {
  input: number;
  cached: number;
  cacheWrite: number;
  cacheWriteObserved: boolean;
  output: number;
  reasoning: number;
  total: number;
  proxy: number;
};

export type RawAggregate = {
  usage: Usage;
  inferences: number;
};

export type CreditEquivalent = {
  pricedCredits: number;
  fullyPricedInferences: number;
  partiallyPricedInferences: number;
  unpricedInferences: number;
  cacheWrite: {
    observedInferences: number;
    unavailableInferences: number;
    tokens: number;
  };
  unpricedUsage: RawAggregate & {
    models: Map<string, RawAggregate>;
  };
};

export type Aggregate = {
  usage: Usage;
  inferences: number;
  sessions: Set<string>;
  credit: CreditEquivalent;
};

export const CREDIT_RATES = {
  "gpt-5.6-sol": {
    uncachedInput: 125,
    cachedInput: 12.5,
    cacheWriteInput: 156.25,
    output: 750,
  },
  "gpt-5.6-terra": {
    uncachedInput: 62.5,
    cachedInput: 6.25,
    cacheWriteInput: 78.125,
    output: 375,
  },
  "gpt-5.6-luna": {
    uncachedInput: 25,
    cachedInput: 2.5,
    cacheWriteInput: 31.25,
    output: 150,
  },
} as const;

export const CREDIT_SCHEMA_VERSION = "gpt-5.6-credit-equivalent-v1";

export function emptyUsage(): Usage {
  return {
    input: 0,
    cached: 0,
    cacheWrite: 0,
    cacheWriteObserved: false,
    output: 0,
    reasoning: 0,
    total: 0,
    proxy: 0,
  };
}

export function emptyCredit(): CreditEquivalent {
  return {
    pricedCredits: 0,
    fullyPricedInferences: 0,
    partiallyPricedInferences: 0,
    unpricedInferences: 0,
    cacheWrite: {
      observedInferences: 0,
      unavailableInferences: 0,
      tokens: 0,
    },
    unpricedUsage: {
      usage: emptyUsage(),
      inferences: 0,
      models: new Map(),
    },
  };
}

export function emptyAggregate(): Aggregate {
  return {
    usage: emptyUsage(),
    inferences: 0,
    sessions: new Set(),
    credit: emptyCredit(),
  };
}

export function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object"
    ? value as Record<string, unknown>
    : undefined;
}

function hasCacheWrite(value: unknown): boolean {
  return value !== null
    && typeof value === "object"
    && Object.hasOwn(value, "cache_write_input_tokens");
}

export function addUsage(target: Usage, source: Usage): void {
  target.input += source.input;
  target.cached += source.cached;
  target.cacheWrite += source.cacheWrite;
  target.cacheWriteObserved ||= source.cacheWriteObserved;
  target.output += source.output;
  target.reasoning += source.reasoning;
  target.total += source.total;
  target.proxy += source.proxy;
}

export function usageFrom(raw: unknown, cachedWeight: number): Usage {
  const value = asObject(raw);
  const input = asNumber(value?.input_tokens);
  const cached = Math.min(input, asNumber(value?.cached_input_tokens));
  const cacheWriteObserved = hasCacheWrite(raw);
  const cacheWrite = cacheWriteObserved
    ? Math.min(Math.max(0, input - cached), asNumber(value?.cache_write_input_tokens))
    : 0;
  const output = asNumber(value?.output_tokens);
  return {
    input,
    cached,
    cacheWrite,
    cacheWriteObserved,
    output,
    reasoning: asNumber(value?.reasoning_output_tokens),
    total: asNumber(value?.total_tokens) || input + output,
    proxy: input - cached + cached * cachedWeight + output,
  };
}

export function usageDelta(current: unknown, previous: unknown, cachedWeight: number): Usage {
  const currentValue = asObject(current);
  const previousValue = asObject(previous);
  const raw: Record<string, number> = {
    input_tokens: Math.max(0, asNumber(currentValue?.input_tokens) - asNumber(previousValue?.input_tokens)),
    cached_input_tokens: Math.max(
      0,
      asNumber(currentValue?.cached_input_tokens) - asNumber(previousValue?.cached_input_tokens),
    ),
    output_tokens: Math.max(0, asNumber(currentValue?.output_tokens) - asNumber(previousValue?.output_tokens)),
    reasoning_output_tokens: Math.max(
      0,
      asNumber(currentValue?.reasoning_output_tokens) - asNumber(previousValue?.reasoning_output_tokens),
    ),
    total_tokens: Math.max(0, asNumber(currentValue?.total_tokens) - asNumber(previousValue?.total_tokens)),
  };
  if (hasCacheWrite(current)) {
    raw.cache_write_input_tokens = Math.max(
      0,
      asNumber(currentValue?.cache_write_input_tokens) - asNumber(previousValue?.cache_write_input_tokens),
    );
  }
  return usageFrom(raw, cachedWeight);
}

function addRawAggregate(target: RawAggregate, source: RawAggregate): void {
  addUsage(target.usage, source.usage);
  target.inferences += source.inferences;
}

export function addCredit(target: CreditEquivalent, source: CreditEquivalent): void {
  target.pricedCredits += source.pricedCredits;
  target.fullyPricedInferences += source.fullyPricedInferences;
  target.partiallyPricedInferences += source.partiallyPricedInferences;
  target.unpricedInferences += source.unpricedInferences;
  target.cacheWrite.observedInferences += source.cacheWrite.observedInferences;
  target.cacheWrite.unavailableInferences += source.cacheWrite.unavailableInferences;
  target.cacheWrite.tokens += source.cacheWrite.tokens;
  addRawAggregate(target.unpricedUsage, source.unpricedUsage);
  for (const [model, aggregate] of source.unpricedUsage.models) {
    const targetAggregate = target.unpricedUsage.models.get(model) ?? {
      usage: emptyUsage(),
      inferences: 0,
    };
    addRawAggregate(targetAggregate, aggregate);
    target.unpricedUsage.models.set(model, targetAggregate);
  }
}

export function creditFor(model: string, usage: Usage): CreditEquivalent {
  const credit = emptyCredit();
  const rates = CREDIT_RATES[model as keyof typeof CREDIT_RATES];
  if (!rates) {
    credit.unpricedInferences = 1;
    credit.unpricedUsage.inferences = 1;
    addUsage(credit.unpricedUsage.usage, usage);
    credit.unpricedUsage.models.set(model, {
      usage: { ...usage },
      inferences: 1,
    });
    return credit;
  }

  const uncachedInput = Math.max(0, usage.input - usage.cached - usage.cacheWrite);
  credit.pricedCredits = (
    uncachedInput * rates.uncachedInput
    + usage.cached * rates.cachedInput
    + usage.cacheWrite * rates.cacheWriteInput
    + usage.output * rates.output
  ) / 1_000_000;
  if (usage.cacheWriteObserved) {
    credit.fullyPricedInferences = 1;
    credit.cacheWrite.observedInferences = 1;
    credit.cacheWrite.tokens = usage.cacheWrite;
  } else {
    credit.partiallyPricedInferences = 1;
    credit.cacheWrite.unavailableInferences = 1;
  }
  return credit;
}

export function aggregateInference(
  map: Map<string, Aggregate>,
  key: string,
  sessionId: string,
  usage: Usage,
  credit: CreditEquivalent,
): void {
  const aggregate = map.get(key) ?? emptyAggregate();
  addUsage(aggregate.usage, usage);
  addCredit(aggregate.credit, credit);
  aggregate.inferences += 1;
  aggregate.sessions.add(sessionId);
  map.set(key, aggregate);
}

export function mergeAggregate(target: Aggregate, source: Aggregate): void {
  addUsage(target.usage, source.usage);
  addCredit(target.credit, source.credit);
  target.inferences += source.inferences;
  for (const sessionId of source.sessions) target.sessions.add(sessionId);
}
