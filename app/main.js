const net = require("net");

// You can use print statements as follows for debugging, they'll be visible when running tests.
console.log("Logs from your program will appear here!");

const store = new Map();
const clients = new Set();

let isReplica = false;
let masterHost = null;
let masterPort = null;
const replicaofArgIdx = process.argv.indexOf("--replicaof");
if (replicaofArgIdx !== -1 && replicaofArgIdx + 1 < process.argv.length) {
  isReplica = true;
  const parts = process.argv[replicaofArgIdx + 1].split(" ");
  masterHost = parts[0];
  masterPort = parseInt(parts[1], 10);
}

const originalStoreSet = store.set.bind(store);
store.set = (key, value) => {
   for (const client of clients) {
       if (client.watchedKeys && client.watchedKeys.has(key)) {
           client.isDirty = true;
       }
   }
   return originalStoreSet(key, value);
};

const originalStoreDelete = store.delete.bind(store);
store.delete = (key) => {
   for (const client of clients) {
       if (client.watchedKeys && client.watchedKeys.has(key)) {
           client.isDirty = true;
       }
   }
   return originalStoreDelete(key);
};

const blockedClients = new Map();
const blockedXreadClients = [];

function checkBlockedXreadClients(key) {
  for (let i = 0; i < blockedXreadClients.length; i++) {
    const client = blockedXreadClients[i];
    if (client.resolved) continue;
    if (client.keys.includes(key)) {
      let hasNewData = false;
      let streamResponses = [];
      const getMsSeq = (id) => {
         const parts = id.split("-");
         return [Number(parts[0]), Number(parts[1])];
      };
      
      for (let j = 0; j < client.keys.length; j++) {
         const clientKey = client.keys[j];
         const startArg = client.ids[j];
         const startId = startArg.includes("-") ? startArg : `${startArg}-0`;
         const [startMs, startSeq] = getMsSeq(startId);
         
         const entry = store.get(clientKey);
         if (entry && entry.type === "stream") {
            const streamEntries = entry.value;
            const results = streamEntries.filter(e => {
               const [eMs, eSeq] = getMsSeq(e.id);
               if (eMs < startMs || (eMs === startMs && eSeq <= startSeq)) return false;
               return true;
            });
            
            if (results.length > 0) {
               hasNewData = true;
               let streamRes = `*2\r\n$${clientKey.length}\r\n${clientKey}\r\n`;
               streamRes += `*${results.length}\r\n`;
               for (const resEntry of results) {
                  streamRes += `*2\r\n$${resEntry.id.length}\r\n${resEntry.id}\r\n`;
                  streamRes += `*${resEntry.kvs.length}\r\n`;
                  for (const kv of resEntry.kvs) {
                     streamRes += `$${kv.length}\r\n${kv}\r\n`;
                  }
               }
               streamResponses.push(streamRes);
            }
         }
      }
      
      if (hasNewData) {
         client.resolved = true;
         if (client.timerId) clearTimeout(client.timerId);
         let res = `*${streamResponses.length}\r\n` + streamResponses.join("");
         client.connection.write(res);
      }
    }
  }
  
  for (let i = blockedXreadClients.length - 1; i >= 0; i--) {
    if (blockedXreadClients[i].resolved) {
      blockedXreadClients.splice(i, 1);
    }
  }
}

function checkBlockedClients(key) {
  if (!blockedClients.has(key)) return;
  const queue = blockedClients.get(key);
  const entry = store.get(key);
  
  if (!entry || !Array.isArray(entry.value)) return;
  const list = entry.value;

  while (queue.length > 0 && list.length > 0) {
    const clientObj = queue.shift();
    if (clientObj.timer) clearTimeout(clientObj.timer);
    const blockedConnection = clientObj.connection;
    const removed = list.shift();
    blockedConnection.write(`*2\r\n$${key.length}\r\n${key}\r\n$${removed.length}\r\n${removed}\r\n`);
  }
  
  if (list.length === 0) store.delete(key);
}

