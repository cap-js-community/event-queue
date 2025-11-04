"use strict";

const cds = require("@sap/cds");
const { CronExpressionParser } = require("cron-parser");

const { getEnvInstance } = require("./shared/env");
const redis = require("./shared/redis");
const EventQueueError = require("./EventQueueError");
const { Priorities } = require("./constants");

const FOR_UPDATE_TIMEOUT = 10;
const GLOBAL_TX_TIMEOUT = 30 * 60 * 1000;
const REDIS_PREFIX = "EVENT_QUEUE";
const REDIS_CONFIG_CHANNEL = "CONFIG_CHANNEL";
const REDIS_OFFBOARD_TENANT_CHANNEL = "REDIS_OFFBOARD_TENANT_CHANNEL";
const REDIS_CONFIG_BLOCKLIST_CHANNEL = "REDIS_CONFIG_BLOCKLIST_CHANNEL";
const COMMAND_BLOCK = "EVENT_BLOCK";
const COMMAND_UNBLOCK = "EVENT_UNBLOCK";
const COMPONENT_NAME = "/eventQueue/config";
const MIN_INTERVAL_SEC = 10;
const DEFAULT_LOAD = 1;
const DEFAULT_PRIORITY = Priorities.Medium;
const DEFAULT_INCREASE_PRIORITY = true;
const DEFAULT_KEEP_ALIVE_INTERVAL = 60;
const DEFAULT_MAX_FACTOR_STUCK_2_KEEP_ALIVE_INTERVAL = 3.5;
const DEFAULT_INHERIT_TRACE_CONTEXT = true;
const DEFAULT_CHECK_FOR_NEXT_CHUNK = true;
const SUFFIX_PERIODIC = "_PERIODIC";
const CAP_EVENT_TYPE = "CAP_OUTBOX";
const CAP_PARALLEL_DEFAULT = 5;
const CAP_MAX_ATTEMPTS_DEFAULT = 5;
const DELETE_TENANT_BLOCK_AFTER_MS = 5 * 60 * 1000;
const PRIORITIES = Object.values(Priorities);
const UTC_DEFAULT = false;
const USE_CRON_TZ_DEFAULT = true;

const BASE_TABLES = {
  EVENT: "sap.eventqueue.Event",
  LOCK: "sap.eventqueue.Lock",
};

const ALLOWED_EVENT_OPTIONS_BASE = [
  "type",
  "subType",
  "load",
  "impl",
  "transactionMode",
  "deleteFinishedEventsAfterDays",
  "useEventQueueUser",
  "priority",
  "keepAliveInterval",
  "increasePriorityOverTime",
  "keepAliveMaxInProgressTime",
  "appNames",
  "appInstances",
  "namespace",
  "internalEvent",
];

const ALLOWED_EVENT_OPTIONS_AD_HOC = [
  ...ALLOWED_EVENT_OPTIONS_BASE,
  "inheritTraceContext",
  "selectMaxChunkSize",
  "parallelEventProcessing",
  "retryAttempts",
  "processAfterCommit",
  "checkForNextChunk",
  "retryFailedAfter",
  "multiInstanceProcessing",
  "kind",
  "timeBucket",
];

const ALLOWED_EVENT_OPTIONS_PERIODIC_EVENT = [
  ...ALLOWED_EVENT_OPTIONS_BASE,
  "interval",
  "cron",
  "utc",
  "useCronTimezone",
  "randomOffset",
];

