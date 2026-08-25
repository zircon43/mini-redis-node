function pingCommand(args, connection, ctx) {
  if (connection.subscribedChannels && connection.subscribedChannels.size > 0) {
    const resp = args.length > 1 ? args[1] : "";
    connection.write(`*2\r\n$4\r\npong\r\n$${resp.length}\r\n${resp}\r\n`);
  } else {
    connection.write("+PONG\r\n");
  }
}

function echoCommand(args, connection, ctx) {
  const arg = args[1];
  connection.write(`$${arg.length}\r\n${arg}\r\n`);
}

function infoCommand(args, connection, ctx) {
  let res = ctx.isReplica ? "role:slave" : "role:master";
  res += "\r\nmaster_replid:8371b4fb1155b71f4a04d3e1bc3e18c4a990aeeb\r\nmaster_repl_offset:0";
  connection.write(`$${res.length}\r\n${res}\r\n`);
}

function replconfCommand(args, connection, ctx) {
  if (args.length >= 3 && args[1].toLowerCase() === "ack") {
    connection.ackedOffset = parseInt(args[2], 10);
  } else {
    connection.write("+OK\r\n");
  }
}

function psyncCommand(args, connection, ctx) {
  connection.write("+FULLRESYNC 8371b4fb1155b71f4a04d3e1bc3e18c4a990aeeb 0\r\n");
  const emptyRdbHex = "524544495330303131fa0972656469732d76657205372e322e30fa0a72656469732d62697473c040fa056374696d65c26d08bc65fa08757365642d6d656dc2b0c41000fa08616f662d62617365c000fff06e3bfec0ff5aa2";
  const emptyRdb = Buffer.from(emptyRdbHex, "hex");
  connection.write(`$${emptyRdb.length}\r\n`);
  connection.write(emptyRdb);
  ctx.replicas.add(connection);
}

function waitCommand(args, connection, ctx) {
  const numReplicas = parseInt(args[1], 10);
  const timeout = parseInt(args[2], 10);

  if (ctx.getMasterReplOffset() === 0) {
    connection.write(`:${ctx.replicas.size}\r\n`);
  } else {
    let ackCount = 0;
    for (const replica of ctx.replicas) {
      if ((replica.ackedOffset || 0) >= ctx.getMasterReplOffset()) {
        ackCount++;
      }
    }

    if (ackCount >= numReplicas) {
      connection.write(`:${ackCount}\r\n`);
    } else {
      const getAckStr = "*3\r\n$8\r\nREPLCONF\r\n$6\r\nGETACK\r\n$1\r\n*\r\n";
      const targetOffset = ctx.getMasterReplOffset();
      for (const replica of ctx.replicas) {
        replica.write(getAckStr);
      }
      ctx.incrementMasterReplOffset(getAckStr.length);

      let timeElapsed = 0;
      const interval = 50;
      const waitInterval = setInterval(() => {
        ackCount = 0;
        for (const replica of ctx.replicas) {
          if ((replica.ackedOffset || 0) >= targetOffset) {
            ackCount++;
          }
        }
        timeElapsed += interval;
        if (ackCount >= numReplicas || (timeout > 0 && timeElapsed >= timeout)) {
          clearInterval(waitInterval);
          connection.write(`:${ackCount}\r\n`);
        }
      }, interval);
    }
  }
}

function configCommand(args, connection, ctx) {
  if (args.length >= 3 && args[1].toLowerCase() === "get") {
    const param = args[2].toLowerCase();
    let val = "";
    if (param === "dir") val = ctx.config.dir;
    else if (param === "dbfilename") val = ctx.config.dbfilename;
    else if (param === "appendonly") val = ctx.config.appendonly;
    else if (param === "appenddirname") val = ctx.config.appenddirname;
    else if (param === "appendfilename") val = ctx.config.appendfilename;
    else if (param === "appendfsync") val = ctx.config.appendfsync;
    
    connection.write(`*2\r\n$${param.length}\r\n${param}\r\n$${val.length}\r\n${val}\r\n`);
  }
}

function keysCommand(args, connection, ctx) {
  const keys = Array.from(ctx.store.keys());
  let res = `*${keys.length}\r\n`;
  for (const key of keys) {
     res += `$${key.length}\r\n${key}\r\n`;
  }
  connection.write(res);
}

function typeCommand(args, connection, ctx) {
  const key = args[1];
  const entry = ctx.store.get(key);
  
  if (!entry || (entry.expiresAt !== null && Date.now() > entry.expiresAt)) {
    if (entry) ctx.store.delete(key);
    connection.write("+none\r\n");
  } else if (entry.type === "stream") {
    connection.write("+stream\r\n");
  } else if (Array.isArray(entry.value)) {
    connection.write("+list\r\n");
  } else if (entry.type === "zset") {
    connection.write("+zset\r\n");
  } else {
    connection.write("+string\r\n");
  }
}

module.exports = {
  ping: pingCommand,
  echo: echoCommand,
  info: infoCommand,
  replconf: replconfCommand,
  psync: psyncCommand,
  wait: waitCommand,
  config: configCommand,
  keys: keysCommand,
  type: typeCommand
};
