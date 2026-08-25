function multiCommand(args, connection, ctx) {
  connection.isMulti = true;
  connection.queued = [];
  connection.write("+OK\r\n");
}

function discardCommand(args, connection, ctx) {
  if (!connection.isMulti) {
    connection.write("-ERR DISCARD without MULTI\r\n");
  } else {
    connection.isMulti = false;
    connection.queued = [];
    connection.watchedKeys = new Set();
    connection.isDirty = false;
    connection.write("+OK\r\n");
  }
}

function watchCommand(args, connection, ctx) {
  if (connection.isMulti) {
    connection.write("-ERR WATCH inside MULTI is not allowed\r\n");
  } else {
    if (!connection.watchedKeys) connection.watchedKeys = new Set();
    for (let i = 1; i < args.length; i++) {
       connection.watchedKeys.add(args[i]);
    }
    connection.write("+OK\r\n");
  }
}

function unwatchCommand(args, connection, ctx) {
  connection.watchedKeys = new Set();
  connection.isDirty = false;
  connection.write("+OK\r\n");
}

function execCommand(args, connection, ctx) {
  if (!connection.isMulti) {
    connection.write("-ERR EXEC without MULTI\r\n");
  } else if (connection.isDirty) {
    connection.write("*-1\r\n");
    connection.isMulti = false;
    connection.queued = [];
    connection.watchedKeys = new Set();
    connection.isDirty = false;
  } else {
    let execResponses = [];
    const originalWrite = connection.write.bind(connection);
    connection.write = (data) => {
      execResponses.push(data);
    };
    
    connection.isMulti = false;
    const queued = connection.queued;
    
    for (const qArgs of queued) {
       let respStr = `*${qArgs.length}\r\n`;
       for (const arg of qArgs) {
          respStr += `$${arg.length}\r\n${arg}\r\n`;
       }
       connection.emit("data", Buffer.from(respStr));
    }
    
    connection.write = originalWrite;
    let finalRes = `*${execResponses.length}\r\n` + execResponses.join("");
    connection.write(finalRes);
    
    connection.queued = [];
    connection.watchedKeys = new Set();
    connection.isDirty = false;
  }
}

module.exports = {
  multi: multiCommand,
  discard: discardCommand,
  watch: watchCommand,
  unwatch: unwatchCommand,
  exec: execCommand
};
