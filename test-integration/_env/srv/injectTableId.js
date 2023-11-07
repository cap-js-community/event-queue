"use strict";

const tableId = process.env.TABLE_GUID;
if (!tableId) {
  // eslint-disable-next-line no-console
  console.error("missing tableId in env section");
  process.exit(-1);
}
// eslint-disable-next-line no-console
console.log("table id", tableId);
process.exit(1);