// Uncomment the code below to pass the first stage
const server = net.createServer((connection) => {
  clients.add(connection);
  connection.on("end", () => clients.delete(connection));
  connection.on("error", () => clients.delete(connection));
  connection.on("data", (data) => {
    const lines = data.toString().split("\r\n");
    
    if (lines[0].startsWith("*")) {
      const numArgs = parseInt(lines[0].slice(1), 10);
      const args = [];
      let currentLine = 1;
      
      for (let i = 0; i < numArgs; i++) {
        if (lines[currentLine].startsWith("$")) {
          currentLine++; // Skip the length line (e.g., $4)
          args.push(lines[currentLine]); // Add the actual string
          currentLine++;
        }
      }
      
      if (args.length > 0) {
        const command = args[0].toLowerCase();
        
        if (connection.isMulti && command !== "exec" && command !== "discard" && command !== "multi" && command !== "watch") {
          connection.queued.push(args);
          connection.write("+QUEUED\r\n");
        } else if (command === "ping") {
          connection.write("+PONG\r\n");
        } else if (command === "replconf") {
          connection.write("+OK\r\n");
        } else if (command === "psync") {
          connection.write("+FULLRESYNC 8371b4fb1155b71f4a04d3e1bc3e18c4a990aeeb 0\r\n");
          const emptyRdbHex = "524544495330303131fa0972656469732d76657205372e322e30fa0a72656469732d62697473c040fa056374696d65c26d08bc65fa08757365642d6d656dc2b0c41000fa08616f662d62617365c000fff06e3bfec0ff5aa2";
          const emptyRdb = Buffer.from(emptyRdbHex, "hex");
          connection.write(`$${emptyRdb.length}\r\n`);
          connection.write(emptyRdb);
        } else if (command === "echo") {
          const arg = args[1];
          connection.write(`$${arg.length}\r\n${arg}\r\n`);
        } else if (command === "info") {
          let res = isReplica ? "role:slave" : "role:master";
          res += "\r\nmaster_replid:8371b4fb1155b71f4a04d3e1bc3e18c4a990aeeb\r\nmaster_repl_offset:0";
          connection.write(`$${res.length}\r\n${res}\r\n`);
        } else if (command === "multi") {
          connection.isMulti = true;
          connection.queued = [];
          connection.write("+OK\r\n");
        } else if (command === "discard") {
          if (!connection.isMulti) {
            connection.write("-ERR DISCARD without MULTI\r\n");
          } else {
            connection.isMulti = false;
            connection.queued = [];
            connection.watchedKeys = new Set();
            connection.isDirty = false;
            connection.write("+OK\r\n");
          }
        } else if (command === "watch") {
          if (connection.isMulti) {
            connection.write("-ERR WATCH inside MULTI is not allowed\r\n");
          } else {
            if (!connection.watchedKeys) connection.watchedKeys = new Set();
            for (let i = 1; i < args.length; i++) {
               connection.watchedKeys.add(args[i]);
            }
            connection.write("+OK\r\n");
          }
        } else if (command === "unwatch") {
          connection.watchedKeys = new Set();
          connection.isDirty = false;
          connection.write("+OK\r\n");
        } else if (command === "exec") {
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
        } else if (command === "incr") {
          const key = args[1];
          const entry = store.get(key);
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
             val++;
             store.set(key, { value: val.toString(), type: "string", expiresAt: entry ? entry.expiresAt : null });
             connection.write(`:${val}\r\n`);
          }
        } else if (command === "set") {
          const key = args[1];
          const value = args[2];
          let expiresAt = null;
          
          if (args.length >= 5 && args[3].toLowerCase() === "px") {
            const px = parseInt(args[4], 10);
            expiresAt = Date.now() + px;
          }
          
          store.set(key, { value, expiresAt });
          connection.write("+OK\r\n");
        } else if (command === "get") {
          const key = args[1];
          const entry = store.get(key);
          
          if (entry !== undefined) {
            if (entry.expiresAt !== null && Date.now() > entry.expiresAt) {
              store.delete(key);
              connection.write("$-1\r\n");
            } else {
              connection.write(`$${entry.value.length}\r\n${entry.value}\r\n`);
            }
          } else {
            connection.write("$-1\r\n");
          }
        } else if (command === "rpush") {
          const key = args[1];
          const elements = args.slice(2);
          
          let list = [];
          const entry = store.get(key);
          if (entry && Array.isArray(entry.value)) {
            list = entry.value;
          }
          
          list.push(...elements);
          store.set(key, { value: list, expiresAt: null });
          
          connection.write(`:${list.length}\r\n`);
          checkBlockedClients(key);
        } else if (command === "lpush") {
          const key = args[1];
          const elements = args.slice(2);
          
          let list = [];
          const entry = store.get(key);
          if (entry && Array.isArray(entry.value)) {
            list = entry.value;
          }
          
          for (const elem of elements) {
            list.unshift(elem);
          }
          store.set(key, { value: list, expiresAt: null });
          
          connection.write(`:${list.length}\r\n`);
          checkBlockedClients(key);
        } else if (command === "lrange") {
          const key = args[1];
          let start = parseInt(args[2], 10);
          let stop = parseInt(args[3], 10);
          
          const entry = store.get(key);
          
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
        } else if (command === "llen") {
          const key = args[1];
          const entry = store.get(key);
          
          if (!entry || !Array.isArray(entry.value)) {
            connection.write(":0\r\n");
          } else {
            connection.write(`:${entry.value.length}\r\n`);
          }
        } else if (command === "lpop") {
          const key = args[1];
          const entry = store.get(key);
          const hasCount = args.length >= 3;
          let count = hasCount ? parseInt(args[2], 10) : 1;
          
          if (!entry || !Array.isArray(entry.value) || entry.value.length === 0) {
            connection.write(hasCount ? "*-1\r\n" : "$-1\r\n");
          } else {
            const list = entry.value;
            
            if (!hasCount) {
              const removed = list.shift();
              if (list.length === 0) store.delete(key);
              connection.write(`$${removed.length}\r\n${removed}\r\n`);
            } else {
              const removedElements = list.splice(0, count);
              if (list.length === 0) store.delete(key);
              
              let response = `*${removedElements.length}\r\n`;
              for (const item of removedElements) {
                response += `$${item.length}\r\n${item}\r\n`;
              }
              connection.write(response);
            }
          }
        } else if (command === "blpop") {
          const key = args[1];
          const timeoutStr = args[2];
          const timeout = timeoutStr ? parseFloat(timeoutStr) : 0;
          
          const entry = store.get(key);
          if (entry && Array.isArray(entry.value) && entry.value.length > 0) {
            const list = entry.value;
            const removed = list.shift();
            if (list.length === 0) store.delete(key);
            connection.write(`*2\r\n$${key.length}\r\n${key}\r\n$${removed.length}\r\n${removed}\r\n`);
          } else {
            if (!blockedClients.has(key)) {
              blockedClients.set(key, []);
            }
            
            const clientObj = { connection, timer: null };
            
            if (timeout > 0) {
              clientObj.timer = setTimeout(() => {
                const queue = blockedClients.get(key);
                if (queue) {
                  const index = queue.indexOf(clientObj);
                  if (index !== -1) {
                    queue.splice(index, 1);
                    connection.write("*-1\r\n");
                  }
                }
              }, timeout * 1000);
            }
            
            blockedClients.get(key).push(clientObj);
          }
        } else if (command === "type") {
          const key = args[1];
          const entry = store.get(key);
          
          if (!entry || (entry.expiresAt !== null && Date.now() > entry.expiresAt)) {
            if (entry) store.delete(key);
            connection.write("+none\r\n");
          } else if (entry.type === "stream") {
            connection.write("+stream\r\n");
          } else if (Array.isArray(entry.value)) {
            connection.write("+list\r\n");
          } else {
            connection.write("+string\r\n");
          }
        } else if (command === "xadd") {
          const key = args[1];
          let entryId = args[2];
          const kvs = args.slice(3);
          
          let streamEntries = [];
          const entry = store.get(key);
          if (entry && entry.type === "stream") {
            streamEntries = entry.value;
          }
          
          if (entryId === "*") {
            let newMs = Date.now();
            if (streamEntries.length > 0) {
              const lastId = streamEntries[streamEntries.length - 1].id;
              const [lastMs] = lastId.split("-").map(Number);
              if (newMs < lastMs) newMs = lastMs;
            }
            entryId = `${newMs}-*`;
          }
          
          let [newMsStr, newSeqStr] = entryId.split("-");
          let newMs = Number(newMsStr);
          let newSeq;
          
          if (newSeqStr === "*") {
            if (streamEntries.length > 0) {
              const lastId = streamEntries[streamEntries.length - 1].id;
              const [lastMs, lastSeq] = lastId.split("-").map(Number);
              
              if (newMs === lastMs) {
                newSeq = lastSeq + 1;
              } else {
                newSeq = newMs === 0 ? 1 : 0;
              }
            } else {
              newSeq = newMs === 0 ? 1 : 0;
            }
            entryId = `${newMs}-${newSeq}`;
          } else {
            newSeq = Number(newSeqStr);
          }
          
          if (newMs === 0 && newSeq === 0) {
            connection.write("-ERR The ID specified in XADD must be greater than 0-0\r\n");
          } else {
            let isValid = true;
            if (streamEntries.length > 0) {
              const lastId = streamEntries[streamEntries.length - 1].id;
              const [lastMs, lastSeq] = lastId.split("-").map(Number);
              
              if (newMs < lastMs || (newMs === lastMs && newSeq <= lastSeq)) {
                isValid = false;
                connection.write("-ERR The ID specified in XADD is equal or smaller than the target stream top item\r\n");
              }
            }
            
            if (isValid) {
              streamEntries.push({ id: entryId, kvs });
              store.set(key, { type: "stream", value: streamEntries, expiresAt: null });
              
              connection.write(`$${entryId.length}\r\n${entryId}\r\n`);
              checkBlockedXreadClients(key);
            }
          }
        } else if (command === "xrange") {
          const key = args[1];
          const startArg = args[2];
          const endArg = args[3];
          
          let startId = startArg.includes("-") ? startArg : `${startArg}-0`;
          if (startArg === "-") startId = "0-0";
          
          let endId = endArg.includes("-") ? endArg : `${endArg}-${Infinity}`;
          if (endArg === "+") endId = `${Infinity}-${Infinity}`;
          
          const entry = store.get(key);
          if (!entry || entry.type !== "stream") {
            connection.write("*0\r\n");
          } else {
            const streamEntries = entry.value;
            
            const getMsSeq = (id) => {
               const parts = id.split("-");
               return [Number(parts[0]), Number(parts[1])];
            };
            
            const [startMs, startSeq] = getMsSeq(startId);
            const [endMs, endSeq] = getMsSeq(endId);
            
            const results = streamEntries.filter(e => {
               const [eMs, eSeq] = getMsSeq(e.id);
               if (eMs < startMs || (eMs === startMs && eSeq < startSeq)) return false;
               if (eMs > endMs || (eMs === endMs && eSeq > endSeq)) return false;
               return true;
            });
            
            let res = `*${results.length}\r\n`;
            for (const resEntry of results) {
               res += `*2\r\n$${resEntry.id.length}\r\n${resEntry.id}\r\n`;
               res += `*${resEntry.kvs.length}\r\n`;
               for (const kv of resEntry.kvs) {
                  res += `$${kv.length}\r\n${kv}\r\n`;
               }
            }
            connection.write(res);
          }
        } else if (command === "xread") {
          let isBlock = false;
          let timeoutMs = 0;
          let streamsArgIdx = 1;
          
          if (args[1].toLowerCase() === "block") {
            isBlock = true;
            timeoutMs = Number(args[2]);
            streamsArgIdx = 3;
          }
          
          if (args[streamsArgIdx].toLowerCase() === "streams") {
            const numStreams = (args.length - (streamsArgIdx + 1)) / 2;
            const keys = args.slice(streamsArgIdx + 1, streamsArgIdx + 1 + numStreams);
            const ids = args.slice(streamsArgIdx + 1 + numStreams);
            
            for (let i = 0; i < numStreams; i++) {
               if (ids[i] === "$") {
                  const entry = store.get(keys[i]);
                  if (entry && entry.type === "stream" && entry.value.length > 0) {
                     ids[i] = entry.value[entry.value.length - 1].id;
                  } else {
                     ids[i] = "0-0";
                  }
               }
            }
            
            const getMsSeq = (id) => {
               const parts = id.split("-");
               return [Number(parts[0]), Number(parts[1])];
            };
            
            let streamResponses = [];
            for (let i = 0; i < numStreams; i++) {
               const key = keys[i];
               const startArg = ids[i];
               const startId = startArg.includes("-") ? startArg : `${startArg}-0`;
               const [startMs, startSeq] = getMsSeq(startId);
               
               const entry = store.get(key);
               if (entry && entry.type === "stream") {
                  const streamEntries = entry.value;
                  const results = streamEntries.filter(e => {
                     const [eMs, eSeq] = getMsSeq(e.id);
                     if (eMs < startMs || (eMs === startMs && eSeq <= startSeq)) return false;
                     return true;
                  });
                  
                  if (results.length > 0) {
                     let streamRes = `*2\r\n$${key.length}\r\n${key}\r\n`;
                     streamRes += `*${results.length}\r\n`;
                     for (const resEntry of results) {
                        streamRes += `*2\r\n$${resEntry.id.length}\r\n${resEntry.id}\r\n`;
                        streamRes += `*${resEntry.kvs.length}\r\n`;
                        for (const kv of resEntry.kvs) {
                           streamRes += `$${kv.length}\r\n${kv}\r\n`;
                        }
                     }
                     streamResponses.push(streamRes);
                  }
               }
            }
            
            if (streamResponses.length === 0) {
               if (isBlock) {
                 const clientObj = {
                   connection,
                   keys,
                   ids,
                   timerId: null,
                   resolved: false
                 };
                 if (timeoutMs > 0) {
                   clientObj.timerId = setTimeout(() => {
                     if (!clientObj.resolved) {
                       clientObj.resolved = true;
                       connection.write("*-1\r\n");
                     }
                   }, timeoutMs);
                 }
                 blockedXreadClients.push(clientObj);
               } else {
                 connection.write("*-1\r\n");
               }
            } else {
               let res = `*${streamResponses.length}\r\n` + streamResponses.join("");
               connection.write(res);
            }
          }
        }
      }
    }
  });
});

let port = 6379;
const portArgIdx = process.argv.indexOf("--port");
if (portArgIdx !== -1 && portArgIdx + 1 < process.argv.length) {
  port = parseInt(process.argv[portArgIdx + 1], 10);
}

server.listen(port, "127.0.0.1");

if (isReplica) {
  let handshakeStep = 0;
  const masterConn = net.createConnection({ host: masterHost, port: masterPort }, () => {
    masterConn.write("*1\r\n$4\r\nPING\r\n");
  });
  
  masterConn.on("data", (data) => {
    if (handshakeStep === 0) {
      const portStr = port.toString();
      masterConn.write(`*3\r\n$8\r\nREPLCONF\r\n$14\r\nlistening-port\r\n$${portStr.length}\r\n${portStr}\r\n`);
      handshakeStep++;
    } else if (handshakeStep === 1) {
      masterConn.write("*3\r\n$8\r\nREPLCONF\r\n$4\r\ncapa\r\n$6\r\npsync2\r\n");
      handshakeStep++;
    } else if (handshakeStep === 2) {
      masterConn.write("*3\r\n$5\r\nPSYNC\r\n$1\r\n?\r\n$2\r\n-1\r\n");
      handshakeStep++;
    }
  });
}
