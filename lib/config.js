'use strict';
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const root = path.join(__dirname, '..');

module.exports = {
  root,
  port: parseInt(process.env.PORT, 10) || 3000,
  dbFile: path.resolve(root, process.env.DB_FILE || 'data/lana.sqlite'),
  sessionSecret: process.env.SESSION_SECRET || '',
  sessionDays: parseInt(process.env.SESSION_DAYS, 10) || 30,
  cookieSecure: process.env.COOKIE_SECURE === '1',
  initialUsers: process.env.INITIAL_USERS || '',
};
