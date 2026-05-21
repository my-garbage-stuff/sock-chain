import * as net from "net";

// ── Relay protocol ──
// Frame: [connId:4][type:1][payloadLen:4][payload...]
export const FRAME_CONNECT = 0x01;
export const FRAME_DATA    = 0x02;
export const FRAME_CLOSE   = 0x03;
export const HDR_SIZE = 9;

// ── SOCKS5 constants ──
export const SOCKS_VERSION   = 0x05;
export const METHOD_NO_AUTH  = 0x00;
export const CMD_CONNECT     = 0x01;
export const ATYP_IPV4       = 0x01;
export const ATYP_DOMAIN     = 0x03;
export const REP_SUCCEEDED   = 0x00;
export const REP_GENERAL_FAILURE = 0x01;

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

export function wsWriteFrame(ws: { send: (data: Buffer) => void }, connId: number, type: number, payload: Buffer): void {
  ws.send(Buffer.concat([frameHeader(connId, type, payload.length), payload]));
}

export function parseFrame(data: Buffer): { connId: number; type: number; payload: Buffer } {
  return {
    connId: data.readUInt32BE(0),
    type: data[4]!,
    payload: data.subarray(HDR_SIZE),
  };
}

export class FrameStream {
  buf = Buffer.alloc(0);

  push(data: Buffer) {
    this.buf = Buffer.concat([this.buf, data]);
    const frames: { connId: number; type: number; payload: Buffer }[] = [];
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

export function parseAddress(buf: Buffer, offset = 0) {
  const atyp = buf[offset]!;
  if (atyp === ATYP_IPV4) {
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

export function socks5Reply(rep: number): Buffer {
  const b = Buffer.alloc(10);
  b[0] = SOCKS_VERSION; b[1] = rep; b[2] = 0x00; b[3] = ATYP_IPV4;
  b.writeUInt32BE(0, 4); b.writeUInt16BE(0, 8);
  return b;
}

export function socks5TargetAddr(atyp: number, buf: Buffer, offset: number): Buffer {
  if (atyp === ATYP_IPV4) {
    const a = Buffer.alloc(7);
    a[0] = ATYP_IPV4;
    buf.copy(a, 1, offset + 1, offset + 5);
    a.writeUInt16BE(buf.readUInt16BE(offset + 5), 5);
    return a;
  }
  const len = buf[offset + 1]!;
  const a = Buffer.alloc(4 + len);
  a[0] = ATYP_DOMAIN;
  a[1] = len;
  buf.copy(a, 2, offset + 2, offset + 2 + len);
  a.writeUInt16BE(buf.readUInt16BE(offset + 2 + len), 2 + len);
  return a;
}
