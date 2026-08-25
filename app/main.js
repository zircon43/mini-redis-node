const net = require("net");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const config = require('./config');
const { parseCommands } = require('./resp');
const { haversine, encodeGeoHash, decodeGeoHash } = require('./geoUtils');
const commandRegistry = require('./commands/index');

const users = {
    "default": {
        flags: ["nopass"],
        passwords: []
    }
};

let master_repl_offset = 0;
let activeAofFile = "";

// You can use print statements as follows for debugging, they'll be visible when running tests.
console.log("Logs from your program will appear here!");

const store = new Map();
const clients = new Set();
const replicas = new Set();

let isReplica = config.isReplica;
let masterHost = config.masterHost;
let masterPort = config.masterPort;

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
  if (users["default"].flags.includes("nopass")) {
      connection.authenticatedUser = "default";
  } else {
      connection.authenticatedUser = null;
  }
  
  clients.add(connection);
  connection.on("end", () => {
    clients.delete(connection);
    replicas.delete(connection);
  });
  connection.on("error", () => {
    clients.delete(connection);
    replicas.delete(connection);
  });
  connection.on("data", (data) => {
    const args = parseCommands(data);
    if (!args) return;
    
    if (args.length > 0) {
        const command = args[0].toLowerCase();
        
        if (!connection.authenticatedUser && command !== "auth") {
           connection.write("-NOAUTH Authentication required.\r\n");
           return;
        }

        const appendToAof = () => {
           if (appendonly.toLowerCase() === "yes" && activeAofFile) {
              let respStr = `*${args.length}\r\n`;
              for (const arg of args) {
                 respStr += `$${arg.length}\r\n${arg}\r\n`;
              }
              fs.appendFileSync(activeAofFile, respStr);
           }
        };
        
        if (!connection.subscribedChannels) {
            connection.subscribedChannels = new Set();
         }
         
         if (connection.subscribedChannels.size > 0) {
            const allowed = ["subscribe", "unsubscribe", "psubscribe", "punsubscribe", "ping", "quit", "reset"];
            if (!allowed.includes(command)) {
               connection.write(`-ERR Can't execute '${command}': only (P|S)SUBSCRIBE / (P|S)UNSUBSCRIBE / PING / QUIT / RESET are allowed in this context\r\n`);
               return; // Skip further processing
            }
         }
         
         if (connection.isMulti && command !== "exec" && command !== "discard" && command !== "multi" && command !== "watch") {
          connection.queued.push(args);
          connection.write("+QUEUED\r\n");
        } else {
          const handler = commandRegistry[command];
          
          const appendToAof = (cmdArgs) => {
             if (appendonly.toLowerCase() === "yes" && activeAofFile) {
                let respStr = `*${cmdArgs.length}\r\n`;
                for (const arg of cmdArgs) {
                   respStr += `$${arg.length}\r\n${arg}\r\n`;
                }
                fs.appendFileSync(activeAofFile, respStr);
             }
          };
          
          const ctx = {
            store,
            clients,
            replicas,
            blockedClients,
            blockedXreadClients,
            users,
            config,
            isReplica,
            getMasterReplOffset: () => master_repl_offset,
            incrementMasterReplOffset: (amount) => { master_repl_offset += amount; },
            appendToAof,
            checkBlockedClients,
            checkBlockedXreadClients
          };

          if (handler) {
             handler(args, connection, ctx);
          } else {
             connection.write(`-ERR unknown command '${command}'\r\n`);
          }
        }
      }
  });
});

let port = config.port;
let dir = config.dir;
let dbfilename = config.dbfilename;
let appendonly = config.appendonly;
let appenddirname = config.appenddirname;
let appendfilename = config.appendfilename;
let appendfsync = config.appendfsync;

