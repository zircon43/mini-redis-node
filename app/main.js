const net = require("net");

// You can use print statements as follows for debugging, they'll be visible when running tests.
console.log("Logs from your program will appear here!");

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
        }
      }
    }
  });
});

server.listen(6379, "127.0.0.1");
