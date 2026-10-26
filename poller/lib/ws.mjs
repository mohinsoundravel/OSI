/**
 * Minimal WebSocket client (RFC 6455) on node:https, so the poller keeps zero
 * dependencies and does not rely on a global WebSocket (absent in Node 20).
 * Client-to-server frames are masked; server frames may be text or binary and
 * fragmented. Caps total bytes and frame size so a misbehaving server cannot
 * exhaust the runner's memory.
 */
import http from 'node:http';
import https from 'node:https';
import { createHash, randomBytes } from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_FRAME_BYTES = 4 * 1024 * 1024;

export function encodeFrame(opcode, payload) {
  const len = payload.length;
  const header = len < 126 ? Buffer.alloc(2) : len < 65536 ? Buffer.alloc(4) : Buffer.alloc(10);
  header[0] = 0x80 | opcode;
  if (len < 126) header[1] = 0x80 | len;
  else if (len < 65536) { header[1] = 0x80 | 126; header.writeUInt16BE(len, 2); }
  else { header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(len), 2); }
  const mask = randomBytes(4);
  const body = Buffer.alloc(len);
  for (let i = 0; i < len; i++) body[i] = payload[i] ^ mask[i & 3];
  return Buffer.concat([header, mask, body]);
}

/**
 * Splits a buffer into complete frames. Returns the frames, the unconsumed rest and,
 * for an oversized frame, an error (the caller closes the connection).
 */
export function parseFrames(input) {
  let buf = input;
  const frames = [];
  for (;;) {
    if (buf.length < 2) break;
    const fin = (buf[0] & 0x80) !== 0;
    const opcode = buf[0] & 0x0f;
    const masked = (buf[1] & 0x80) !== 0;
    let len = buf[1] & 0x7f;
    let off = 2;
    if (len === 126) {
      if (buf.length < 4) break;
      len = buf.readUInt16BE(2);
      off = 4;
    } else if (len === 127) {
      if (buf.length < 10) break;
      const big = buf.readBigUInt64BE(2);
      if (big > BigInt(MAX_FRAME_BYTES)) return { frames, rest: Buffer.alloc(0), error: 'frame too large' };
      len = Number(big);
      off = 10;
    }
    if (len > MAX_FRAME_BYTES) return { frames, rest: Buffer.alloc(0), error: 'frame too large' };
    const maskKey = masked ? buf.subarray(off, off + 4) : null;
    if (masked) off += 4;
    if (buf.length < off + len) break;
    let payload = Buffer.from(buf.subarray(off, off + len));
    if (maskKey) for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i & 3];
    buf = buf.subarray(off + len);
    if ([0x0, 0x1, 0x2, 0x8, 0x9, 0xa].includes(opcode)) frames.push({ fin, opcode, payload });
  }
  return { frames, rest: buf };
}

/**
 * Connects and resolves to { send(text), close() }. onMessage receives each complete
 * message as a string. Resolves `done` when the connection ends, for any reason.
 */
export function connectWebSocket(url, { onMessage, onClose = () => {}, maxBytes = 50 * 1024 * 1024, connectTimeoutMs = 15000, userAgent = 'OSI-Monitor/1.0', allowLoopback = false } = {}) {
  const target = new URL(url);
  /* Plain ws:// only for a loopback address, and only when asked (the browser test's DevTools link). */
  const loopback = allowLoopback && target.protocol === 'ws:' && ['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname);
  if (target.protocol !== 'wss:' && !loopback) throw new Error('only wss:// is allowed');
  const transport = loopback ? http : https;
  const key = randomBytes(16).toString('base64');
  const expected = createHash('sha1').update(key + GUID).digest('base64');

  return new Promise((resolve, reject) => {
    const req = transport.request({
      host: target.hostname, port: target.port || (loopback ? 80 : 443), path: `${target.pathname}${target.search}`, method: 'GET',
      headers: {
        Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': key,
        'User-Agent': userAgent
      }
    });
    const timer = setTimeout(() => req.destroy(new Error('websocket connect timeout')), connectTimeoutMs);
    req.on('response', (res) => {
      clearTimeout(timer);
      res.resume();
      reject(new Error(`websocket upgrade refused: HTTP ${res.statusCode}`));
    });
    req.on('error', (err) => { clearTimeout(timer); reject(err); });
    req.on('upgrade', (res, socket, head) => {
      clearTimeout(timer);
      if (res.headers['sec-websocket-accept'] !== expected) {
        socket.destroy();
        reject(new Error('websocket handshake: bad accept key'));
        return;
      }
      let buf = head && head.length ? Buffer.from(head) : Buffer.alloc(0);
      let total = 0;
      let parts = [];
      let closed = false;
      const finish = (reason) => {
        if (closed) return;
        closed = true;
        socket.destroy();
        onClose(reason);
      };
      const parse = () => {
        const { frames, rest, error } = parseFrames(buf);
        buf = rest;
        for (const f of frames) {
          if (f.opcode === 0x8) { finish('closed by server'); return; }
          if (f.opcode === 0x9) { socket.write(encodeFrame(0xa, f.payload)); continue; }
          if (f.opcode === 0xa) continue;
          parts.push(f.payload);
          if (f.fin) {
            const message = Buffer.concat(parts).toString('utf8');
            parts = [];
            try { onMessage(message); } catch { /* a bad message must not kill the stream */ }
          }
        }
        if (error) finish(error);
      };
      socket.on('data', (chunk) => {
        total += chunk.length;
        if (total > maxBytes) { finish('byte limit reached'); return; }
        buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
        parse();
      });
      socket.on('close', () => finish('socket closed'));
      socket.on('error', () => finish('socket error'));
      parse();
      resolve({
        send: (text) => { if (!closed) socket.write(encodeFrame(0x1, Buffer.from(text, 'utf8'))); },
        close: () => {
          if (closed) return;
          try { socket.write(encodeFrame(0x8, Buffer.alloc(0))); } catch { /* ignore */ }
          finish('closed by client');
        }
      });
    });
    req.end();
  });
}
