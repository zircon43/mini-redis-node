function setCommand(args, connection, ctx) {
  ctx.appendToAof(args);
  const key = args[1];
  const value = args[2];
  let expiresAt = null;
  
  if (args.length >= 5 && args[3].toLowerCase() === "px") {
    const px = parseInt(args[4], 10);
    expiresAt = Date.now() + px;
  }
  
  ctx.store.set(key, { value, expiresAt });
  connection.write("+OK\r\n");
  
  let respStr = `*${args.length}\r\n`;
  for (const arg of args) {
     respStr += `$${arg.length}\r\n${arg}\r\n`;
  }
  for (const replica of ctx.replicas) {
     replica.write(respStr);
  }
  ctx.incrementMasterReplOffset(respStr.length);
}

function getCommand(args, connection, ctx) {
  const key = args[1];
  const entry = ctx.store.get(key);
  
  if (entry !== undefined) {
    if (entry.expiresAt !== null && Date.now() > entry.expiresAt) {
      ctx.store.delete(key);
      connection.write("$-1\r\n");
    } else {
      connection.write(`$${entry.value.length}\r\n${entry.value}\r\n`);
    }
  } else {
    connection.write("$-1\r\n");
  }
}

function incrCommand(args, connection, ctx) {
  const key = args[1];
  const entry = ctx.store.get(key);
  let val = 0;
  let isValid = true;
  
  if (entry !== undefined) {
     val = parseInt(entry.value, 10);
     if (isNaN(val)) {
        isValid = false;
        connection.write("-ERR value is not an integer or out of range\r\n");
     }
  }
  
  if (isValid) {
     ctx.appendToAof(args);
     val++;
     ctx.store.set(key, { value: val.toString(), type: "string", expiresAt: entry ? entry.expiresAt : null });
     connection.write(`:${val}\r\n`);
  }
}

module.exports = {
  set: setCommand,
  get: getCommand,
  incr: incrCommand
};
