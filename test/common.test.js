"use strict";

jest.mock("@sap/cds", () => ({
  requires: { auth: { credentials: "cred" } },
  log: jest.fn().mockReturnValue({ warn: jest.fn() }),
}));

jest.mock("@sap/xssec");

const {
  getAuthContext,
  isTenantIdValidCb,
  __: { clearAuthContextCache },
} = require("../src/shared/common");
const xssec = require("@sap/xssec");
const cds = require("@sap/cds");

const tenantId1 = "cc0edebc-58df-44ab-ab1f-1cee383b423e";
const tenantId2 = "61d0f6f5-449d-49c2-980f-cc6b45310b5d";

describe("getAuthContext", () => {
  beforeEach(() => {
    clearAuthContextCache();
    xssec.XsuaaService.mockRestore();
    jest.clearAllMocks();
    cds.requires.auth = {
      kind: "jwt",
      credentials: {},
    };
    cds.requires.multitenancy = true;
  });

  it("should return null when no credentials provided", async () => {
    cds.requires.auth.credentials = null;
    const result = await getAuthContext(tenantId1);
    expect(result).toBeNull();
    expect(cds.log().warn.mock.calls).toHaveLength(0);
  });

  it("should set and return new AuthInfo", async () => {
    jest
      .spyOn(xssec.XsuaaService.prototype, "fetchClientCredentialsToken")
      .mockResolvedValueOnce({ access_token: "token" });
    jest.spyOn(xssec.XsuaaToken.prototype, "constructor").mockReturnValueOnce({
      getExpirationDate: () => new Date(),
    });
    const result = await getAuthContext(tenantId1);
    expect(result).toBeDefined();
    expect(cds.log().warn.mock.calls).toHaveLength(0);
  });

  it("should correctly pass tenant id to xssec", async () => {
    const fetchClientCredentialsTokenSpy = jest
      .spyOn(xssec.XsuaaService.prototype, "fetchClientCredentialsToken")
      .mockResolvedValueOnce({ access_token: "token" });
    jest.spyOn(xssec.XsuaaToken.prototype, "constructor").mockReturnValueOnce({
      getExpirationDate: () => new Date(),
    });
    const result = await getAuthContext(tenantId1);
    expect(result).toBeDefined();
    expect(fetchClientCredentialsTokenSpy).toHaveBeenCalledWith({ zid: tenantId1 });
    expect(cds.log().warn.mock.calls).toHaveLength(0);
    fetchClientCredentialsTokenSpy;
  });

  it("should use cache for the second call", async () => {
    jest
      .spyOn(xssec.XsuaaService.prototype, "fetchClientCredentialsToken")
      .mockResolvedValueOnce({ access_token: "token" });
    jest.spyOn(xssec.XsuaaToken.prototype, "constructor").mockReturnValueOnce({
      getExpirationDate: () => new Date(Date.now() + 61 * 1000),
    });

    const result = await getAuthContext(tenantId1);
    expect(result).toBeDefined();

    const result2 = await getAuthContext(tenantId1);
    expect(result).toEqual(result2);

    expect(xssec.XsuaaService.prototype.fetchClientCredentialsToken).toHaveBeenCalledTimes(1);
    expect(xssec.XsuaaToken.prototype.constructor).toHaveBeenCalledTimes(1);
    expect(cds.log().warn.mock.calls).toHaveLength(0);
  });

  it("should use cache for parallel calls", async () => {
    jest.spyOn(xssec.XsuaaService.prototype, "fetchClientCredentialsToken").mockImplementationOnce(() => {
      return new Promise((resolve) => setTimeout(() => resolve({ access_token: "token" }), 5));
    });
    jest.spyOn(xssec.XsuaaToken.prototype, "constructor").mockReturnValueOnce({
      getExpirationDate: () => new Date(Date.now() + 65 * 1000),
    });

    const resultPromise = getAuthContext(tenantId1);
    const resultPromise2 = getAuthContext(tenantId1);

    const [result1, result2] = await Promise.all([resultPromise, resultPromise2]);

    expect(result1).toEqual(result2);
    expect(xssec.XsuaaService.prototype.fetchClientCredentialsToken).toHaveBeenCalledTimes(1);
    expect(xssec.XsuaaToken.prototype.constructor).toHaveBeenCalledTimes(1);
    expect(cds.log().warn.mock.calls).toHaveLength(0);
  });

  it("should not use cache if validity is below 60 seconds (margin)", async () => {
    jest
      .spyOn(xssec.XsuaaService.prototype, "fetchClientCredentialsToken")
      .mockResolvedValue({ access_token: "token" });
    jest.spyOn(xssec.XsuaaToken.prototype, "constructor").mockImplementation(() => ({
      getExpirationDate: () => new Date(Date.now() + 59 * 1000),
    }));
    const result = await getAuthContext(tenantId1);
    expect(result).toBeDefined();

    const result2 = await getAuthContext(tenantId1);
    expect(result).not.toEqual(result2);

    expect(xssec.XsuaaService.prototype.fetchClientCredentialsToken).toHaveBeenCalledTimes(2);
    expect(xssec.XsuaaToken.prototype.constructor).toHaveBeenCalledTimes(2);
    expect(cds.log().warn.mock.calls).toHaveLength(0);
  });

  it("should not use cache for different tenants", async () => {
    jest
      .spyOn(xssec.XsuaaService.prototype, "fetchClientCredentialsToken")
      .mockResolvedValue({ access_token: "token" });
    jest.spyOn(xssec.XsuaaToken.prototype, "constructor").mockImplementation(() => ({
      getExpirationDate: () => new Date(Date.now() + 59 * 1000),
    }));
    const result = await getAuthContext(tenantId1);
    expect(result).toBeDefined();

    const result2 = await getAuthContext(tenantId2);
    expect(result).not.toEqual(result2);

    expect(xssec.XsuaaService.prototype.fetchClientCredentialsToken).toHaveBeenCalledTimes(2);
    expect(xssec.XsuaaToken.prototype.constructor).toHaveBeenCalledTimes(2);
    expect(cds.log().warn.mock.calls).toHaveLength(0);
  });

  it("should handle error", async () => {
    jest.spyOn(xssec.XsuaaService.prototype, "fetchClientCredentialsToken").mockRejectedValueOnce(new Error());
    const result = await getAuthContext(tenantId1);
    expect(result).toBeUndefined();
    expect(cds.log().warn.mock.calls).toMatchSnapshot();
  });

  it("should clear cache for error case", async () => {
    jest.spyOn(xssec.XsuaaService.prototype, "fetchClientCredentialsToken").mockRejectedValueOnce(new Error());
    const result = await getAuthContext(tenantId1);
    expect(result).toBeUndefined();
    expect(cds.log().warn.mock.calls).toMatchSnapshot();

    jest
      .spyOn(xssec.XsuaaService.prototype, "fetchClientCredentialsToken")
      .mockResolvedValue({ access_token: "token" });
    jest.spyOn(xssec.XsuaaToken.prototype, "constructor").mockReturnValueOnce({
      getExpirationDate: () => new Date(Date.now() + 120 * 1000),
    });
    const result2 = await getAuthContext(tenantId1);
    expect(result2).toBeDefined();
  });

  it("two parallel requests should get the same error", async () => {
    jest.spyOn(xssec.XsuaaService.prototype, "fetchClientCredentialsToken").mockRejectedValueOnce(new Error());
    const resultPromise = getAuthContext(tenantId1);
    const resultPromise2 = getAuthContext(tenantId1);

    const [result1, result2] = await Promise.all([resultPromise, resultPromise2]);

    expect(result1).toEqual(result2);
    expect(xssec.XsuaaService.prototype.fetchClientCredentialsToken).toHaveBeenCalledTimes(1);
    expect(xssec.XsuaaToken.prototype.constructor).toHaveBeenCalledTimes(0);
  });
});

describe("isTenantIdValidCb", () => {
  describe("standard", () => {
    it("should return true for a valid tenant id", async () => {
      expect(await isTenantIdValidCb("cc0edebc-58df-44ab-ab1f-1cee383b423e")).toBe(true);
    });

    it("should also return true for not valid tenant id as there is no check", async () => {
      expect(await isTenantIdValidCb("invalid-tenant-id")).toBe(true);
    });
  });
});
