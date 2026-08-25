const { haversine, encodeGeoHash, decodeGeoHash } = require('../geoUtils');

function zaddCommand(args, connection, ctx) {
  ctx.appendToAof(args);
  const key = args[1];
  const score = parseFloat(args[2]);
  const member = args[3];

  let entry = ctx.store.get(key);
  let added = 0;

  if (!entry || entry.type !== "zset") {
     entry = { value: [], type: "zset", expiresAt: null };
     ctx.store.set(key, entry);
  }

  let zset = entry.value;
  let existingIdx = zset.findIndex(e => e.member === member);

  const sortZSet = () => {
     zset.sort((a, b) => {
        if (a.score !== b.score) return a.score - b.score;
        if (a.member < b.member) return -1;
        if (a.member > b.member) return 1;
        return 0;
     });
  };

  if (existingIdx !== -1) {
     if (zset[existingIdx].score !== score) {
        zset[existingIdx].score = score;
        sortZSet();
     }
     connection.write(":0\r\n");
  } else {
     zset.push({ score, member });
     sortZSet();
     connection.write(":1\r\n");
  }
}

function zrankCommand(args, connection, ctx) {
  const key = args[1];
  const member = args[2];
  const entry = ctx.store.get(key);
  if (!entry || entry.type !== "zset") {
     connection.write("$-1\r\n");
  } else {
     const idx = entry.value.findIndex(e => e.member === member);
     if (idx === -1) {
        connection.write("$-1\r\n");
     } else {
        connection.write(`:${idx}\r\n`);
     }
  }
}

function zrangeCommand(args, connection, ctx) {
  const key = args[1];
  let start = parseInt(args[2], 10);
  let stop = parseInt(args[3], 10);
  
  const entry = ctx.store.get(key);
  if (!entry || entry.type !== "zset") {
     connection.write("*0\r\n");
  } else {
     const zset = entry.value;
     const len = zset.length;
     
     if (start < 0) start = len + start;
     if (stop < 0) stop = len + stop;
     
     if (start < 0) start = 0;
     if (stop < 0) stop = 0;
     
     if (start >= len || start > stop) {
        connection.write("*0\r\n");
     } else {
        if (stop >= len) stop = len - 1;
        const result = zset.slice(start, stop + 1);
        let resStr = `*${result.length}\r\n`;
        for (const item of result) {
           resStr += `$${item.member.length}\r\n${item.member}\r\n`;
        }
        connection.write(resStr);
     }
  }
}

function zcardCommand(args, connection, ctx) {
  const key = args[1];
  const entry = ctx.store.get(key);
  if (!entry || entry.type !== "zset") {
     connection.write(":0\r\n");
  } else {
     connection.write(`:${entry.value.length}\r\n`);
  }
}

function zscoreCommand(args, connection, ctx) {
  const key = args[1];
  const member = args[2];
  const entry = ctx.store.get(key);
  if (!entry || entry.type !== "zset") {
     connection.write("$-1\r\n");
  } else {
     const existing = entry.value.find(e => e.member === member);
     if (!existing) {
        connection.write("$-1\r\n");
     } else {
        const scoreStr = existing.score.toString();
        connection.write(`$${scoreStr.length}\r\n${scoreStr}\r\n`);
     }
  }
}

function zremCommand(args, connection, ctx) {
  ctx.appendToAof(args);
  const key = args[1];
  const member = args[2];
  const entry = ctx.store.get(key);
  if (!entry || entry.type !== "zset") {
     connection.write(":0\r\n");
  } else {
     const idx = entry.value.findIndex(e => e.member === member);
     if (idx === -1) {
        connection.write(":0\r\n");
     } else {
        entry.value.splice(idx, 1);
        connection.write(":1\r\n");
     }
  }
}

