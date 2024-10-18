"use strict";

const { calculateFutureDate } = require("../src/periodicEvents");

describe("calculateFutureDate function", () => {
  beforeAll(() => {
    jest.useFakeTimers();
  });

  test("Current time is exact match", () => {
    const now = new Date("2024-10-18T12:00:00.000Z");
    jest.setSystemTime(now);
    const interval = 30;
    const desiredTime = "14:00";
    const result = calculateFutureDate(interval, desiredTime, true);
    expect(result.toISOString()).toEqual("2024-10-18T12:00:00.000Z");
  });

  test("Current time is before the desired time", () => {
    const now = new Date("2024-10-18T13:59:05.000Z");
    jest.setSystemTime(now);
    const interval = 30;
    const desiredTime = "14:00";
    const result = calculateFutureDate(interval, desiredTime, true);
    expect(result.toISOString()).toEqual("2024-10-18T13:59:00.000Z");
  });

  test("Current time is after the desired time", () => {
    const now = new Date("2024-10-18T14:00:05.000Z");
    jest.setSystemTime(now);
    const interval = 30;
    const desiredTime = "14:00";
    const result = calculateFutureDate(interval, desiredTime, true);
    expect(result.toISOString()).toEqual("2024-10-18T14:00:00.000Z");
  });

  test("Should also work for 24 hour intervals - desired shortly before current time", () => {
    const now = new Date("2024-10-18T14:00:00.000Z");
    jest.setSystemTime(now);
    const interval = 24 * 60 * 60; // 1 day
    const desiredTime = "13:00";
    const result = calculateFutureDate(interval, desiredTime, true);
    expect(result.toISOString()).toEqual("2024-10-18T13:00:00.000Z");
  });

  test("Should also work for 24 hour intervals - desired shortly after current time", () => {
    const now = new Date("2024-10-18T14:00:00.000Z");
    jest.setSystemTime(now);
    const interval = 24 * 60 * 60; // 1 day
    const desiredTime = "15:00";
    const result = calculateFutureDate(interval, desiredTime, true);
    expect(result.toISOString()).toEqual("2024-10-17T15:00:00.000Z");
  });
});
