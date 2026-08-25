function subscribeCommand(args, connection, ctx) {
  const channels = args.slice(1);
  for (const channel of channels) {
     connection.subscribedChannels.add(channel);
     const num = connection.subscribedChannels.size;
     connection.write(`*3\r\n$9\r\nsubscribe\r\n$${channel.length}\r\n${channel}\r\n:${num}\r\n`);
  }
}

function unsubscribeCommand(args, connection, ctx) {
  const channels = args.slice(1);
  if (channels.length === 0 && connection.subscribedChannels) {
     for (const channel of Array.from(connection.subscribedChannels)) {
        connection.subscribedChannels.delete(channel);
        const num = connection.subscribedChannels.size;
        connection.write(`*3\r\n$11\r\nunsubscribe\r\n$${channel.length}\r\n${channel}\r\n:${num}\r\n`);
     }
  } else {
     for (const channel of channels) {
        if (connection.subscribedChannels) {
           connection.subscribedChannels.delete(channel);
        }
        const num = connection.subscribedChannels ? connection.subscribedChannels.size : 0;
        connection.write(`*3\r\n$11\r\nunsubscribe\r\n$${channel.length}\r\n${channel}\r\n:${num}\r\n`);
     }
  }
}

function publishCommand(args, connection, ctx) {
  const channel = args[1];
  const message = args[2];
  let numReceivers = 0;
  for (const c of ctx.clients) {
     if (c.subscribedChannels && c.subscribedChannels.has(channel)) {
        numReceivers++;
        c.write(`*3\r\n$7\r\nmessage\r\n$${channel.length}\r\n${channel}\r\n$${message.length}\r\n${message}\r\n`);
     }
  }
  connection.write(`:${numReceivers}\r\n`);
}

module.exports = {
  subscribe: subscribeCommand,
  unsubscribe: unsubscribeCommand,
  publish: publishCommand
};