if (appendonly.toLowerCase() === "yes") {
   const aofDir = path.join(dir, appenddirname);
   if (!fs.existsSync(aofDir)) {
      fs.mkdirSync(aofDir, { recursive: true });
   }
   
   const manifestFile = path.join(aofDir, `${appendfilename}.manifest`);
   if (fs.existsSync(manifestFile)) {
      const manifestContent = fs.readFileSync(manifestFile, "utf-8");
      const lines = manifestContent.split("\n");
      for (const line of lines) {
         if (line.includes("type i")) {
            const parts = line.split(" ");
            const fileIdx = parts.indexOf("file");
            if (fileIdx !== -1 && fileIdx + 1 < parts.length) {
               activeAofFile = path.join(aofDir, parts[fileIdx + 1]);
            }
         }
      }
   }
   
   if (!activeAofFile) {
      activeAofFile = path.join(aofDir, `${appendfilename}.1.incr.aof`);
      if (!fs.existsSync(activeAofFile)) {
         fs.writeFileSync(activeAofFile, "");
      }
      if (!fs.existsSync(manifestFile)) {
         fs.writeFileSync(manifestFile, `file ${path.basename(activeAofFile)} seq 1 type i\n`);
      }
   }
   
   if (fs.existsSync(activeAofFile)) {
      replayAof(activeAofFile);
   }
}


function replayAof(filePath) {
   const content = fs.readFileSync(filePath, "utf-8");
   if (!content) return;
   
   let i = 0;
   const readUntilCrlf = () => {
       const nextI = content.indexOf("\r\n", i);
       if (nextI === -1) return null;
       const res = content.slice(i, nextI);
       i = nextI + 2;
       return res;
   };
   
   while (i < content.length) {
       const line = readUntilCrlf();
       if (!line) break;
       if (line.startsWith("*")) {
           const numArgs = parseInt(line.slice(1), 10);
           const args = [];
           for (let j = 0; j < numArgs; j++) {
               const lenLine = readUntilCrlf();
               const strLine = readUntilCrlf();
               if (strLine !== null) {
                   args.push(strLine);
               }
           }
           if (args.length > 0) {
               const command = args[0].toLowerCase();
               if (command === "set") {
                   const key = args[1];
                   const value = args[2];
                   let expiresAt = null;
                   if (args.length >= 5 && args[3].toLowerCase() === "px") {
                       expiresAt = Date.now() + parseInt(args[4], 10);
                   }
                   store.set(key, { value, expiresAt });
               } else if (command === "incr") {
                   const key = args[1];
                   const entry = store.get(key);
                   let val = 0;
                   let isValid = true;
                   if (entry !== undefined) {
                       val = parseInt(entry.value, 10);
                       if (isNaN(val)) isValid = false;
                   }
                   if (isValid) {
                       val++;
                       store.set(key, { value: val.toString(), type: "string", expiresAt: entry ? entry.expiresAt : null });
                   }
               } else if (command === "lpush") {
                   const key = args[1];
                   const elements = args.slice(2);
                   let list = [];
                   const entry = store.get(key);
                   if (entry && Array.isArray(entry.value)) list = entry.value;
                   for (const elem of elements) list.unshift(elem);
                   store.set(key, { value: list, expiresAt: null });
               } else if (command === "rpush") {
                   const key = args[1];
                   const elements = args.slice(2);
                   let list = [];
                   const entry = store.get(key);
                   if (entry && Array.isArray(entry.value)) list = entry.value;
                   list.push(...elements);
                   store.set(key, { value: list, expiresAt: null });
                } else if (command === "zadd") {
                    const key = args[1];
                    const score = parseFloat(args[2]);
                    const member = args[3];
                    let entry = store.get(key);
                    if (!entry || entry.type !== "zset") {
                       entry = { value: [], type: "zset", expiresAt: null };
                       store.set(key, entry);
                    }
                    let zset = entry.value;
                    let existingIdx = zset.findIndex(e => e.member === member);
                    if (existingIdx !== -1) {
                       zset[existingIdx].score = score;
                    } else {
                       zset.push({ score, member });
                    }
                    zset.sort((a, b) => {
                       if (a.score !== b.score) return a.score - b.score;
                       if (a.member < b.member) return -1;
                       if (a.member > b.member) return 1;
                       return 0;
                    });
                } else if (command === "zrem") {
                    const key = args[1];
                    const member = args[2];
                    const entry = store.get(key);
                    if (entry && entry.type === "zset") {
                       const idx = entry.value.findIndex(e => e.member === member);
                       if (idx !== -1) {
                          entry.value.splice(idx, 1);
                       }
                    }
                } else if (command === "geoadd") {
                    const key = args[1];
                    for (let i = 2; i < args.length; i += 3) {
                       const lon = parseFloat(args[i]);
                       const lat = parseFloat(args[i+1]);
                       const member = args[i+2];
                       if (isNaN(lon) || isNaN(lat) || lon < -180 || lon > 180 || lat < -85.05112878 || lat > 85.05112878) continue;
                       const score = encodeGeoHash(lon, lat);
                       let entry = store.get(key);
                       if (!entry || entry.type !== "zset") {
                           entry = { value: [], type: "zset", expiresAt: null };
                           store.set(key, entry);
                       }
                       let zset = entry.value;
                       let existingIdx = zset.findIndex(e => e.member === member);
                       if (existingIdx !== -1) {
                           zset[existingIdx].score = score;
                       } else {
                           zset.push({ score, member });
                       }
                       zset.sort((a, b) => {
                           if (a.score !== b.score) return a.score - b.score;
                           if (a.member < b.member) return -1;
                           if (a.member > b.member) return 1;
                           return 0;
                       });
                    }
                }
           }
       }
   }
}

