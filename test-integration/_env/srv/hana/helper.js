"use strict";

const { promisify } = require("util");

const hdb = require("hdb");
const cds = require("@sap/cds");

const logger = cds.log("test/hana/deploy");
const DB_CREDENTIALS = JSON.parse(process.env.HANA_DB_CREDENTIALS);
const { SYSTEM_USER, TEST_ADMIN, TEST_WORKER, DB_CONNECTION } = DB_CREDENTIALS;
const EVENT_QUEUE_PREFIX = "EVENT_QUEUE";
const DELETE_SCHEMAS_AFTER = 10 * 60 * 1000;

const createClient = async (credentials) => {
  const _client = hdb.createClient(credentials);
  const connect = promisify(_client.connect).bind(_client);
  const disconnect = promisify(_client.disconnect).bind(_client);
  const prepare = promisify(_client.prepare).bind(_client);
  const exec = promisify(_client.exec).bind(_client);
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

async function prepare() {
  logger.info("Using DB connection", { connection: DB_CONNECTION });
  if (SYSTEM_USER.user && SYSTEM_USER.password) {
    const systemClient = await createClient(Object.assign({}, SYSTEM_USER, DB_CONNECTION));
    await prepareUsers(systemClient);
    await systemClient.disconnect();
  } else {
    logger.info("SYSTEM_USER is not set up. Test users need to exist already\nDelete of old test schemes skipped");
  }
}

async function prepareUsers(client) {
  const users = await getTestUsers(client);
  if (!users.find((user) => user.USER_NAME === TEST_ADMIN.user)) {
    await createPrepareUser(client);
  }
  if (!users.find((user) => user.USER_NAME === TEST_WORKER.user)) {
    await createTestUser(client);
  }
  logger.info(`Test users prepared`);
}

async function createPrepareUser(client) {
  await client.exec(
    `CREATE USER ${TEST_ADMIN.user} PASSWORD "${TEST_ADMIN.password}" NO FORCE_FIRST_PASSWORD_CHANGE SET USERGROUP DEFAULT;`
  );
  await client.exec(`ALTER USER ${TEST_ADMIN.user} DISABLE PASSWORD LIFETIME;`);
  await client.exec(`GRANT CREATE SCHEMA TO  ${TEST_ADMIN.user};`);
}

async function createTestUser(client) {
  await client.exec(
    `CREATE USER ${TEST_WORKER.user} PASSWORD "${TEST_WORKER.password}" NO FORCE_FIRST_PASSWORD_CHANGE SET USERGROUP DEFAULT;`
  );
  await client.exec(`ALTER USER ${TEST_WORKER.user} DISABLE PASSWORD LIFETIME;`);
}

async function getTestUsers(client) {
  return await client.exec(
    `Select USER_NAME, USER_ID
         from SYS.USERS
         WHERE USER_DEACTIVATED = 'FALSE'
           AND USER_NAME LIKE 'AFC_%'`
  );
}

async function createNewSchema(client, schemaName) {
  await client.exec(`CREATE SCHEMA ${schemaName}`);
  logger.info("Schema created", { schema: schemaName, createdAt: new Date().toISOString() });
  await client.exec(`GRANT ALL PRIVILEGES ON SCHEMA ${schemaName} TO ${TEST_WORKER.user}`);
}

async function deleteTestSchema(name, client) {
  await client.exec(`DROP SCHEMA ${name} CASCADE`);
  logger.info("Schema deleted", { schema: name });
}

async function createTestSchema(customSchemaName) {
  const testAdmin = await createClient(Object.assign({}, TEST_ADMIN, DB_CONNECTION));
  await createNewSchema(testAdmin, customSchemaName);
  await testAdmin.disconnect();
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
  user: TEST_WORKER.user,
  password: TEST_WORKER.password,
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

async function deleteExistingSchema() {
  const testAdmin = await createClient(Object.assign({}, TEST_ADMIN, DB_CONNECTION));
  const obsoleteSchemas = await testAdmin.exec(
    `SELECT SCHEMA_NAME, CREATE_TIME
         FROM SYS.SCHEMAS
         WHERE SCHEMA_NAME LIKE '${EVENT_QUEUE_PREFIX}%'
           AND CREATE_TIME <= '${new Date(Date.now() - DELETE_SCHEMAS_AFTER).toISOString()}'`
  );

  obsoleteSchemas.length &&
    logger.info("deleting obsolete schemas...", {
      count: obsoleteSchemas.length,
    });
  for (const { SCHEMA_NAME: schemaName } of obsoleteSchemas) {
    await deleteTestSchema(schemaName, testAdmin);
  }
  await testAdmin.disconnect();
}

module.exports = {
  prepareTestSchema,
  deployToHana,
  prepareHana: prepare,
  generateCredentialsForCds,
  deleteExistingSchema,
};
