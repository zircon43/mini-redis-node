const crypto = require("crypto");

function authCommand(args, connection, ctx) {
  const username = args[1] || "";
  const password = args[2] || "";
  const user = ctx.users[username];
  
  if (!user) {
     connection.write("-WRONGPASS invalid username-password pair or user is disabled.\r\n");
  } else if (user.flags.includes("nopass")) {
     connection.authenticatedUser = username;
     connection.write("+OK\r\n");
  } else {
     const hash = crypto.createHash("sha256").update(password).digest("hex");
     if (user.passwords.includes(hash)) {
         connection.authenticatedUser = username;
         connection.write("+OK\r\n");
     } else {
         connection.write("-WRONGPASS invalid username-password pair or user is disabled.\r\n");
     }
  }
}

function aclCommand(args, connection, ctx) {
  const subcmd = args[1] ? args[1].toLowerCase() : "";
  if (subcmd === "whoami") {
     const user = connection.authenticatedUser;
     if (!user) {
         connection.write("-NOAUTH Authentication required.\r\n");
     } else {
         connection.write(`$${user.length}\r\n${user}\r\n`);
     }
  } else if (subcmd === "getuser") {
     const username = args[2];
     const user = ctx.users[username];
     if (!user) {
         connection.write("$-1\r\n");
     } else {
         let res = "*4\r\n";
         res += "$5\r\nflags\r\n";
         res += `*${user.flags.length}\r\n`;
         for (const flag of user.flags) {
             res += `$${flag.length}\r\n${flag}\r\n`;
         }
         res += "$9\r\npasswords\r\n";
         res += `*${user.passwords.length}\r\n`;
         for (const pass of user.passwords) {
             res += `$${pass.length}\r\n${pass}\r\n`;
         }
         connection.write(res);
     }
  } else if (subcmd === "setuser") {
     const username = args[2];
     if (!ctx.users[username]) {
         ctx.users[username] = { flags: [], passwords: [] };
     }
     const user = ctx.users[username];
     
     for (let i = 3; i < args.length; i++) {
         const rule = args[i];
         if (rule.startsWith(">")) {
             const password = rule.slice(1);
             const hash = crypto.createHash("sha256").update(password).digest("hex");
             user.passwords.push(hash);
             
             const idx = user.flags.indexOf("nopass");
             if (idx !== -1) {
                 user.flags.splice(idx, 1);
             }
         }
     }
     connection.write("+OK\r\n");
  }
}

module.exports = {
  auth: authCommand,
  acl: aclCommand
};
