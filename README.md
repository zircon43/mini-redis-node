# Mini Redis in Node.js

A high-performance, lightweight Redis clone built entirely from scratch in Node.js. 

This project aims to recreate the core features of Redis, demonstrating a deep understanding of network programming, the RESP (REdis Serialization Protocol) protocol, concurrency, and complex data structures.

## Supported Features

- **Core Key-Value Operations**: `SET`, `GET`, `INCR`
- **Data Structures**: 
  - **Lists**: `LPUSH`, `RPUSH`, `LPOP`, `LRANGE`, `LLEN`, `BLPOP` (blocking pops)
  - **Sorted Sets & Geospatial**: `ZADD`, `ZRANK`, `ZRANGE`, `ZCARD`, `ZSCORE`, `ZREM`, `GEOADD`, `GEOPOS`, `GEODIST`, `GEOSEARCH`
  - **Streams**: `XADD`, `XRANGE`, `XREAD` (including blocking reads)
- **Transactions**: `MULTI`, `EXEC`, `DISCARD`, `WATCH`, `UNWATCH`
- **Publish/Subscribe**: `SUBSCRIBE`, `UNSUBSCRIBE`, `PUBLISH`
- **Security**: `AUTH`, `ACL` (Set and Get user permissions)
- **Persistence**: RDB file parsing and Append-Only File (AOF) support
- **Replication**: Master-Replica handshakes, `PSYNC`, `REPLCONF`, and `WAIT` commands.

## Architecture

The project is structured into modular components:
- `app/main.js`: The core TCP server and event loop handling client connections.
- `app/commands/`: Individual command handlers isolated by data type/feature.
- `app/resp.js`: A custom RESP parser and formatter for handling the Redis protocol.
- `app/geoUtils.js`: Complex mathematics and geohash encoding for Geo commands.

## Running Locally

To run the server locally:

```bash
npm start
```

You can then connect to it using the standard `redis-cli`:

```bash
redis-cli
127.0.0.1:6379> PING
PONG
127.0.0.1:6379> SET mykey "Hello World"
OK
127.0.0.1:6379> GET mykey
"Hello World"
```

## Running as a Replica

```bash
npm start -- --port 6380 --replicaof "127.0.0.1 6379"
```

## Future Enhancements
- Eviction policies (LRU/LFU)
- Hash data structures (`HSET`, `HGET`)
- Full Cluster support
