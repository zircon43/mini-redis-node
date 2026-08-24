function haversine(lon1, lat1, lon2, lat2) {
  const R = 6372797.560856;
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.asin(Math.sqrt(a));
  return R * c;
}

function encodeGeoHash(lon, lat) {
  let lon_min = -180, lon_max = 180;
  let lat_min = -85.05112878, lat_max = 85.05112878;
  let score = 0n;
  for (let i = 0; i < 26; i++) {
     let lon_mid = (lon_min + lon_max) / 2;
     if (lon >= lon_mid) {
         score = (score << 1n) | 1n;
         lon_min = lon_mid;
     } else {
         score = (score << 1n) | 0n;
         lon_max = lon_mid;
     }
     let lat_mid = (lat_min + lat_max) / 2;
     if (lat >= lat_mid) {
         score = (score << 1n) | 1n;
         lat_min = lat_mid;
     } else {
         score = (score << 1n) | 0n;
         lat_max = lat_mid;
     }
  }
  return Number(score);
}

function decodeGeoHash(score) {
  let lon_min = -180, lon_max = 180;
  let lat_min = -85.05112878, lat_max = 85.05112878;
  score = BigInt(Math.floor(score));
  for (let i = 0n; i < 26n; i++) {
     let bit_idx = 52n - (i * 2n) - 1n;
     let lon_bit = (score >> bit_idx) & 1n;
     if (lon_bit === 1n) lon_min = (lon_min + lon_max) / 2;
     else lon_max = (lon_min + lon_max) / 2;
     
     let lat_bit_idx = 52n - (i * 2n) - 2n;
     let lat_bit = (score >> lat_bit_idx) & 1n;
     if (lat_bit === 1n) lat_min = (lat_min + lat_max) / 2;
     else lat_max = (lat_min + lat_max) / 2;
  }
  return [(lon_min + lon_max) / 2, (lat_min + lat_max) / 2];
}

module.exports = {
  haversine,
  encodeGeoHash,
  decodeGeoHash
};
