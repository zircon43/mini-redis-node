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
        }
      }
    }
  });
});

server.listen(6379, "127.0.0.1");