function geoaddCommand(args, connection, ctx) {
  ctx.appendToAof(args);
  const key = args[1];
  let added = 0;
  for (let i = 2; i < args.length; i += 3) {
     const lon = parseFloat(args[i]);
     const lat = parseFloat(args[i+1]);
     const member = args[i+2];

     if (isNaN(lon) || isNaN(lat) || lon < -180 || lon > 180 || lat < -85.05112878 || lat > 85.05112878) {
         const errDim = (isNaN(lon) || lon < -180 || lon > 180) ? "longitude" : "latitude";
         connection.write(`-ERR invalid ${errDim} argument\r\n`);
         return;
     }
     const score = encodeGeoHash(lon, lat);
     
     let entry = ctx.store.get(key);
     if (!entry || entry.type !== "zset") {
         entry = { value: [], type: "zset", expiresAt: null };
         ctx.store.set(key, entry);
     }
     let zset = entry.value;
     let existingIdx = zset.findIndex(e => e.member === member);
     if (existingIdx !== -1) {
         zset[existingIdx].score = score;
     } else {
         zset.push({ score, member });
         added++;
     }
     zset.sort((a, b) => {
         if (a.score !== b.score) return a.score - b.score;
         if (a.member < b.member) return -1;
         if (a.member > b.member) return 1;
         return 0;
     });
  }
  connection.write(`:${added}\r\n`);
}

function geoposCommand(args, connection, ctx) {
  const key = args[1];
  const members = args.slice(2);
  const entry = ctx.store.get(key);
  if (!entry || entry.type !== "zset") {
      let res = `*${members.length}\r\n`;
      for (let i = 0; i < members.length; i++) res += "*-1\r\n";
      connection.write(res);
  } else {
      let res = `*${members.length}\r\n`;
      for (const member of members) {
          const existing = entry.value.find(e => e.member === member);
          if (!existing) {
              res += "*-1\r\n";
          } else {
              const [lon, lat] = decodeGeoHash(existing.score);
              const lonS = lon.toString();
              const latS = lat.toString();
              res += `*2\r\n$${lonS.length}\r\n${lonS}\r\n$${latS.length}\r\n${latS}\r\n`;
          }
      }
      connection.write(res);
  }
}

function geodistCommand(args, connection, ctx) {
  const key = args[1];
  const m1 = args[2];
  const m2 = args[3];
  const entry = ctx.store.get(key);
  if (!entry || entry.type !== "zset") {
      connection.write("$-1\r\n");
  } else {
      const e1 = entry.value.find(e => e.member === m1);
      const e2 = entry.value.find(e => e.member === m2);
      if (!e1 || !e2) {
          connection.write("$-1\r\n");
      } else {
          const [lon1, lat1] = decodeGeoHash(e1.score);
          const [lon2, lat2] = decodeGeoHash(e2.score);
          const dist = haversine(lon1, lat1, lon2, lat2);
          const distStr = dist.toFixed(4);
          connection.write(`$${distStr.length}\r\n${distStr}\r\n`);
      }
  }
}

function geosearchCommand(args, connection, ctx) {
  const key = args[1];
  let lon, lat, radius, unit;
  for (let i = 2; i < args.length; i++) {
      if (args[i].toLowerCase() === "fromlonlat") {
          lon = parseFloat(args[i+1]);
          lat = parseFloat(args[i+2]);
          i += 2;
      } else if (args[i].toLowerCase() === "byradius") {
          radius = parseFloat(args[i+1]);
          unit = args[i+2].toLowerCase();
          i += 2;
      }
  }
  if (unit === "km") radius *= 1000;
  else if (unit === "mi") radius *= 1609.34;
  else if (unit === "ft") radius *= 0.3048;
  
  const entry = ctx.store.get(key);
  if (!entry || entry.type !== "zset") {
      connection.write("*0\r\n");
  } else {
      const results = [];
      for (const e of entry.value) {
          const [elon, elat] = decodeGeoHash(e.score);
          const dist = haversine(lon, lat, elon, elat);
          if (dist <= radius) {
              results.push(e.member);
          }
      }
      let resStr = `*${results.length}\r\n`;
      for (const r of results) {
          resStr += `$${r.length}\r\n${r}\r\n`;
      }
      connection.write(resStr);
  }
}

module.exports = {
  zadd: zaddCommand,
  zrank: zrankCommand,
  zrange: zrangeCommand,
  zcard: zcardCommand,
  zscore: zscoreCommand,
  zrem: zremCommand,
  geoadd: geoaddCommand,
  geopos: geoposCommand,
  geodist: geodistCommand,
  geosearch: geosearchCommand
};
