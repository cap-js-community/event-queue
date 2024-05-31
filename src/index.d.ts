import * as cds from "@sap/cds";

export declare const EventProcessingStatus: {
  Open: 0;
  InProgress: 1;
  Done: 2;
  Error: 3;
  Exceeded: 4;
};

declare type EventProcessingStatusKeysType = keyof typeof EventProcessingStatus;
export declare type EventProcessingStatusType = (typeof EventProcessingStatus)[EventProcessingStatusKeysType];

export declare const TransactionMode: {
  isolated: "isolated";
  alwaysCommit: "alwaysCommit";
  alwaysRollback: "alwaysRollback";
};

export declare type TransactionModeType = keyof typeof TransactionMode;

export declare const Priorities: {
  Low: "low";
  Medium: "medium";
  High: "high";
  VeryHigh: "veryHigh";
};
export declare type PrioritiesType = keyof typeof Priorities;

interface RedisOptions {
  host: string;
  port: number;
}

interface InitializeParams {
  configFilePath: string;
  registerAsEventProcessor?: boolean;
  processEventsAfterPublish?: boolean;
  isEventQueueActive?: boolean;
  runInterval?: number;
  disableRedis?: boolean;
  updatePeriodicEvents?: boolean;
  thresholdLoggingEventProcessing?: number;
  useAsCAPOutbox?: boolean;
  userId?: string | null;
  cleanupLocksAndEventsForDev?: boolean;
  redisOptions?: RedisOptions;
  insertEventsBeforeCommit?: boolean;
}

type CdsLogger = ReturnType<typeof cds.log>;

export function initialize(params: InitializeParams): Promise<void>;

type EventConfigType = {
  type: string;
  subType: string;
  priority: string;
  impl: string;
  load: number;
  interval: number;
  internalEvent: boolean;
  isPeriodic: boolean;
};

// Define Status Type
type Status = 0 | 1 | 2 | 3 | 4;

// Define Event Entity Type
interface EventEntity {
  type: string;
  subType: string;
  referenceEntity?: string;
  referenceEntityKey?: string;
  status: Status;
  payload?: string;
  attempts: number;
  lastAttemptTimestamp?: string;
  createdAt: string;
  startAfter?: string;
}

interface EventEntityPublish {
  type: string;
  subType: string;
  referenceEntity?: string;
  referenceEntityKey?: string;
  payload?: string;
}

interface QueueEntriesPayloadMap {
  [key: string]: {
    queueEntry: EventEntity;
    payload: Object;
  };
}

export declare class EventQueueProcessorBase {
  constructor(context: cds.EventContext, eventType: string, eventSubType: string, config: EventConfigType);

  processEvent(
    processContext: cds.EventContext,
    key: string,
    queueEntries: EventEntity[],
    payload: Object
  ): Promise<Array<[string, EventProcessingStatusType]>>;

  processPeriodicEvent(processContext: cds.EventContext, key: string, queueEntry: EventEntity): Promise<undefined>;
  checkEventAndGeneratePayload(queueEntry: EventEntity): Promise<Object>;
  addEventWithPayloadForProcessing(queueEntry: EventEntity, payload: Object): void;
  clusterQueueEntries(queueEntriesWithPayloadMap: Object): void;
  hookForExceededEvents(exceededEvent: EventEntity): Promise<void>;
  clusterQueueEntries(queueEntriesWithPayloadMap: QueueEntriesPayloadMap): void;
  getLastSuccessfulRunTimestamp(): Promise<string | null>;
  getContextForEventProcessing(key: string): cds.EventContext;
  getTxForEventProcessing(key: string): cds.Transaction;
  setShouldRollbackTransaction(key: string): void;
  shouldRollbackTransaction(key: string): boolean;

  set logger(value: CdsLogger);
  get logger(): CdsLogger;
  get tx(): cds.Transaction;
  get context(): cds.EventContext;
  get isPeriodicEvent(): boolean;
  get eventType(): String;
  get eventSubType(): String;
}

export function publishEvent(
  tx: cds.Transaction,
  events: EventEntityPublish[] | EventEntityPublish,
  skipBroadcast?: boolean
): Promise<any>;

export function processEventQueue(
  context: cds.EventContext,
  eventType: string,
  eventSubType: string,
  startTime: Date
): Promise<any>;

declare class Config {
  constructor();

  getEventConfig(type: string, subType: string): any;
  isCapOutboxEvent(type: string): boolean;
  hasEventAfterCommitFlag(type: string, subType: string): boolean;
  _checkRedisIsBound(): boolean;
  checkRedisEnabled(): boolean;
  attachConfigChangeHandler(): void;
  attachRedisUnsubscribeHandler(): void;
  executeUnsubscribeHandlers(tenantId: string): void;
  handleUnsubscribe(tenantId: string): void;
  attachUnsubscribeHandler(cb: Function): void;
  publishConfigChange(key: string, value: any): void;
  blockEvent(type: string, subType: string, isPeriodic: boolean, tenant?: string): void;
  clearPeriodicEventBlockList(): void;
  unblockEvent(type: string, subType: string, isPeriodic: boolean, tenant?: string): void;
  addCAPOutboxEvent(serviceName: string, config: any): void;
  isEventBlocked(type: string, subType: string, isPeriodicEvent: boolean, tenant: string): boolean;
  get isEventQueueActive(): boolean;
  set isEventQueueActive(value: boolean);
  set fileContent(config: any);
  get fileContent(): any;
  get events(): any[];
  get periodicEvents(): any[];
  isPeriodicEvent(type: string, subType: string): boolean;
  get allEvents(): any[];
  get forUpdateTimeout(): number;
  get globalTxTimeout(): number;
  set forUpdateTimeout(value: number);
  set globalTxTimeout(value: number);
  get runInterval(): number | null;
  set runInterval(value: number);
  get redisEnabled(): boolean | null;
  set redisEnabled(value: boolean | null);
  get initialized(): boolean;
  set initialized(value: boolean);
  get instanceLoadLimit(): number;
  set instanceLoadLimit(value: number);
  get isEventBlockedCb(): any;
  set isEventBlockedCb(value: any);
  get tableNameEventQueue(): string;
  get tableNameEventLock(): string;
  set configFilePath(value: string | null);
  get configFilePath(): string | null;
  set processEventsAfterPublish(value: any);
  get processEventsAfterPublish(): any;
  set skipCsnCheck(value: any);
  get skipCsnCheck(): any;
  set disableRedis(value: any);
  get disableRedis(): any;
  set updatePeriodicEvents(value: any);
  get updatePeriodicEvents(): any;
  set registerAsEventProcessor(value: any);
  get registerAsEventProcessor(): any;
  set thresholdLoggingEventProcessing(value: any);
  get thresholdLoggingEventProcessing(): any;
  set useAsCAPOutbox(value: any);
  get useAsCAPOutbox(): any;
  set userId(value: any);
  get userId(): any;
  set cleanupLocksAndEventsForDev(value: any);
  get cleanupLocksAndEventsForDev(): any;
  set redisOptions(value: any);
  get redisOptions(): any;
  set insertEventsBeforeCommit(value: any);
  get insertEventsBeforeCommit(): any;
  get isMultiTenancy(): boolean;
}

export const config: Config;
