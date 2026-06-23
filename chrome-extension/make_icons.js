// Generates simple PNG icons without external dependencies.
'use strict';
const zlib = require('zlib');
const fs   = require('fs');
const path = require('path');

function crc32(buf) {
  const table = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[i] = c;
    }
    return t;
  })();
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf  = Buffer.alloc(4); lenBuf.writeUInt32BE(data.length);
  const crcBuf  = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function makePNG(size) {
  // Draw a purple circle on dark background
  const BG  = [0x1e, 0x1e, 0x2e, 0xff]; // #1e1e2e
  const FG  = [0x7c, 0x6a, 0xf7, 0xff]; // #7c6af7 (accent purple)
  const FG2 = [0x4e, 0xc9, 0xb0, 0xff]; // #4ec9b0 (teal)

  const cx = size / 2, cy = size / 2, r = size * 0.42;
  const inner = size * 0.22;

  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(size * 4 + 1);
    row[0] = 0; // filter type None
    for (let x = 0; x < size; x++) {
      const dx = x - cx, dy = y - cy;
      const dist = Math.sqrt(dx*dx + dy*dy);
      let pixel;
      if (dist <= inner) pixel = FG2;
      else if (dist <= r) pixel = FG;
      else pixel = BG;
      const off = 1 + x * 4;
      row[off] = pixel[0]; row[off+1] = pixel[1];
      row[off+2] = pixel[2]; row[off+3] = pixel[3];
    }
    rows.push(row);
  }

  const raw   = Buffer.concat(rows);
  const idat  = zlib.deflateSync(raw, { level: 9 });

  const sig  = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size,  0);
  ihdr.writeUInt32BE(size,  4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // colour type: truecolour (but we need 6 for alpha)
  ihdr[9] = 6;  // truecolour + alpha
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const dir = path.join(__dirname, 'icons');
for (const size of [16, 48, 128]) {
  fs.writeFileSync(path.join(dir, `icon${size}.png`), makePNG(size));
  console.log(`icon${size}.png written`);
}
