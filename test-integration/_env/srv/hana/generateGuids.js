"use strict";

const crypto = require("crypto");

const core = require("@actions/core");

const id = crypto.randomUUID().toUpperCase();
core.setOutput("id", id);
