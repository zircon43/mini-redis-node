function parseConfig() {
  const config = {
    port: 6379,
    dir: process.cwd(),
    dbfilename: "",
    appendonly: "no",
    appenddirname: "appendonlydir",
    appendfilename: "appendonly.aof",
    appendfsync: "everysec",
    isReplica: false,
    masterHost: null,
    masterPort: null,
  };

  const args = process.argv;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--port" && i + 1 < args.length) {
      config.port = parseInt(args[i + 1], 10);
    } else if (args[i] === "--dir" && i + 1 < args.length) {
      config.dir = args[i + 1];
    } else if (args[i] === "--dbfilename" && i + 1 < args.length) {
      config.dbfilename = args[i + 1];
    } else if (args[i] === "--appendonly" && i + 1 < args.length) {
      config.appendonly = args[i + 1];
    } else if (args[i] === "--appenddirname" && i + 1 < args.length) {
      config.appenddirname = args[i + 1];
    } else if (args[i] === "--appendfilename" && i + 1 < args.length) {
      config.appendfilename = args[i + 1];
    } else if (args[i] === "--appendfsync" && i + 1 < args.length) {
      config.appendfsync = args[i + 1];
    } else if (args[i] === "--replicaof" && i + 1 < args.length) {
      config.isReplica = true;
      const parts = args[i + 1].split(" ");
      config.masterHost = parts[0];
      config.masterPort = parseInt(parts[1], 10);
    }
  }

  return config;
}

module.exports = parseConfig();
