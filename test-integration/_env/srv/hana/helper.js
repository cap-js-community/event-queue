"use strict";

const { promisify } = require("util");
const fs = require("fs");
const path = require("path");

const hdb = require("hdb");
const cds = require("@sap/cds");

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

const createClient = async (credentials) => {
  const _client = hdb.createClient(credentials);
  const connect = promisify(_client.connect).bind(_client);
  const disconnect = promisify(_client.disconnect).bind(_client);
  const prepare = promisify(_client.prepare).bind(_client);
  const exec = (command) =>
    new Promise((resolve, reject) => {
      _client.exec(command, (err, values, ...results) => {
        if (err) {
          reject(err);
        } else {
          resolve({ values, results });
        }
      });
    });
  const commit = promisify(_client.commit).bind(_client);
  await connect();
  return {
    _client,
    connect,
    disconnect,
    prepare,
    exec,
    commit,
  };
};

const callStoredProcedure = async (client, sql) => {
  const response = await client.exec(sql);
  const messages = response.results[0];
  messages.forEach((message) => {
    logger[procedureLogLevelMap[message.SEVERITY]](message.MESSAGE);
  });
  return response;
};

async function createNewSchema(client, schemaName) {
  await callStoredProcedure(client, `CALL dbadmin.afc_create_test_schema ('${schemaName}', ?)`);
  logger.info("Schema created", { schema: schemaName, createdAt: new Date().toISOString() });
}

async function deleteTestSchema(schemaGuid) {
  const schema = generateSchemaName(schemaGuid);
  const client = await createClient(Object.assign({}, SYSTEM_USER, DB_CONNECTION));
  await callStoredProcedure(client, `CALL dbadmin.afc_drop_test_schema ('${schema}', ?)`);
  logger.info("Schema deleted", { schema });
}

async function createTestSchema(customSchemaName) {
  const client = await createClient(Object.assign({}, SYSTEM_USER, DB_CONNECTION));
  await createNewSchema(client, customSchemaName);
  await client.disconnect();
}

async function prepareTestSchema(schemaGuid) {
  const schema = generateSchemaName(schemaGuid);
  await createTestSchema(schema);
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

const deployToHana = async (csn) => {
  const t0 = Date.now();
  const transaction = cds.tx();
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
    process.exit(1);
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

module.exports = {
  prepareTestSchema,
  deployToHana,
  generateCredentialsForCds,
  deleteTestSchema,
  findTestFiles,
};
