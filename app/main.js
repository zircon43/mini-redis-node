const net = require("net");

// You can use print statements as follows for debugging, they'll be visible when running tests.
console.log("Logs from your program will appear here!");

const store = new Map();

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
          
          if (!entry || !Array.isArray(entry.value) || entry.value.length === 0) {
            connection.write("$-1\r\n");
          } else {
            const list = entry.value;
            const removed = list.shift();
            if (list.length === 0) {
              store.delete(key);
            }
            connection.write(`$${removed.length}\r\n${removed}\r\n`);
          }
        }
      }
    }
  });
});

server.listen(6379, "127.0.0.1");
