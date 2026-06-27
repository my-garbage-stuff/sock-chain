import * as net from "net";
import { randomUUID } from "crypto";

// ── Relay protocol ──
// Frame: [connId:4][type:1][payloadLen:4][payload...]

export const FRAME_CONNECT = 0x01;
export const FRAME_DATA    = 0x02;
export const FRAME_CLOSE   = 0x03;
export const FRAME_META    = 0x04;
export const HDR_SIZE = 9;
export const CLIENT_MAGIC = Buffer.from("SOCK");

// ── Helpers ──

export function toBuf(d: string | Buffer): Buffer {
  return typeof d === "string" ? Buffer.from(d) : d;
}

export function frameHeader(connId: number, type: number, payloadLen: number): Buffer {
  const h = Buffer.alloc(HDR_SIZE);
  h.writeUInt32BE(connId, 0);
  h[4] = type;
  h.writeUInt32BE(payloadLen, 5);
  return h;
}

export function tcpWriteFrame(sock: net.Socket, connId: number, type: number, payload: Buffer): boolean {
  return sock.write(Buffer.concat([frameHeader(connId, type, payload.length), payload]));
}

export function bunWriteFrame(sock: { write: (d: Buffer) => number }, connId: number, type: number, payload: Buffer): void {
  sock.write(Buffer.concat([frameHeader(connId, type, payload.length), payload]));
}

// ── Frame parsing ──

export interface Frame {
  connId: number;
  type: number;
  payload: Buffer;
}

export function parseFrame(data: Buffer): Frame {
  return {
    connId: data.readUInt32BE(0),
    type: data[4]!,
    payload: data.subarray(HDR_SIZE),
  };
}

// Accumulates data and yields complete frames
export class FrameStream {
  buf = Buffer.alloc(0);

  push(data: Buffer): Frame[] {
    this.buf = Buffer.concat([this.buf, data]);
    const frames: Frame[] = [];
    while (this.buf.length >= HDR_SIZE) {
      const payloadLen = this.buf.readUInt32BE(5);
      const totalLen = HDR_SIZE + payloadLen;
      if (this.buf.length < totalLen) break;
      frames.push({
        connId: this.buf.readUInt32BE(0),
        type: this.buf[4]!,
        payload: this.buf.subarray(HDR_SIZE, totalLen),
      });
      this.buf = this.buf.subarray(totalLen);
    }
    return frames;
  }
}

export function now(): string {
  return new Date().toISOString().slice(11, 19);
}

// ── Target address encoding (SOCKS5-style) ──

export function parseAddress(buf: Buffer, offset = 0) {
  const atyp = buf[offset]!;
  if (atyp === 0x01) {
    return {
      addr: Array.from(buf.slice(offset + 1, offset + 5)).join("."),
      port: buf.readUInt16BE(offset + 5),
    };
  }
  const len = buf[offset + 1]!;
  return {
    addr: buf.slice(offset + 2, offset + 2 + len).toString(),
    port: buf.readUInt16BE(offset + 2 + len),
  };
}

export function encodeTargetAddr(host: string, port: number): Buffer {
  const ipv4 = net.isIPv4(host);
  if (ipv4) {
    const a = Buffer.alloc(7);
    a[0] = 0x01;
    const parts = host.split(".").map(Number);
    a[1] = parts[0]!; a[2] = parts[1]!; a[3] = parts[2]!; a[4] = parts[3]!;
    a.writeUInt16BE(port, 5);
    return a;
  }
  const hostB = Buffer.from(host, "utf8");
  const a = Buffer.alloc(4 + hostB.length);
  a[0] = 0x03;
  a[1] = hostB.length;
  hostB.copy(a, 2);
  a.writeUInt16BE(port, 2 + hostB.length);
  return a;
}

// ── HTTP CONNECT parsing ──

const CONNECT_RE = /^CONNECT\s+(?:([a-f0-9-]{36})@)?([^:\s]+):(\d+)\s+HTTP\/1\.[01]/i;
const HTTP_EOM = Buffer.from("\r\n\r\n");

export function tryParseConnect(data: Buffer): { host: string; port: number; uuid?: string } | null {
  const idx = data.indexOf(HTTP_EOM);
  if (idx === -1) return null;
  const head = data.subarray(0, idx).toString();
  const m = head.match(CONNECT_RE);
  if (!m) return null;
  const r: { host: string; port: number; uuid?: string } = { host: m[2]!, port: parseInt(m[3]!, 10) };
  if (m[1]) {
    r.uuid = m[1]!;
  } else {
    const au = extractUUIDfromHeaders(head);
    if (au) r.uuid = au;
  }
  return r;
}

const AUTH_RE = /^Proxy-Authorization:\s*Basic\s+([A-Za-z0-9+/=]+)\s*$/im;
const UUID_HEADER_RE = /^Proxy-UUID:\s*([a-f0-9-]{36})\s*$/im;

function extractUUIDfromHeaders(head: string): string | null {
  const h = head.match(UUID_HEADER_RE);
  if (h) return h[1]!;
  const m = head.match(AUTH_RE);
  if (!m) return null;
  try {
    const decoded = Buffer.from(m[1]!, "base64").toString();
    const user = decoded.split(":")[0]!;
    if (/^[a-f0-9-]{36}$/i.test(user)) return user;
  } catch {}
  return null;
}

export { randomUUID } from "crypto";

export function makeConnectResponse(): Buffer {
  return Buffer.from("HTTP/1.1 200 Connection established\r\n\r\n");
}