function parseRdb(dir, dbfilename) {
   if (!dir || !dbfilename) return;
   const fullPath = path.join(dir, dbfilename);
   if (!fs.existsSync(fullPath)) return;
   
   const buf = fs.readFileSync(fullPath);
   let offset = 0;

   const readLength = () => {
      const first = buf[offset++];
      const type = (first & 0xC0) >> 6;
      if (type === 0) {
         return { val: first & 0x3F, isSpecial: false };
      } else if (type === 1) {
         const second = buf[offset++];
         return { val: ((first & 0x3F) << 8) | second, isSpecial: false };
      } else if (type === 2) {
         const val = buf.readUInt32BE(offset);
         offset += 4;
         return { val, isSpecial: false };
      } else {
         return { val: first & 0x3F, isSpecial: true };
      }
   };

   const readString = () => {
      const { val, isSpecial } = readLength();
      if (isSpecial) {
         if (val === 0) {
            const v = buf.readInt8(offset++);
            return String(v);
         } else if (val === 1) {
            const v = buf.readInt16LE(offset);
            offset += 2;
            return String(v);
         } else if (val === 2) {
            const v = buf.readInt32LE(offset);
            offset += 4;
            return String(v);
         } else if (val === 3) {
            throw new Error("LZF compressed strings not supported in basic parser");
         }
      }
      const str = buf.slice(offset, offset + val).toString("utf-8");
      offset += val;
      return str;
   };

   offset += 9; // Skip REDISxxxx magic and version

   while (offset < buf.length) {
      const opcode = buf[offset++];
      if (opcode === 0xFF) {
         break;
      } else if (opcode === 0xFA) {
         readString(); // metadata key
         readString(); // metadata value
      } else if (opcode === 0xFE) {
         readLength(); // db index
      } else if (opcode === 0xFB) {
         readLength(); // hash table size
         readLength(); // expire hash table size
      } else if (opcode === 0xFC || opcode === 0xFD) {
         let expiresAt = null;
         if (opcode === 0xFC) {
            expiresAt = Number(buf.readBigUInt64LE(offset));
            offset += 8;
         }
         if (opcode === 0xFD) {
            expiresAt = buf.readUInt32LE(offset) * 1000;
            offset += 4;
         }
         const type = buf[offset++]; // value type
         const key = readString();
         const value = readString();
         store.set(key, { value, expiresAt });
      } else {
         const type = opcode; // assume 0x00 (string) for this stage
         const key = readString();
         const value = readString();
         store.set(key, { value, expiresAt: null });
      }
   }
}

parseRdb(dir, dbfilename);

server.listen(port, "127.0.0.1");

