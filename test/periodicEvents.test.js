"use strict";

const path = require("path");
const fs = require("fs");

const cds = require("@sap/cds/lib");
const yaml = require("yaml");

const eventQueue = require("../src");
const { Logger: mockLogger } = require("./mocks/logger");
const { checkAndInsertPeriodicEvents } = require("../src/periodicEvents");
const config = require("../src/config");
const { selectEventQueueAndReturn } = require("./helper");
const { EventProcessingStatus } = require("../src/constants");
const project = __dirname + "/.."; // The project's root folder
cds.test(project);

describe("baseFunctionality", () => {
  let loggerMock, context, tx, fileContent;
  beforeAll(async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2023-11-13T11:00:00.000Z"));
    const configFilePath = path.join(__dirname, "asset", "config.yml");
    await eventQueue.initialize({
      configFilePath,
      processEventsAfterPublish: false,
      registerAsEventProcessor: false,
      updatePeriodicEvents: false,
    });

    loggerMock = mockLogger();
    jest.spyOn(cds, "log").mockImplementation((layer) => {
      return mockLogger(layer);
    });
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    jest.setSystemTime(new Date("2023-11-13T11:00:00.000Z"));
    context = new cds.EventContext({ user: "testUser", tenant: 123 });
    tx = cds.tx(context);
    fileContent = yaml.parse(fs.readFileSync(path.join(__dirname, "asset", "config.yml"), "utf8").toString());

    await tx.run(DELETE.from("sap.eventqueue.Lock"));
    await tx.run(DELETE.from("sap.eventqueue.Event"));
  });

  afterEach(async () => {
    await tx.rollback();
  });

  describe("interval events", () => {
    beforeEach(() => {
      config.mixFileContentWithEnv({
        periodicEvents: fileContent.periodicEvents.filter((e) => !e.cron).map((e) => ({ ...e })),
      });
    });
    it("basic insert all new events", async () => {
      await checkAndInsertPeriodicEvents(context);

      expect(loggerMock.callsLengths().error).toEqual(0);
      expect(loggerMock.calls().info).toMatchSnapshot();
      expect(await selectEventQueueAndReturn(tx, { expectedLength: 6 })).toMatchSnapshot();
    });

    it("delta insert", async () => {
      await checkAndInsertPeriodicEvents(context);

      const fileContent = config.fileContent;
      fileContent.periodicEvents[0].type = "HealthCheck";
      fileContent.periodicEvents = [fileContent.periodicEvents[0]];
      fileContent.periodicEvents.push({
        ...config.fileContent.periodicEvents[0],
        type: "HealthCheck",
        subType: "DB2",
      });
      config.fileContent = fileContent;

      await checkAndInsertPeriodicEvents(context);

      fileContent.periodicEvents.splice(1, 2);
      fileContent.periodicEvents[0].type = "HealthCheck";
      config.fileContent = fileContent;
      expect(loggerMock.callsLengths().error).toEqual(0);
      expect(loggerMock.calls().info).toMatchSnapshot();
      const test = await selectEventQueueAndReturn(tx, { expectedLength: 7, additionalColumns: ["type", "subType"] });
      expect(test).toMatchSnapshot();
    });

    describe("interval change", () => {
      it("if too far in future update", async () => {
        const refEvent = fileContent.periodicEvents[0];
        config.fileContent = { events: [], periodicEvents: [{ ...refEvent }] };
        await checkAndInsertPeriodicEvents(context);
        refEvent.interval = 450;
        config.fileContent = { events: [], periodicEvents: [{ ...refEvent }] };

        // events are inserted with current date --> so we need to update
        await tx.run(
          UPDATE.entity("sap.eventqueue.Event")
            .set({
              startAfter: new Date("2023-11-13T12:00:00.000Z"),
            })
            .where({ subType: refEvent.subType })
        );
        await checkAndInsertPeriodicEvents(context);

        expect(loggerMock.callsLengths().error).toEqual(0);
        expect(loggerMock.calls().info).toMatchSnapshot();
        expect(
          await selectEventQueueAndReturn(tx, { expectedLength: 2, additionalColumns: ["type", "subType"] })
        ).toMatchSnapshot();
      });

      it("if interval is increased next event will autocorrect", async () => {
        const refEvent = fileContent.periodicEvents[0];
        config.fileContent = { events: [], periodicEvents: [{ ...refEvent }] };
        await checkAndInsertPeriodicEvents(context);
        refEvent.interval = 450;
        config.fileContent = { events: [], periodicEvents: [{ ...refEvent }] };

        // events are inserted with current date --> so we need to update
        await tx.run(
          UPDATE.entity("sap.eventqueue.Event")
            .set({
              startAfter: new Date("2023-11-13T10:00:00.000Z"),
            })
            .where({ subType: refEvent.subType })
        );
        await checkAndInsertPeriodicEvents(context);

        expect(loggerMock.callsLengths().error).toEqual(0);
        expect(loggerMock.calls().info).toMatchSnapshot();
        expect(
          await selectEventQueueAndReturn(tx, { expectedLength: 2, additionalColumns: ["type", "subType"] })
        ).toMatchSnapshot();
      });
    });

    it("if periodic event is in progress - no insert should happen", async () => {
      await checkAndInsertPeriodicEvents(context);

      await tx.run(
        UPDATE.entity("sap.eventqueue.Event").set({
          status: EventProcessingStatus.InProgress,
        })
      );
      await checkAndInsertPeriodicEvents(context);

      expect(loggerMock.callsLengths().error).toEqual(0);
      expect(loggerMock.calls().info).toMatchSnapshot();
      expect(await selectEventQueueAndReturn(tx, { expectedLength: 6 })).toMatchSnapshot();
    });
  });

  describe("cron events", () => {
    const cronExpressions = [
      "0 * * * *", // Runs at the start of every hour.
      "* * * * *", // Runs every minute.
      "0 0 * * *", // Runs at midnight every day.
      "0 0 * * 0", // Runs at midnight every Sunday.
      "30 8 * * 1-5", // Runs at 8:30 AM, Monday through Friday.
      "0 9,17 * * *", // Runs at 9:00 AM and 5:00 PM every day.
      "0 12 * * 1", // Runs at 12:00 PM every Monday.
      "15 14 1 * *", // Runs at 2:15 PM on the 1st of every month.
      "0 22 * * 5", // Runs at 10:00 PM every Friday.
      "0 5 1 1 *", // Runs at 5:00 AM on January 1st each year.
      "*/15 * * * *", // Runs every 15 minutes.
      "0 0 1-7 * 0", // Runs at midnight on the first Sunday of every month.
      "0 8-17/2 * * *", // Runs every 2 hours between 8:00 AM and 5:00 PM.
      "0 0 1 * *", // Runs at midnight on the first day of every month.
      "0 0 1 1 *", // Runs at midnight on January 1st every year.
      "0 3 * * 2", // Runs at 3:00 AM every Tuesday.
      "45 23 * * *", // Runs at 11:45 PM every day.
      "5,10,15 10 * * *", // Runs at 10:05, 10:10, and 10:15 every day.
      "0 0 * 5 *", // Runs at midnight every day in May.
      "0 6 * * 2-4", // Runs at 6:00 AM every Tuesday, Wednesday, and Thursday.
    ];

    describe("Cron expression tests", () => {
      it.each(cronExpressions)("should test cron expression: '%s'", async (cronExpression) => {
        config.fileContent = {
          events: fileContent.events,
          periodicEvents: [
            {
              ...fileContent.periodicEvents.find((e) => e.cron === "* * * * *"),
              cron: cronExpression,
            },
          ],
        };
        await checkAndInsertPeriodicEvents(context);
        expect(loggerMock.callsLengths().error).toEqual(0);
        expect(loggerMock.calls().info).toMatchSnapshot(cronExpression);
        expect(await selectEventQueueAndReturn(tx, { expectedLength: 2 })).toMatchSnapshot();
      });

      it("should calculate different dates for timezones", async () => {
        const periodicEventsCron = fileContent.periodicEvents
          .filter((e) => e.cron)
          .map((e) => {
            e.cron = "30 8 * * 1-5"; // Runs at 8:30 AM, Monday through Friday.
            e.utc = false;
            return e;
          });
        config.fileContent = {
          events: fileContent.events,
          periodicEvents: [periodicEventsCron[0]],
        };
        config.cronTimezone = "US/Hawaii";
        await checkAndInsertPeriodicEvents(context);
        const events = await selectEventQueueAndReturn(tx, {
          type: "TimeSpecificEveryMin_PERIODIC",
          expectedLength: 1,
          additionalColumns: ["type"],
        });
        expect(events[0].startAfter).toMatchInlineSnapshot(`"2023-11-13T18:30:00.000Z"`);

        config.cronTimezone = "Europe/Berlin";
        await checkAndInsertPeriodicEvents(context);

        const eventsAfterTimezoneChange = await selectEventQueueAndReturn(tx, {
          type: "TimeSpecificEveryMin_PERIODIC",
          expectedLength: 1,
          additionalColumns: ["type"],
        });
        expect(eventsAfterTimezoneChange[0].startAfter).toMatchInlineSnapshot(`"2023-11-14T07:30:00.000Z"`);
      });

      describe("changed intervals", () => {
        it("not changed interval --> no update", async () => {
          config.fileContent = {
            events: fileContent.events,
            periodicEvents: [
              {
                ...fileContent.periodicEvents.find((e) => e.cron === "* * * * *"),
                cron: "* * * * *",
              },
            ],
          };
          await checkAndInsertPeriodicEvents(context);
          jest.clearAllMocks();
          await checkAndInsertPeriodicEvents(context);
          expect(loggerMock.calls().info).toMatchSnapshot();
          expect(await selectEventQueueAndReturn(tx, { expectedLength: 2 })).toMatchSnapshot();
        });

        it("changed interval", async () => {
          config.fileContent = {
            events: fileContent.events,
            periodicEvents: [
              {
                ...fileContent.periodicEvents.find((e) => e.cron === "* * * * *"),
                cron: "* * * * *",
              },
            ],
          };
          await checkAndInsertPeriodicEvents(context);
          jest.clearAllMocks();
          config.fileContent = {
            events: fileContent.events,
            periodicEvents: [
              {
                ...fileContent.periodicEvents.find((e) => e.cron === "* * * * *"),
                cron: "0 0 * * *",
              },
            ],
          };
          await checkAndInsertPeriodicEvents(context);
          expect(loggerMock.calls().info).toMatchSnapshot();
          expect(await selectEventQueueAndReturn(tx, { expectedLength: 2 })).toMatchSnapshot();
        });

        it("interval multiple times overdue", async () => {
          config.fileContent = {
            events: fileContent.events,
            periodicEvents: [
              {
                ...fileContent.periodicEvents.find((e) => e.cron === "* * * * *"),
                cron: "* * * * *",
              },
            ],
          };
          await checkAndInsertPeriodicEvents(context);
          jest.clearAllMocks();

          // NOTE: same interval but expedited by one day
          jest.setSystemTime(new Date("2023-11-14T11:00:00.000Z"));
          config.fileContent = {
            events: fileContent.events,
            periodicEvents: [
              {
                ...fileContent.periodicEvents.find((e) => e.cron === "* * * * *"),
                cron: "* * * * *",
              },
            ],
          };
          await checkAndInsertPeriodicEvents(context);
          expect(loggerMock.calls().info).toMatchSnapshot();
          expect(await selectEventQueueAndReturn(tx, { expectedLength: 2 })).toMatchSnapshot();
        });
      });
    });
  });
});
