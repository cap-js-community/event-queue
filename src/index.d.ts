import * as cds from "@sap/cds";

export declare const EventProcessingStatus: {
  Open: 0;
  InProgress: 1;
  Done: 2;
  Error: 3;
  Exceeded: 4;
};

export declare type EventProcessingStatusType = keyof typeof EventProcessingStatus;

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