class Config {
  #logger;
  #config;
  #forUpdateTimeout;
  #globalTxTimeout;
  #runInterval;
  #redisEnabled;
  #initialized;
  #instanceLoadLimit;
  #tableNameEventQueue;
  #tableNameEventLock;
  #isEventQueueActive;
  #configFilePath;
  #processEventsAfterPublish;
  #registerAsEventProcessor;
  #disableRedis;
  #env;
  #eventMap;
  #updatePeriodicEvents;
  #blockedEvents;
  #isEventBlockedCb;
  #thresholdLoggingEventProcessing;
  #useAsCAPOutbox;
  #userId;
  #cleanupLocksAndEventsForDev;
  #redisOptions;
  #insertEventsBeforeCommit;
  #enableTelemetry;
  #unsubscribeHandlers = [];
  #unsubscribedTenants = {};
  #cronTimezone;
  #randomOffsetPeriodicEvents;
  #redisNamespace;
  #publishEventBlockList;
  #crashOnRedisUnavailable;
  #tenantIdFilterAuthContextCb;
  #tenantIdFilterEventProcessingCb;
  #configEvents;
  #configPeriodicEvents;
  #enableAdminService;
  #disableProcessingOfSuspendedTenants;
  #publishNamespace;
  #processingNamespaces;
  #processDefaultNamespace;
  static #instance;
  constructor() {
    this.#logger = cds.log(COMPONENT_NAME);
    this.#config = null;
    this.#forUpdateTimeout = FOR_UPDATE_TIMEOUT;
    this.#globalTxTimeout = GLOBAL_TX_TIMEOUT;
    this.#runInterval = null;
    this.#redisEnabled = null;
    this.#initialized = false;
    this.#instanceLoadLimit = 100;
    this.#tableNameEventQueue = null;
    this.#tableNameEventLock = null;
    this.#isEventQueueActive = true;
    this.#configFilePath = null;
    this.#processEventsAfterPublish = null;
    this.#disableRedis = null;
    this.#env = getEnvInstance();
    this.#blockedEvents = {};
  }

  getEventConfig(type, subType) {
    return this.#eventMap[this.generateKey(type, subType)]
      ? { ...this.#eventMap[this.generateKey(type, subType)] }
      : undefined;
  }

  isCapOutboxEvent(type) {
    return type === CAP_EVENT_TYPE;
  }

  hasEventAfterCommitFlag(type, subType) {
    return this.#eventMap[this.generateKey(type, subType)]?.processAfterCommit ?? true;
  }

  _checkRedisIsBound() {
    return !!this.#env.redisRequires?.credentials;
  }

  #parseRegexOrString(str) {
    const regexLiteralPattern = /^\/((?:\\.|[^\\/])*)\/([gimsuy]*)$/;
    const match = str.match(regexLiteralPattern);

    if (match) {
      try {
        return { type: "regex", value: new RegExp(match[1], match[2]) };
      } catch {
        return { type: "string", value: str };
      }
    }
    return { type: "string", value: str };
  }

