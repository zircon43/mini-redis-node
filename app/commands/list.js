function rpushCommand(args, connection, ctx) {
  const key = args[1];
  const elements = args.slice(2);
  
  let list = [];
  const entry = ctx.store.get(key);
  if (entry && Array.isArray(entry.value)) {
    list = entry.value;
  }
  
  list.push(...elements);
  ctx.appendToAof(args);
  ctx.store.set(key, { value: list, expiresAt: null });
  
  connection.write(`:${list.length}\r\n`);
  ctx.checkBlockedClients(key);
}

function lpushCommand(args, connection, ctx) {
  const key = args[1];
  const elements = args.slice(2);
  
  let list = [];
  const entry = ctx.store.get(key);
  if (entry && Array.isArray(entry.value)) {
    list = entry.value;
  }
  
  for (const elem of elements) {
    list.unshift(elem);
  }
  ctx.appendToAof(args);
  ctx.store.set(key, { value: list, expiresAt: null });
  
  connection.write(`:${list.length}\r\n`);
  ctx.checkBlockedClients(key);
}

function lrangeCommand(args, connection, ctx) {
  const key = args[1];
  let start = parseInt(args[2], 10);
  let stop = parseInt(args[3], 10);
  
  const entry = ctx.store.get(key);
  
  if (!entry || !Array.isArray(entry.value)) {
    connection.write("*0\r\n");
  } else {
    const list = entry.value;
    
    if (start < 0) start = Math.max(0, list.length + start);
    if (stop < 0) stop = Math.max(0, list.length + stop);
    
    if (start >= list.length || start > stop) {
      connection.write("*0\r\n");
    } else {
      if (stop >= list.length) {
        stop = list.length - 1;
      }
      
      const slice = list.slice(start, stop + 1);
      
      let response = `*${slice.length}\r\n`;
      for (const item of slice) {
        response += `$${item.length}\r\n${item}\r\n`;
      }
      connection.write(response);
    }
  }
}

function llenCommand(args, connection, ctx) {
  const key = args[1];
  const entry = ctx.store.get(key);
  
  if (!entry || !Array.isArray(entry.value)) {
    connection.write(":0\r\n");
  } else {
    connection.write(`:${entry.value.length}\r\n`);
  }
}

function lpopCommand(args, connection, ctx) {
  const key = args[1];
  const entry = ctx.store.get(key);
  const hasCount = args.length >= 3;
  let count = hasCount ? parseInt(args[2], 10) : 1;
  
  if (!entry || !Array.isArray(entry.value) || entry.value.length === 0) {
    connection.write(hasCount ? "*-1\r\n" : "$-1\r\n");
  } else {
    const list = entry.value;
    
    if (!hasCount) {
      const removed = list.shift();
      if (list.length === 0) ctx.store.delete(key);
      connection.write(`$${removed.length}\r\n${removed}\r\n`);
    } else {
      const removedElements = list.splice(0, count);
      if (list.length === 0) ctx.store.delete(key);
      
      let response = `*${removedElements.length}\r\n`;
      for (const item of removedElements) {
        response += `$${item.length}\r\n${item}\r\n`;
      }
      connection.write(response);
    }
  }
}

function blpopCommand(args, connection, ctx) {
  const key = args[1];
  const timeoutStr = args[2];
  const timeout = timeoutStr ? parseFloat(timeoutStr) : 0;
  
  const entry = ctx.store.get(key);
  if (entry && Array.isArray(entry.value) && entry.value.length > 0) {
    const list = entry.value;
    const removed = list.shift();
    if (list.length === 0) ctx.store.delete(key);
    connection.write(`*2\r\n$${key.length}\r\n${key}\r\n$${removed.length}\r\n${removed}\r\n`);
  } else {
    if (!ctx.blockedClients.has(key)) {
      ctx.blockedClients.set(key, []);
    }
    
    const clientObj = { connection, timer: null };
    
    if (timeout > 0) {
      clientObj.timer = setTimeout(() => {
        const queue = ctx.blockedClients.get(key);
        if (queue) {
          const index = queue.indexOf(clientObj);
          if (index !== -1) {
            queue.splice(index, 1);
            connection.write("*-1\r\n");
          }
        }
      }, timeout * 1000);
    }
    
    ctx.blockedClients.get(key).push(clientObj);
  }
}

module.exports = {
  rpush: rpushCommand,
  lpush: lpushCommand,
  lrange: lrangeCommand,
  llen: llenCommand,
  lpop: lpopCommand,
  blpop: blpopCommand
};
