"use strict";

const { promisify } = require("util");

const cds = require("@sap/cds");

const redis = require("../shared/redis");
const distributedLock = require("../shared/distributedLock");
const config = require("../config");
const common = require("../shared/common");
const { runEventCombinationForTenant } = require("../runner/runnerHelper");
const { trace } = require("../shared/openTelemetry");
const { TenantIdCheckTypes } = require("../constants");

const EVENT_MESSAGE_CHANNEL = "EVENT_QUEUE_MESSAGE_CHANNEL";
const COMPONENT_NAME = "/eventQueue/redisPub";
const TRIES_FOR_PUBLISH_PERIODIC_EVENT = 10;
const SLEEP_TIME_FOR_PUBLISH_PERIODIC_EVENT = 30 * 1000;

const wait = promisify(setTimeout);

/**
 * Broadcasts events to the event queue, either locally or through Redis.
 *
 * This function checks if the event queue is active before proceeding to broadcast the events.
 * If the event queue is deactivated, broadcasting is skipped. If Redis is not enabled,
 * events will be processed locally without Redis. The function handles periodic events
 * by checking for locks and only publishing when locks are available.
 *
 * @async
 * @param {string} tenantId - The ID of the tenant for which the events are being broadcasted.
 * @param {Array<{ type: string; subType: string }>} events - An array of event objects, each containing
 *        a type and a subtype that specify the kind of event to be broadcasted.
 * @param {boolean} [forceBroadcast=false] - If true, forces the broadcast of periodic events even
 *        when locks are not available. Defaults to false.
 * @returns {Promise<void>} A promise that resolves when the events have been successfully broadcasted.
 *
 * @throws {Error} Throws an error if publishing events fails.
 *
 * @example
 * // Example usage of broadcastEvent function
 * const tenantId = '12345';
 * const events = [
 *   { type: 'orderCreated', subType: 'online' },
 *   { type: 'paymentProcessed', subType: 'creditCard' }
 * ];
 *
 * broadcastEvent(tenantId, events)
 *   .then(() => console.log('Events broadcasted successfully!'))
 *   .catch(err => console.error('Failed to broadcast events:', err));
 */
const broadcastEvent = async (tenantId, events, forceBroadcast = false) => {
  const logger = cds.log(COMPONENT_NAME);

  if (!config.isEventQueueActive) {
    cds.log(COMPONENT_NAME).info("event-queue is deactivated, broadcasting is skipped!");
    return;
  }

  events = Array.isArray(events) ? events : [events];
  try {
    if (!config.redisEnabled) {
      const tenantShouldBeProcessed = await common.isTenantIdValidCb(TenantIdCheckTypes.eventProcessing, tenantId);
      if (!tenantShouldBeProcessed) {
        return;
      }
      await _processLocalWithoutRedis(tenantId, events);
      return;
    }
    await cds.tx({ tenant: tenantId }, async ({ context }) => {
      await trace(context, "broadcast-inserted-events", async () => {
        for (const { type, subType } of events) {
          const eventConfig = config.getEventConfig(type, subType);
          if (!eventConfig) {
            continue;
          }
          for (let i = 0; i < TRIES_FOR_PUBLISH_PERIODIC_EVENT; i++) {
            const result = eventConfig.multiInstanceProcessing
              ? false
              : await distributedLock.checkLockExistsAndReturnValue(context, [type, subType].join("##"));
            if (result) {
              logger.debug("skip publish redis event as no lock is available", {
                type,
                subType,
                index: i,
                isPeriodic: eventConfig.isPeriodic,
                waitInterval: SLEEP_TIME_FOR_PUBLISH_PERIODIC_EVENT,
              });
              if (!eventConfig.isPeriodic && !forceBroadcast) {
                break;
              }
              await wait(SLEEP_TIME_FOR_PUBLISH_PERIODIC_EVENT);
              continue;
            }
            logger.debug("publishing redis event", {
              tenantId,
              type,
              subType,
            });
            await redis.publishMessage(
              config.redisOptions,
              EVENT_MESSAGE_CHANNEL,
              JSON.stringify({ lockId: cds.utils.uuid(), tenantId, type, subType })
            );
            break;
          }
        }
      });
    });
  } catch (err) {
    logger.error("publish events failed!", err, {
      tenantId,
    });
  }
};

const _processLocalWithoutRedis = async (tenantId, events) => {
  if (config.registerAsEventProcessor) {
    let context = {};
    if (tenantId) {
      const user = await cds.tx({ tenant: tenantId }, async () => {
        const authInfo = await common.getAuthContext(tenantId);
        return new cds.User.Privileged({ id: config.userId, authInfo, tokenInfo: authInfo?.token });
      });
      context = {
        tenant: tenantId,
        user,
      };
    }

    for (const { type, subType } of events) {
      await cds.tx(context, async ({ context }) => {
        await runEventCombinationForTenant(context, type, subType, { shouldTrace: true });
      });
    }
  }
};

module.exports = {
  broadcastEvent,
};
