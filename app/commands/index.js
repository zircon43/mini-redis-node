const stringCommands = require('./string');
const listCommands = require('./list');
const streamCommands = require('./stream');
const zsetCommands = require('./zset');
const serverCommands = require('./server');
const transactionCommands = require('./transactions');
const pubsubCommands = require('./pubsub');
const authCommands = require('./auth');

module.exports = {
  ...stringCommands,
  ...listCommands,
  ...streamCommands,
  ...zsetCommands,
  ...serverCommands,
  ...transactionCommands,
  ...pubsubCommands,
  ...authCommands,
};
