import * as cds from "@sap/cds";

export declare const EventProcessingStatus: {
  Open: 0;
  InProgress: 1;
  Done: 2;
  Error: 3;
  Exceeded: 4;
  Suspended: 5;
};

declare type EventProcessingStatusKeysType = keyof typeof EventProcessingStatus;
export declare type EventProcessingStatusType = (typeof EventProcessingStatus)[EventProcessingStatusKeysType];

export declare const TenantIdCheckTypes: {
  eventProcessing: "eventProcessing";
  getTokenInfo: "getTokenInfo";
};

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

export type EventConfig = {
  type: string;
  subType: string;
  load: number;
  impl: string;
  selectMaxChunkSize: number | undefined;
  parallelEventProcessing: boolean;
  retryAttempts: number | undefined;
  transactionMode: string | undefined;
  processAfterCommit: boolean | undefined;
  checkForNextChunk: boolean | undefined;
  deleteFinishedEventsAfterDays: number | undefined;
  appNames: string[] | undefined;
  useEventQueueUser: boolean | undefined;
  internalEvent: true;
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
  startAfter?: string;
}

interface EventTriggerProcessing {
  type: string;
  subType: string;
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
  beforeProcessingEvents(): Promise<void>;
  addEntryToProcessingMap(key: string, queueEntry: EventEntity, payload: Object): void;
  getTxForEventProcessing(key: string): cds.Transaction;

  set logger(value: CdsLogger);
  get logger(): CdsLogger;
  get tx(): cds.Transaction;
  get context(): cds.EventContext;
  get isPeriodicEvent(): boolean;
  get eventType(): String;
  get eventSubType(): String;
  get eventConfig(): EventConfig;
}

export function publishEvent(
  tx: cds.Transaction,
  events: EventEntityPublish[] | EventEntityPublish,
  options?: {
    skipBroadcast?: boolean;
    skipInsertEventsBeforeCommit?: boolean;
    addTraceContext?: boolean;
  }
): Promise<any>;

export function processEventQueue(context: cds.EventContext, eventType: string, eventSubType: string): Promise<any>;

export function triggerEventProcessingRedis(
  tenantId: string,
  events: EventTriggerProcessing[],
  forceBroadcast?: boolean
): Promise<any>;

declare class Config {
  constructor();

  getEventConfig(type: any, subType: any): any;
  isCapOutboxEvent(type: any): boolean;
  hasEventAfterCommitFlag(type: any, subType: any): any;
  shouldBeProcessedInThisApplication(type: any, subType: any): boolean;
  checkRedisEnabled(): any;
  attachConfigChangeHandler(): void;
  attachRedisUnsubscribeHandler(): void;
  executeUnsubscribeHandlers(tenantId: any): void;
  handleUnsubscribe(tenantId: any): void;
  attachUnsubscribeHandler(cb: any): void;
  publishConfigChange(key: any, value: any): void;
  blockEvent(type: any, subType: any, isPeriodic: any, tenant?: string): void;
  clearPeriodicEventBlockList(): void;
  unblockEvent(type: any, subType: any, isPeriodic: any, tenant?: string): void;
  addCAPOutboxEventBase(serviceName: any, config: any): void;
  isEventBlocked(type: any, subType: any, isPeriodicEvent: any, tenant: any): any;
  set isEventQueueActive(value: boolean);
  get isEventQueueActive(): boolean;
  set fileContent(config: any);
  get fileContent(): any;
  generateKey(type: any, subType: any): string;
  removeEvent(type: any, subType: any): void;
  isTenantUnsubscribed(tenantId: any): any;
  get events(): any;
  get periodicEvents(): any;
  isPeriodicEvent(type: any, subType: any): any;
  get allEvents(): any;
  set forUpdateTimeout(value: number);
  get forUpdateTimeout(): number;
  set globalTxTimeout(value: number);
  get globalTxTimeout(): number;
  set publishEventBlockList(value: any);
  get publishEventBlockList(): any;
  set crashOnRedisUnavailable(value: any);
  get crashOnRedisUnavailable(): any;
  set tenantIdFilterTokenInfo(value: any);
  get tenantIdFilterTokenInfo(): any;
  set tenantIdFilterEventProcessing(value: any);
  get tenantIdFilterEventProcessing(): any;
  set runInterval(value: any);
  get runInterval(): any;
  set redisEnabled(value: any);
  get redisEnabled(): any;
  set initialized(value: boolean);
  get initialized(): boolean;
  set cronTimezone(value: any);
  get cronTimezone(): any;
  set instanceLoadLimit(value: number);
  get instanceLoadLimit(): number;
  set isEventBlockedCb(value: any);
  get isEventBlockedCb(): any;
  get tableNameEventQueue(): string;
  get tableNameEventLock(): string;
  set configFilePath(value: any);
  get configFilePath(): any;
  set processEventsAfterPublish(value: any);
  get processEventsAfterPublish(): any;
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
  set enableTelemetry(value: any);
  get enableTelemetry(): any;
  get isMultiTenancy(): boolean;
}

export const config: Config;

export const workerQueue: WorkerQueue;

declare class WorkerQueue {
  constructor(concurrency: number);

  addToQueue(
    load: number,
    label: string,
    priority: Priorities,
    increasePriorityOverTime: boolean,
    cb: () => any
  ): Promise<any>;

  _executeFunction(
    load: number,
    label: string,
    cb: () => any,
    resolve: (value?: unknown) => void,
    reject: (reason?: any) => void,
    startTime: bigint,
    priority: string
  ): void;

  get runningPromises(): Array<Promise<any>>;
  get runningLoad(): number;

  static get instance(): WorkerQueue;

  get queue(): Record<
    string,
    Array<[number, string, () => any, (value?: unknown) => void, (reason?: any) => void, bigint]>
  >;
}

interface Priorities {
  Low: string;
  Medium: string;
  High: string;
  VeryHigh: string;
}
