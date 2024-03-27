"use strict";

jest.mock("@sap/cds", () => ({
  requires: { auth: { credentials: "cred" } },
  log: jest.fn().mockReturnValue({ warn: jest.fn() }),
}));

jest.mock("@sap/xssec", () => ({
  requests: { requestClientCredentialsToken: jest.fn() },
  createSecurityContext: jest.fn(),
}));

const {
  getAuthInfo,
  __: { clearAuthInfoCache },
} = require("../src/shared/common");
const xssec = require("@sap/xssec");
const cds = require("@sap/cds");

describe("getAuthInfo", () => {
  beforeEach(() => {
    clearAuthInfoCache();
    xssec.requests.requestClientCredentialsToken.mockRestore();
    xssec.createSecurityContext.mockRestore();
    jest.clearAllMocks();
  });

  it("should return null when no credentials provided", async () => {
    cds.requires.auth.credentials = null;
    const result = await getAuthInfo("1");
    expect(result).toBeNull();
    expect(cds.log().warn.mock.calls).toHaveLength(0);
  });

  it("should set and return new AuthInfo", async () => {
    cds.requires.auth.credentials = "cred";
    xssec.requests.requestClientCredentialsToken.mockImplementationOnce((a, b, c, d, cb) => cb(null, "token"));
    xssec.createSecurityContext.mockImplementationOnce((a, b, cb) => cb(null, { getExpirationDate: () => new Date() }));
    const result = await getAuthInfo("1");
    expect(result).toBeDefined();
    expect(cds.log().warn.mock.calls).toHaveLength(0);
  });

  it("should use cache for the second call", async () => {
    cds.requires.auth.credentials = "cred";
    xssec.requests.requestClientCredentialsToken.mockImplementation((a, b, c, d, cb) => cb(null, "token"));
    xssec.createSecurityContext.mockImplementation((a, b, cb) =>
      cb(null, { getExpirationDate: () => new Date(Date.now() + 61 * 1000) })
    );
    const result = await getAuthInfo("1");
    expect(result).toBeDefined();

    const result2 = await getAuthInfo("1");
    expect(result).toEqual(result2);

    expect(xssec.requests.requestClientCredentialsToken).toHaveBeenCalledTimes(1);
    expect(xssec.createSecurityContext).toHaveBeenCalledTimes(1);
    expect(cds.log().warn.mock.calls).toHaveLength(0);
  });

  it("should use cache for parallel calls", async () => {
    cds.requires.auth.credentials = "cred";
    xssec.requests.requestClientCredentialsToken.mockImplementation((a, b, c, d, cb) => {
      setTimeout(cb, 5);
    });
    xssec.createSecurityContext.mockImplementation((a, b, cb) =>
      cb(null, { getExpirationDate: () => new Date(Date.now() + 65 * 1000) })
    );
    const resultPromise = getAuthInfo("1");
    const resultPromise2 = getAuthInfo("1");

    const [result1, result2] = await Promise.all([resultPromise, resultPromise2]);

    expect(result1).toEqual(result2);
    expect(xssec.requests.requestClientCredentialsToken).toHaveBeenCalledTimes(1);
    expect(xssec.createSecurityContext).toHaveBeenCalledTimes(1);
    expect(cds.log().warn.mock.calls).toHaveLength(0);
  });

  it("should not use cache if validity is below 60 seconds (margin)", async () => {
    cds.requires.auth.credentials = "cred";
    xssec.requests.requestClientCredentialsToken.mockImplementation((a, b, c, d, cb) => cb(null, "token"));
    xssec.createSecurityContext.mockImplementation((a, b, cb) =>
      cb(null, { getExpirationDate: () => new Date(Date.now() + 59 * 1000) })
    );
    const result = await getAuthInfo("1");
    expect(result).toBeDefined();

    const result2 = await getAuthInfo("1");
    expect(result).not.toEqual(result2);

    expect(xssec.requests.requestClientCredentialsToken).toHaveBeenCalledTimes(2);
    expect(xssec.createSecurityContext).toHaveBeenCalledTimes(2);
    expect(cds.log().warn.mock.calls).toHaveLength(0);
  });

  it("should not use cache for different tenants", async () => {
    cds.requires.auth.credentials = "cred";
    xssec.requests.requestClientCredentialsToken.mockImplementation((a, b, c, d, cb) => cb(null, "token"));
    xssec.createSecurityContext.mockImplementation((a, b, cb) =>
      cb(null, { getExpirationDate: () => new Date(Date.now() + 120 * 1000) })
    );
    const result = await getAuthInfo("1");
    expect(result).toBeDefined();

    const result2 = await getAuthInfo("2");
    expect(result).not.toEqual(result2);

    expect(xssec.requests.requestClientCredentialsToken).toHaveBeenCalledTimes(2);
    expect(xssec.createSecurityContext).toHaveBeenCalledTimes(2);
    expect(cds.log().warn.mock.calls).toHaveLength(0);
  });

  it("should handle error", async () => {
    xssec.requests.requestClientCredentialsToken.mockImplementation((a, b, c, d, cb) => cb(new Error(), null));
    const result = await getAuthInfo("1");
    expect(result).toBeUndefined();
    expect(cds.log().warn.mock.calls).toMatchSnapshot();
  });

  it("should clear cache for error case", async () => {
    xssec.requests.requestClientCredentialsToken.mockImplementationOnce((a, b, c, d, cb) => cb(new Error(), null));
    const result = await getAuthInfo("1");
    expect(result).toBeUndefined();
    expect(cds.log().warn.mock.calls).toMatchSnapshot();

    xssec.requests.requestClientCredentialsToken.mockImplementation((a, b, c, d, cb) => cb(null, "token"));
    xssec.createSecurityContext.mockImplementation((a, b, cb) =>
      cb(null, { getExpirationDate: () => new Date(Date.now() + 120 * 1000) })
    );
    const result2 = await getAuthInfo("1");
    expect(result2).toBeDefined();
  });

  it("two parallel requests should get the same error", async () => {
    xssec.requests.requestClientCredentialsToken.mockImplementationOnce((a, b, c, d, cb) => cb(new Error(), null));
    const resultPromise = getAuthInfo("1");
    const resultPromise2 = getAuthInfo("1");

    const [result1, result2] = await Promise.all([resultPromise, resultPromise2]);

    expect(result1).toEqual(result2);
    expect(xssec.requests.requestClientCredentialsToken).toHaveBeenCalledTimes(1);
  });
});
