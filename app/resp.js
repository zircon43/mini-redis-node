/**
 * Parses raw buffer data into an array of RESP arguments.
 * Assuming the buffer contains a single RESP array for the command.
 * 
 * @param {Buffer} data 
 * @returns {Array<string>|null} The parsed arguments, or null if not a valid array.
 */
function parseCommands(data) {
  const lines = data.toString().split("\r\n");
  
  if (lines[0].startsWith("*")) {
    const numArgs = parseInt(lines[0].slice(1), 10);
    const args = [];
    let currentLine = 1;
    
    for (let i = 0; i < numArgs; i++) {
      if (lines[currentLine] && lines[currentLine].startsWith("$")) {
        currentLine++;
        args.push(lines[currentLine]);
        currentLine++;
      }
    }
    return args;
  }
  return null;
}

function formatRESPArray(arr) {
  let res = `*${arr.length}\r\n`;
  for (const item of arr) {
    if (Array.isArray(item)) {
       res += formatRESPArray(item);
    } else {
       res += `$${item.length}\r\n${item}\r\n`;
    }
  }
  return res;
}

module.exports = {
  parseCommands,
  formatRESPArray
};