if (isReplica) {
  let handshakeStep = 0;
  let masterBuffer = Buffer.alloc(0);
  let rdbSize = -1;
  let processedBytes = 0;
  const masterConn = net.createConnection({ host: masterHost, port: masterPort }, () => {
    masterConn.write("*1\r\n$4\r\nPING\r\n");
  });
  
  masterConn.on("data", (data) => {
    masterBuffer = Buffer.concat([masterBuffer, data]);
    
    while (masterBuffer.length > 0) {
      if (handshakeStep === 0) {
        const idx = masterBuffer.indexOf("\r\n");
        if (idx !== -1) {
          masterBuffer = masterBuffer.slice(idx + 2);
          const portStr = port.toString();
          masterConn.write(`*3\r\n$8\r\nREPLCONF\r\n$14\r\nlistening-port\r\n$${portStr.length}\r\n${portStr}\r\n`);
          handshakeStep++;
        } else break;
      } else if (handshakeStep === 1) {
        const idx = masterBuffer.indexOf("\r\n");
        if (idx !== -1) {
          masterBuffer = masterBuffer.slice(idx + 2);
          masterConn.write("*3\r\n$8\r\nREPLCONF\r\n$4\r\ncapa\r\n$6\r\npsync2\r\n");
          handshakeStep++;
        } else break;
      } else if (handshakeStep === 2) {
        const idx = masterBuffer.indexOf("\r\n");
        if (idx !== -1) {
          masterBuffer = masterBuffer.slice(idx + 2);
          masterConn.write("*3\r\n$5\r\nPSYNC\r\n$1\r\n?\r\n$2\r\n-1\r\n");
          handshakeStep++;
        } else break;
      } else if (handshakeStep === 3) {
        const idx = masterBuffer.indexOf("\r\n");
        if (idx !== -1) {
          masterBuffer = masterBuffer.slice(idx + 2);
          handshakeStep++;
        } else break;
      } else if (handshakeStep === 4) {
        if (rdbSize === -1) {
          const idx = masterBuffer.indexOf("\r\n");
          if (idx !== -1) {
            const header = masterBuffer.slice(0, idx).toString();
            masterBuffer = masterBuffer.slice(idx + 2);
            if (header.startsWith("$")) {
              rdbSize = parseInt(header.slice(1), 10);
            }
          } else break;
        }
        if (rdbSize !== -1) {
          if (masterBuffer.length >= rdbSize) {
            masterBuffer = masterBuffer.slice(rdbSize);
            handshakeStep++;
          } else break;
        }
      } else if (handshakeStep === 5) {
        let offset = 0;
        const readLine = () => {
          const idx = masterBuffer.indexOf("\r\n", offset);
          if (idx === -1) return null;
          const line = masterBuffer.slice(offset, idx).toString();
          offset = idx + 2;
          return line;
        };

        const firstLine = readLine();
        if (firstLine === null) break;

        if (firstLine.startsWith("*")) {
          const numArgs = parseInt(firstLine.slice(1), 10);
          const args = [];
          let hasFullCommand = true;

          for (let i = 0; i < numArgs; i++) {
            const lenLine = readLine();
            if (lenLine === null) { hasFullCommand = false; break; }
            
            const argLen = parseInt(lenLine.slice(1), 10);
            if (masterBuffer.length < offset + argLen + 2) {
              hasFullCommand = false; break;
            }
            
            const arg = masterBuffer.slice(offset, offset + argLen).toString();
            offset += argLen + 2;
            args.push(arg);
          }

          if (hasFullCommand) {
            masterBuffer = masterBuffer.slice(offset);
            
            const command = args[0].toLowerCase();
            if (command === "set") {
              const key = args[1];
              const value = args[2];
              let expiresAt = null;
              if (args.length >= 5 && args[3].toLowerCase() === "px") {
                expiresAt = Date.now() + parseInt(args[4], 10);
              }
              store.set(key, { value, expiresAt });
            } else if (command === "replconf") {
              if (args.length >= 3 && args[1].toLowerCase() === "getack") {
                const pbStr = processedBytes.toString();
                masterConn.write(`*3\r\n$8\r\nREPLCONF\r\n$3\r\nACK\r\n$${pbStr.length}\r\n${pbStr}\r\n`);
              }
            }
            
            processedBytes += offset;
          } else {
            break;
          }
        } else {
          masterBuffer = masterBuffer.slice(offset);
        }
      }
    }
  });
}
