function xaddCommand(args, connection, ctx) {
  const key = args[1];
  let entryId = args[2];
  const kvs = args.slice(3);
  
  let streamEntries = [];
  const entry = ctx.store.get(key);
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
      ctx.store.set(key, { type: "stream", value: streamEntries, expiresAt: null });
      
      connection.write(`$${entryId.length}\r\n${entryId}\r\n`);
      ctx.checkBlockedXreadClients(key);
    }
  }
}

function xrangeCommand(args, connection, ctx) {
  const key = args[1];
  const startArg = args[2];
  const endArg = args[3];
  
  let startId = startArg.includes("-") ? startArg : `${startArg}-0`;
  if (startArg === "-") startId = "0-0";
  
  let endId = endArg.includes("-") ? endArg : `${endArg}-${Infinity}`;
  if (endArg === "+") endId = `${Infinity}-${Infinity}`;
  
  const entry = ctx.store.get(key);
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
}

function xreadCommand(args, connection, ctx) {
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
          const entry = ctx.store.get(keys[i]);
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
       
       const entry = ctx.store.get(key);
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
         ctx.blockedXreadClients.push(clientObj);
       } else {
         connection.write("*-1\r\n");
       }
    } else {
       let res = `*${streamResponses.length}\r\n` + streamResponses.join("");
       connection.write(res);
    }
  }
}

module.exports = {
  xadd: xaddCommand,
  xrange: xrangeCommand,
  xread: xreadCommand
};
