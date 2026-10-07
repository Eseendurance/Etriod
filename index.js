const express = require('express');
const { app } = require('./server/index');

const vercelApp = express();
vercelApp.use(app);

module.exports = vercelApp;