  #normalizeSubType(rawSubType) {
    const [serviceName, actionName] = rawSubType.split(".");
    const actionSpecificCall = this.getCdsOutboxEventSpecificConfig(serviceName, actionName);
    return actionSpecificCall ? rawSubType : serviceName;
  }

  shouldBeProcessedInThisApplication(type, rawSubType) {
    const subType = this.#normalizeSubType(rawSubType);

    const config = this.#eventMap[this.generateKey(type, subType)];
    const appNameConfig = config._appNameMap;
    const appInstanceConfig = config._appInstancesMap;
    let result = true;
    if (!appNameConfig && !appInstanceConfig) {
      return result;
    }

    if (appNameConfig) {
      if (config._appNameContainsRegex) {
        for (const configKey in appNameConfig) {
          const config = appNameConfig[configKey];
          if (config.type === "regex") {
            result = config.value.test(this.#env.applicationName);
          } else {
            const shouldBeProcessedBasedOnAppName = appNameConfig[this.#env.applicationName];
            result = !!shouldBeProcessedBasedOnAppName;
          }
          if (result) {
            break;
          }
        }
      } else {
        const shouldBeProcessedBasedOnAppName = appNameConfig[this.#env.applicationName];
        if (!shouldBeProcessedBasedOnAppName) {
          return false;
        }
      }
    }

    if (appInstanceConfig) {
      const shouldBeProcessedBasedOnAppInstance = appInstanceConfig[this.#env.applicationInstance];
      if (!shouldBeProcessedBasedOnAppInstance) {
        return false;
      }
    }

    return result;
  }

  checkRedisEnabled() {
    this.#redisEnabled = !this.#disableRedis && this._checkRedisIsBound();
    return this.#redisEnabled;
  }

  attachConfigChangeHandler() {
    this.#attachBlockListChangeHandler();
    redis.subscribeRedisChannel(this.redisOptions, REDIS_CONFIG_CHANNEL, (messageData) => {
      try {
        const { key, value } = JSON.parse(messageData);
        if (this[key] !== value) {
          this.#logger.info("received config change", { key, value });
          this[key] = value;
        }
      } catch (err) {
        this.#logger.error("could not parse event config change", err, {
          messageData,
        });
      }
    });
  }

  attachRedisUnsubscribeHandler() {
    this.#logger.info("attached redis handle for unsubscribe events");
    redis.subscribeRedisChannel(this.redisOptions, REDIS_OFFBOARD_TENANT_CHANNEL, (messageData) => {
      try {
        const { tenantId } = JSON.parse(messageData);
        this.#logger.info("received unsubscribe broadcast event", { tenantId });
        this.executeUnsubscribeHandlers(tenantId);
      } catch (err) {
        this.#logger.error("could not parse unsubscribe broadcast event", err, {
          messageData,
        });
      }
    });
  }

  executeUnsubscribeHandlers(tenantId) {
    this.#unsubscribedTenants[tenantId] = true;
    setTimeout(() => delete this.#unsubscribedTenants[tenantId], DELETE_TENANT_BLOCK_AFTER_MS);
    for (const unsubscribeHandler of this.#unsubscribeHandlers) {
      try {
        unsubscribeHandler(tenantId);
      } catch (err) {
        this.#logger.error("could executing unsubscribe handler", err, {
          tenantId,
        });
      }
    }
  }

  handleUnsubscribe(tenantId) {
    if (this.redisEnabled) {
      redis
        .publishMessage(this.redisOptions, REDIS_OFFBOARD_TENANT_CHANNEL, JSON.stringify({ tenantId }))
        .catch((error) => {
          this.#logger.error(`publishing tenant unsubscribe failed. tenantId: ${tenantId}`, error);
        });
    } else {
      this.executeUnsubscribeHandlers(tenantId);
    }
  }

  attachUnsubscribeHandler(cb) {
    this.#unsubscribeHandlers.push(cb);
  }

  publishConfigChange(key, value) {
    if (!this.redisEnabled) {
      this.#logger.info("redis not connected, config change won't be published", { key, value });
      return;
    }
    redis.publishMessage(this.redisOptions, REDIS_CONFIG_CHANNEL, JSON.stringify({ key, value })).catch((error) => {
      this.#logger.error(`publishing config change failed key: ${key}, value: ${value}`, error);
    });
  }

  #attachBlockListChangeHandler() {
    redis.subscribeRedisChannel(this.redisOptions, REDIS_CONFIG_BLOCKLIST_CHANNEL, (messageData) => {
      try {
        const { command, key, tenant } = JSON.parse(messageData);
        if (command === COMMAND_BLOCK) {
          this.#blockEventLocalState(key, tenant);
        } else {
          this.#unblockEventLocalState(key, tenant);
        }
      } catch (err) {
        this.#logger.error("could not parse event blocklist change", err, {
          messageData,
        });
      }
    });
  }

  blockEvent(type, subType, isPeriodic, tenant = "*") {
    const typeWithSuffix = `${type}${isPeriodic ? SUFFIX_PERIODIC : ""}`;
    const config = this.getEventConfig(typeWithSuffix, subType);
    if (!config) {
      return;
    }
    const key = this.generateKey(typeWithSuffix, subType);
    this.#blockEventLocalState(key, tenant);
    if (!this.redisEnabled || !this.publishEventBlockList) {
      return;
    }

    redis
      .publishMessage(
        this.redisOptions,
        REDIS_CONFIG_BLOCKLIST_CHANNEL,
        JSON.stringify({ command: COMMAND_BLOCK, key, tenant })
      )
      .catch((error) => {
        this.#logger.error(`publishing config block failed key: ${key}`, error);
      });
  }

  #blockEventLocalState(key, tenant) {
    this.#blockedEvents[key] ??= {};
    this.#blockedEvents[key][tenant] = true;
    return key;
  }

  clearPeriodicEventBlockList() {
    this.#blockedEvents = {};
  }

  unblockEvent(type, subType, isPeriodic, tenant = "*") {
    const typeWithSuffix = `${type}${isPeriodic ? SUFFIX_PERIODIC : ""}`;
    const key = this.generateKey(typeWithSuffix, subType);
    const config = this.getEventConfig(typeWithSuffix, subType);
    if (!config) {
      return;
    }
    this.#unblockEventLocalState(key, tenant);
    if (!this.redisEnabled) {
      return;
    }

    redis
      .publishMessage(
        this.redisOptions,
        REDIS_CONFIG_BLOCKLIST_CHANNEL,
        JSON.stringify({ command: COMMAND_UNBLOCK, key, tenant })
      )
      .catch((error) => {
        this.#logger.error(`publishing config block failed key: ${key}`, error);
      });
  }

  addCAPOutboxEventBase(serviceName, config) {
    if (this.#eventMap[this.generateKey(CAP_EVENT_TYPE, serviceName)]) {
      const index = this.#config.events.findIndex(
        (event) => event.type === CAP_EVENT_TYPE && event.subType === serviceName
      );
      this.#config.events.splice(index, 1);
    }

    // NOTE: CAP outbox defaults are injected by cds.requires.outbox // cds.requires.queue
    const eventConfig = this.#sanitizeParamsAdHocEvent({
      type: CAP_EVENT_TYPE,
      subType: serviceName,
      impl: "./outbox/EventQueueGenericOutboxHandler",
      kind: config.kind ?? "persistent-queue",
      selectMaxChunkSize: config.selectMaxChunkSize ?? config.chunkSize,
      parallelEventProcessing: config.parallelEventProcessing ?? (config.parallel && CAP_PARALLEL_DEFAULT),
      retryAttempts: config.retryAttempts ?? config.maxAttempts ?? CAP_MAX_ATTEMPTS_DEFAULT,
      ...config,
    });
    eventConfig.internalEvent = true;

    this.#basicEventTransformation(eventConfig);
    this.#validateAdHocEvents(this.#eventMap, eventConfig, false);
    this.#basicEventTransformationAfterValidate(eventConfig);
    this.#config.events.push(eventConfig);
    this.#eventMap[this.generateKey(CAP_EVENT_TYPE, serviceName)] = eventConfig;
  }

  addCAPOutboxEventSpecificAction(serviceName, actionName) {
    const subType = [serviceName, actionName].join(".");
    if (this.#eventMap[this.generateKey(CAP_EVENT_TYPE, subType)]) {
      const index = this.#config.events.findIndex(
        (event) => event.type === CAP_EVENT_TYPE && event.subType === serviceName
      );
      this.#config.events.splice(index, 1);
    }

    const eventConfig = this.#sanitizeParamsAdHocEvent({
      ...this.getEventConfig(CAP_EVENT_TYPE, serviceName),
      ...this.getCdsOutboxEventSpecificConfig(serviceName, actionName),
      subType,
    });
    eventConfig.internalEvent = true;

    this.#basicEventTransformation(eventConfig);
    this.#validateAdHocEvents(this.#eventMap, eventConfig, false);
    this.#basicEventTransformationAfterValidate(eventConfig);
    this.#config.events.push(eventConfig);
    this.#eventMap[this.generateKey(CAP_EVENT_TYPE, subType)] = eventConfig;
    return eventConfig;
  }

  #unblockEventLocalState(key, tenant) {
    const map = this.#blockedEvents[key];
    if (!map) {
      return;
    }
    this.#blockedEvents[key][tenant] = false;
    return key;
  }

  isEventBlocked(type, subType, isPeriodicEvent, tenant) {
    const map = this.#blockedEvents[this.generateKey(`${type}${isPeriodicEvent ? SUFFIX_PERIODIC : ""}`, subType)];
    if (!map) {
      return false;
    }
    const tenantSpecific = map[tenant];
    const allTenants = map["*"];
    return tenantSpecific ?? allTenants;
  }

  get isEventQueueActive() {
    return this.#isEventQueueActive;
  }

  set isEventQueueActive(value) {
    this.#isEventQueueActive = value;
  }

  mixFileContentWithEnv(fileContent) {
    fileContent.events ??= [];
    fileContent.periodicEvents ??= [];
    const events = this.#configEvents ?? {};
    const periodicEvents = this.#configPeriodicEvents ?? {};
    const periodicCapServiceEvents = this.#cdsPeriodicOutboxServicesFromEnv();
    fileContent.events = fileContent.events.concat(this.#mapEnvEvents(events));
    fileContent.periodicEvents = fileContent.periodicEvents
      .concat(this.#mapEnvEvents(periodicEvents))
      .concat(this.#mapCapOutboxPeriodicEvent(periodicCapServiceEvents));
    this.fileContent = fileContent;
  }

  #mapCapOutboxPeriodicEvent(periodicEventMap) {
    return Object.values(periodicEventMap);
  }

  #cdsPeriodicOutboxServicesFromEnv() {
    return Object.entries(cds.env.requires).reduce((result, [name, value]) => {
      const config = value.outbox ?? value.queued;
      if (config?.events) {
        for (const fnName in config.events) {
          const base = { ...config };
          const fnConfig = config.events[fnName];
          if (fnConfig.interval || fnConfig.cron) {
            if ("interval" in base || "cron" in base) {
              this.#logger.error(
                "The properties interval|cron must be defined in the event section and will be ignored in the outbox section.",
                { serviceName: name }
              );
              delete base.cron;
              delete base.interval;
            }

            const subType = `${name}.${fnName}`;
            result[subType] = Object.assign(
              {
                type: CAP_EVENT_TYPE,
                subType,
                impl: "./outbox/EventQueueGenericOutboxHandler",
                internalEvent: true,
              },
              base,
              fnConfig
            );
          }
        }
      }
      return result;
    }, {});
  }

  getCdsOutboxEventSpecificConfig(serviceName, action) {
    const srv = cds.env.requires[serviceName];
    const config = srv?.outbox ?? srv?.queued;
    if (config?.events?.[action]) {
      return config.events[action];
    } else {
      return null;
    }
  }

  #mapEnvEvents(events) {
    return Object.entries(events)
      .map(([key, event]) => {
        if (!event) {
          return;
        }
        const [type, subType] = key.split("/");
        event.type ??= type;
        event.subType ??= subType;
        return { ...event };
      })
      .filter((a) => a);
  }

  set fileContent(config) {
    config.events = config.events ?? [];
    config.periodicEvents = config.periodicEvents ?? [];
    this.#eventMap = config.events.reduce((result, event) => {
      const eventSanitized = this.#sanitizeParamsAdHocEvent(event);
      this.#basicEventTransformation(eventSanitized);
      this.#validateAdHocEvents(result, eventSanitized);
      this.#basicEventTransformationAfterValidate(eventSanitized);
      result[this.generateKey(eventSanitized.type, eventSanitized.subType)] = eventSanitized;
      return result;
    }, {});
    this.#eventMap = config.periodicEvents.reduce((result, event) => {
      const eventSanitized = this.#sanitizeParamsPeriodicEventEvent(event);
      eventSanitized.type = `${eventSanitized.type}${SUFFIX_PERIODIC}`;
      eventSanitized.isPeriodic = true;
      this.#basicEventTransformation(eventSanitized);
      this.#validatePeriodicConfig(result, eventSanitized);
      this.#basicEventTransformationAfterValidate(eventSanitized);
      result[this.generateKey(eventSanitized.type, eventSanitized.subType)] = eventSanitized;
      return result;
    }, this.#eventMap);
    this.#config = config;
  }

  #basicEventTransformation(event) {
    event.load = event.load ?? DEFAULT_LOAD;
    event.priority = event.priority ?? DEFAULT_PRIORITY;
    event.increasePriorityOverTime = event.increasePriorityOverTime ?? DEFAULT_INCREASE_PRIORITY;
    event.keepAliveInterval = event.keepAliveInterval ?? DEFAULT_KEEP_ALIVE_INTERVAL;
    event.keepAliveMaxInProgressTime = event.keepAliveInterval * DEFAULT_MAX_FACTOR_STUCK_2_KEEP_ALIVE_INTERVAL;
    event.checkForNextChunk = event.checkForNextChunk ?? DEFAULT_CHECK_FOR_NEXT_CHUNK;
    event.namespace = event.namespace === undefined ? this.#publishNamespace : event.namespace;
  }

  #sanitizeParamsBase(config, allowList) {
    return Object.entries(config).reduce((result, [name, value]) => {
      if (allowList.includes(name)) {
        result[name] = value;
      }
      return result;
    }, {});
  }

  #sanitizeParamsAdHocEvent(config) {
    return this.#sanitizeParamsBase(config, ALLOWED_EVENT_OPTIONS_AD_HOC);
  }

  #sanitizeParamsPeriodicEventEvent(config) {
    return this.#sanitizeParamsBase(config, ALLOWED_EVENT_OPTIONS_PERIODIC_EVENT);
  }

  #basicEventTransformationAfterValidate(event) {
    event._appNameMap = event.appNames
      ? Object.fromEntries(new Map(event.appNames.map((a) => [a, this.#parseRegexOrString(a)])))
      : null;
    event._appNameContainsRegex = event.appNames
      ? event.appNames.some((appName) => this.#parseRegexOrString(appName).type === "regex")
      : null;
    event._appInstancesMap = event.appInstances
      ? Object.fromEntries(new Map(event.appInstances.map((a) => [a, true])))
      : null;
  }

  #basicEventValidation(event) {
    if (!event.impl) {
      throw EventQueueError.missingImpl(event.type, event.subType);
    }

    if (!event.type) {
      throw EventQueueError.missingType(event);
    }

    if (!event.subType) {
      throw EventQueueError.missingSubType(event);
    }

    if (event.appNames) {
      if (!Array.isArray(event.appNames) || event.appNames.some((appName) => typeof appName !== "string")) {
        throw EventQueueError.appNamesFormat(event.type, event.subType, event.appNames);
      }
    }

    if (event.appInstances) {
      if (
        !Array.isArray(event.appInstances) ||
        event.appInstances.some((appInstance) => typeof appInstance !== "number")
      ) {
        throw EventQueueError.appInstancesFormat(event.type, event.subType, event.appInstances);
      }
    }

    if (!PRIORITIES.includes(event.priority)) {
      throw EventQueueError.priorityNotAllowed(event.priority, "initEvent");
    }

    if (event.load > this.#instanceLoadLimit) {
      throw EventQueueError.loadHigherThanLimit(event.load, "initEvent");
    }
  }

  #validatePeriodicConfig(eventMap, event) {
    const key = this.generateKey(event.type, event.subType);
    if (eventMap[key] && eventMap[key].isPeriodic) {
      throw EventQueueError.duplicateEventRegistration(event.type, event.subType);
    }

    if (!event.cron && !event.interval) {
      throw EventQueueError.noCronOrInterval(event.type, event.subType);
    }

    if (event.cron && event.interval) {
      throw EventQueueError.cronAndInterval(event.type, event.subType);
    }

    if (event.cron) {
      let cron;

      // NOTE: logic is as follows:
      // - if event.utc is true --> always use UTC (default is false)
      // - if event.useCronTimezone is false OR event.cronTimezone is not defined --> use UTC as well
      // - if event.utc is not true AND event.cronTimezone is set AND event.useCronTimezone is NOT set to false use event.cronTimezone
      event.utc = event.utc ?? UTC_DEFAULT;
      if (!this.cronTimezone) {
        event.useCronTimezone = false;
      } else {
        event.useCronTimezone = event.useCronTimezone ?? USE_CRON_TZ_DEFAULT;
      }

      event.tz = event.utc || !event.useCronTimezone ? "UTC" : this.cronTimezone;

      try {
        cron = CronExpressionParser.parse(event.cron);
      } catch {
        throw EventQueueError.cantParseCronExpression(event.type, event.subType, event.cron);
      }
      const next = cron.next();
      const afterNext = cron.next();
      const diffInSeconds = (afterNext.getTime() - next.getTime()) / 1000;
      if (diffInSeconds <= MIN_INTERVAL_SEC) {
        throw EventQueueError.invalidIntervalBetweenCron(event.type, event.subType, diffInSeconds);
      }
      return this.#basicEventValidation(event);
    }

    if (!event.interval || event.interval <= MIN_INTERVAL_SEC) {
      throw EventQueueError.invalidInterval(event.type, event.subType, event.interval);
    }

    this.#basicEventValidation(event);
  }

  #validateAdHocEvents(eventMap, event, checkForDuplication = true) {
    const key = this.generateKey(event.type, event.subType);
    if (eventMap[key] && !eventMap[key].isPeriodic && checkForDuplication) {
      throw EventQueueError.duplicateEventRegistration(event.type, event.subType);
    }

    if (this.isMultiTenancy && event.multiInstanceProcessing) {
      throw EventQueueError.multiInstanceProcessingNotAllowed(event.type, event.subType);
    }
    event.inheritTraceContext = event.inheritTraceContext ?? DEFAULT_INHERIT_TRACE_CONTEXT;

    if (event.timeBucket) {
      try {
        CronExpressionParser.parse(event.timeBucket);
      } catch {
        throw EventQueueError.cantParseCronExpression(event.type, event.subType, event.timeBucket);
      }
    }

    this.#basicEventValidation(event);
  }

  generateKey(type, subType) {
    return [type, subType].join("##");
  }

  removeEvent(type, subType) {
    const index = this.#config.events.findIndex((event) => event.type === "CAP_OUTBOX");
    if (index >= 0) {
      this.#config.events.splice(index, 1);
    }
    delete this.#eventMap[this.generateKey(type, subType)];
  }

  isTenantUnsubscribed(tenantId) {
    return this.#unsubscribedTenants[tenantId];
  }

  shouldProcessNamespace(namespace) {
    if (namespace === null) {
      return this.#processDefaultNamespace;
    }

    return this.#processingNamespaces.includes(namespace);
  }

  get fileContent() {
    return this.#config;
  }

  get events() {
    return Object.values(this.#eventMap).filter((e) => !e.isPeriodic);
  }

  set configEvents(value) {
    this.#configEvents = JSON.parse(JSON.stringify(value));
  }

  get hasConfigEvents() {
    return !!(Object.keys(this.#configEvents ?? {}).length || Object.keys(this.#configPeriodicEvents ?? {}).length);
  }

  set configPeriodicEvents(value) {
    this.#configPeriodicEvents = JSON.parse(JSON.stringify(value));
  }

  get periodicEvents() {
    return Object.values(this.#eventMap).filter((e) => e.isPeriodic);
  }

  isPeriodicEvent(type, subType) {
    return this.#eventMap[this.generateKey(type, subType)]?.isPeriodic;
  }

  get allEvents() {
    return Object.values(this.#eventMap);
  }

  get forUpdateTimeout() {
    return this.#forUpdateTimeout;
  }

  get globalTxTimeout() {
    return this.#globalTxTimeout;
  }

  set forUpdateTimeout(value) {
    this.#forUpdateTimeout = value;
  }

  get publishEventBlockList() {
    return this.#publishEventBlockList;
  }

  set publishEventBlockList(value) {
    this.#publishEventBlockList = value;
  }

  get crashOnRedisUnavailable() {
    return this.#crashOnRedisUnavailable;
  }

  set crashOnRedisUnavailable(value) {
    this.#crashOnRedisUnavailable = value;
  }

  get tenantIdFilterAuthContext() {
    return this.#tenantIdFilterAuthContextCb;
  }

  set tenantIdFilterAuthContext(value) {
    this.#tenantIdFilterAuthContextCb = value;
  }

  get tenantIdFilterEventProcessing() {
    return this.#tenantIdFilterEventProcessingCb;
  }

  set tenantIdFilterEventProcessing(value) {
    this.#tenantIdFilterEventProcessingCb = value;
  }

  set globalTxTimeout(value) {
    this.#globalTxTimeout = value;
  }

  get runInterval() {
    return this.#runInterval;
  }

  set runInterval(value) {
    if (!Number.isInteger(value) || value <= 10 * 1000) {
      throw EventQueueError.invalidInterval();
    }
    this.#runInterval = value;
  }

  get redisEnabled() {
    return this.#redisEnabled;
  }

  set redisEnabled(value) {
    this.#redisEnabled = value;
  }

  get initialized() {
    return this.#initialized;
  }

  set initialized(value) {
    this.#initialized = value;
  }

  get cronTimezone() {
    return this.#cronTimezone;
  }

  set cronTimezone(value) {
    this.#cronTimezone = value;
  }

  get randomOffsetPeriodicEvents() {
    return this.#randomOffsetPeriodicEvents;
  }

  set randomOffsetPeriodicEvents(value) {
    this.#randomOffsetPeriodicEvents = value;
  }

  get instanceLoadLimit() {
    return this.#instanceLoadLimit;
  }

  set instanceLoadLimit(value) {
    this.#instanceLoadLimit = value;
  }

  get isEventBlockedCb() {
    return this.#isEventBlockedCb;
  }

  set isEventBlockedCb(value) {
    this.#isEventBlockedCb = value;
  }

  get tableNameEventQueue() {
    return BASE_TABLES.EVENT;
  }

  get tableNameEventLock() {
    return BASE_TABLES.LOCK;
  }

  set configFilePath(value) {
    this.#configFilePath = value;
  }

  get configFilePath() {
    return this.#configFilePath;
  }

  set processEventsAfterPublish(value) {
    this.#processEventsAfterPublish = value;
  }

  get processEventsAfterPublish() {
    return this.#processEventsAfterPublish;
  }

  set disableRedis(value) {
    this.#disableRedis = value;
  }

  get disableRedis() {
    return this.#disableRedis;
  }

  set updatePeriodicEvents(value) {
    this.#updatePeriodicEvents = value;
  }

  get updatePeriodicEvents() {
    return this.#updatePeriodicEvents;
  }

  set registerAsEventProcessor(value) {
    this.#registerAsEventProcessor = value;
  }

  get registerAsEventProcessor() {
    return this.#registerAsEventProcessor;
  }

  set thresholdLoggingEventProcessing(value) {
    this.#thresholdLoggingEventProcessing = value;
  }

  get thresholdLoggingEventProcessing() {
    return this.#thresholdLoggingEventProcessing;
  }

  set useAsCAPOutbox(value) {
    this.#useAsCAPOutbox = value;
  }

  get useAsCAPOutbox() {
    return this.#useAsCAPOutbox;
  }

  set userId(value) {
    this.#userId = value;
  }

  get userId() {
    return this.#userId;
  }

  set cleanupLocksAndEventsForDev(value) {
    this.#cleanupLocksAndEventsForDev = value;
  }

  get cleanupLocksAndEventsForDev() {
    return this.#cleanupLocksAndEventsForDev;
  }

  set redisOptions(value) {
    this.#redisOptions = value;
  }

  get redisOptions() {
    return {
      ...this.#redisOptions,
      redisNamespace: `${[REDIS_PREFIX, this.redisNamespace].filter((a) => a).join("_")}`,
    };
  }

  set redisNamespace(value) {
    this.#redisNamespace = value;
  }

  get redisNamespace() {
    return this.#redisNamespace;
  }

  set insertEventsBeforeCommit(value) {
    this.#insertEventsBeforeCommit = value;
  }

  get insertEventsBeforeCommit() {
    return this.#insertEventsBeforeCommit;
  }

  set enableTelemetry(value) {
    this.#enableTelemetry = value;
  }

  get enableTelemetry() {
    return this.#enableTelemetry;
  }

  get isMultiTenancy() {
    return !!cds.requires.multitenancy;
  }

  get _rawEventMap() {
    return this.#eventMap;
  }

  get developmentMode() {
    return cds.env.profiles.find((profile) => profile === "development");
  }

  get enableAdminService() {
    return this.#enableAdminService;
  }

  set enableAdminService(value) {
    this.#enableAdminService = value;
  }

  get disableProcessingOfSuspendedTenants() {
    return this.#disableProcessingOfSuspendedTenants;
  }

  set disableProcessingOfSuspendedTenants(value) {
    this.#disableProcessingOfSuspendedTenants = value;
  }

  get publishNamespace() {
    return this.#publishNamespace;
  }

  set publishNamespace(value) {
    this.#publishNamespace = value;
  }

  get processingNamespaces() {
    return this.#processingNamespaces;
  }

  set processingNamespaces(value) {
    this.#processingNamespaces = value.filter((value) => value !== null);
    this.#processDefaultNamespace = value.some((value) => value === null);
  }

  get processDefaultNamespace() {
    return this.#processDefaultNamespace;
  }

  /**
    @return { Config }
  **/
  static get instance() {
    if (!Config.#instance) {
      Config.#instance = new Config();
    }
    return Config.#instance;
  }
}

const instance = Config.instance;

module.exports = instance;
