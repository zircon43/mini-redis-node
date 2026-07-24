const net = require("net");

// You can use print statements as follows for debugging, they'll be visible when running tests.
console.log("Logs from your program will appear here!");

const store = new Map();
const blockedClients = new Map();

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
        
        if (command === "ping") {
          connection.write("+PONG\r\n");
        } else if (command === "echo") {
          const arg = args[1];
          connection.write(`$${arg.length}\r\n${arg}\r\n`);
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
          const entryId = args[2];
          const kvs = args.slice(3);
          
          let streamEntries = [];
          const entry = store.get(key);
          if (entry && entry.type === "stream") {
            streamEntries = entry.value;
          }
          
          const [newMs, newSeq] = entryId.split("-").map(Number);
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
            }
          }
        }
      }
    }
  });
});

server.listen(6379, "127.0.0.1");
