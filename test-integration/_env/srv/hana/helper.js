"use strict";

const fs = require("fs");
const path = require("path");

const cds = require("@sap/cds");
const HanaService = require("@cap-js/hana/lib/HANAService");

const logger = cds.log("test/hana/deploy");
const DB_CREDENTIALS = JSON.parse(process.env.HANA_DB_CREDENTIALS);
const { SYSTEM_USER, DB_CONNECTION } = DB_CREDENTIALS;
const EVENT_QUEUE_PREFIX = "AFC_TEST_EVENT_QUEUE";

const procedureLogLevelMap = Object.freeze({
  ERROR: "error",
  WARNING: "warn",
  INFO: "info",
  SUCCESS: "info",
  DEBUG: "debug",
});

const callStoredProcedure = async (hanaService, sql) => {
  const response = await hanaService.tx({}, (tx) => tx.run(sql));
  const messages = response.MESSAGES;
  messages.forEach((message) => {
    logger.log({ level: procedureLogLevelMap[message.SEVERITY], message: message.MESSAGE });
  });
  return response;
};

async function createNewSchema(hanaService, schemaName) {
  await callStoredProcedure(hanaService, `CALL DBADMIN.AFC_CREATE_TEST_SCHEMA ('${schemaName}', ?)`);
  logger.info("Schema created", { schema: schemaName, createdAt: new Date().toISOString() });
}

async function deleteTestSchema(hanaAdminService, schemaGuid) {
  const schema = generateSchemaName(schemaGuid);
  await callStoredProcedure(hanaAdminService, `CALL DBADMIN.AFC_DROP_TEST_SCHEMA ('${schema}', ?)`);
  logger.info("Schema deleted", { schema });
}

async function createTestSchema(hanaService, customSchemaName) {
  await createNewSchema(hanaService, customSchemaName);
}

async function prepareTestSchema(hanaService, schemaGuid) {
  const schema = generateSchemaName(schemaGuid);
  await createTestSchema(hanaService, schema);
  return generateCredentialsForCds(schemaGuid);
}

const generateCredentialsForCds = (schemaGuid) => ({
  kind: "hana",
  host: DB_CONNECTION.host,
  port: DB_CONNECTION.port,
  useTLS: DB_CONNECTION.useTLS,
  driver: "com.sap.db.jdbc.Driver",
  url: `jdbc:sap://${DB_CONNECTION.host}:${DB_CONNECTION.port}?encrypt=${
    DB_CONNECTION.useTLS
  }&currentschema=${generateSchemaName(schemaGuid)}`,
  schema: generateSchemaName(schemaGuid),
  user: SYSTEM_USER.user,
  password: SYSTEM_USER.password,
});

const generateSchemaName = (schemaGuid) => `${EVENT_QUEUE_PREFIX}_${schemaGuid}`;

const deployToHana = async (hanaService, csn) => {
  const t0 = Date.now();
  const transaction = hanaService.tx();
  const schema = await transaction.run('SELECT CURRENT_SCHEMA "current_schema" FROM DUMMY');
  logger.info("Deploy running on schema", { schema: schema[0].current_schema });
  try {
    const createTableSqls = cds.compile.to.sql(csn, { sqlDialect: "hana" });
    logger.info("Deploy Tables/Views");
    for (const sql of createTableSqls) {
      await transaction.run(sql);
    }
    await transaction.commit();
    logger.info("Deploy completed", { seconds: (Date.now() - t0) / 1000 });
  } catch (error) {
    logger.error("Deploy failed", error);
    throw error;
  }
};

const _findTestFiles = (dir) => {
  let results = [];
  const files = fs.readdirSync(dir, { withFileTypes: true });

  for (const file of files) {
    const fullPath = path.join(dir, file.name);

    if (file.isDirectory()) {
      results = results.concat(_findTestFiles(fullPath)); // Recursively search subdirectories
    } else if (file.isFile() && file.name.endsWith(".test.js")) {
      results.push(file.name);
    }
  }

  return results;
};

const findTestFiles = () => _findTestFiles(path.join(__dirname, "..", "..", ".."));

async function createAdminHANAService(csn) {
  const hanaService = new HanaService(`dbAdmin`, csn, {
    kind: "hana",
    impl: "@cap-js/hana",
    credentials: Object.assign({}, SYSTEM_USER, DB_CONNECTION),
    pool: {
      acquireTimeoutMillis: 40000,
    },
  });
  await hanaService.init();
  return hanaService;
}

module.exports = {
  prepareTestSchema,
  deployToHana,
  generateCredentialsForCds,
  deleteTestSchema,
  findTestFiles,
  createAdminHANAService,
};
