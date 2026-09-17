"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const cds = require("@sap/cds");
const { Client } = require("pg");

const COMPONENT_NAME = "/TestEnv/Postgres/Deploy";
const EVENT_QUEUE_PREFIX = "event_queue_test";

const credentials = {
  host: process.env.CDS_REQUIRES_DB_CREDENTIALS_HOST ?? "localhost",
  port: Number(process.env.CDS_REQUIRES_DB_CREDENTIALS_PORT ?? 5432),
  user: process.env.CDS_REQUIRES_DB_CREDENTIALS_USER ?? "postgres",
  password: process.env.CDS_REQUIRES_DB_CREDENTIALS_PASSWORD ?? "postgres",
  database: process.env.CDS_REQUIRES_DB_CREDENTIALS_DATABASE ?? "eventqueue",
};

const _findTestFiles = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).reduce((result, file) => {
    const fullPath = path.join(dir, file.name);
    if (file.isDirectory()) {
      return result.concat(_findTestFiles(fullPath));
    }
    return file.name.endsWith(".test.js") ? result.concat(file.name) : result;
  }, []);

const setActionOutput = (name, value) => {
  const filePath = process.env.GITHUB_OUTPUT;
  if (!filePath) {
    return;
  }
  const delimiter = `ghadelimiter_${cds.utils.uuid()}`;
  fs.appendFileSync(filePath, `${name}<<${delimiter}${os.EOL}${value}${os.EOL}${delimiter}${os.EOL}`);
};

(async () => {
  const logger = cds.log(COMPONENT_NAME);
  try {
    const testFiles = _findTestFiles(path.join(__dirname, "..", "..", ".."));
    const schemas = testFiles.reduce((result, fileName) => {
      result[fileName] = `${EVENT_QUEUE_PREFIX}_${cds.utils.uuid().replace(/-/g, "")}`;
      return result;
    }, {});
    setActionOutput("schemas", JSON.stringify(schemas));

    logger.info("Loading csn");
    const csn = await cds.load("*");
    const createTableSqls = cds.compile.to.sql(csn, { sqlDialect: "postgres" });

    const client = new Client(credentials);
    await client.connect();
    for (const schema of Object.values(schemas)) {
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await client.query(`CREATE SCHEMA "${schema}"`);
      await client.query(`SET search_path TO "${schema}"`);
      for (const sql of createTableSqls) {
        await client.query(sql);
      }
      logger.info("Schema setup complete", { schema });
    }
    await client.end();
    process.exit(0);
  } catch (error) {
    logger.error(error);
    process.exit(-1);
  }
})();
