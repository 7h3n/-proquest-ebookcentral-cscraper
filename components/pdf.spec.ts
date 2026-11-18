import { deflateSync } from 'node:zlib';

import { jsPDF } from 'jspdf';
import { describe, expect, it } from 'vitest';

import { addImagePage, storedImageBytes } from './pdf';
import { sniffImageFormat } from './utils';

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return c >>> 0;
});

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** A white RGB "page" with dark lines of "text", similar to a scanned book page */
function makePagePNG(width: number, height: number): Uint8Array {
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 3, 255);
    row[0] = 0; // no filter
    if (y % 28 < 14) {
      for (let x = 60; x < width - 60; x++) {
        if (x % 50 < 38) {
          row.fill(30, 1 + x * 3, 4 + x * 3);
        }
      }
    }
    rows.push(row);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // RGB
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', header),
      chunk('IDAT', deflateSync(Buffer.concat(rows))),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  );
}

describe('pdf', () => {
  it('detects image formats from their first bytes', () => {
    expect(sniffImageFormat(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('JPEG');
    expect(sniffImageFormat(makePagePNG(4, 4))).toBe('PNG');
    expect(sniffImageFormat(new TextEncoder().encode('<!DOCTYPE html>'))).toBeNull();
  });

  it('keeps PNG pages compressed instead of storing raw pixels', () => {
    const width = 1384;
    const height = 1790;
    const png = makePagePNG(width, height);
    const rawPixels = width * height * 3; // what jsPDF stores for a PNG when no compression is set

    const pdf = new jsPDF('p', 'pt', 'a4');
    addImagePage(pdf, { bytes: png, format: 'PNG', width, height }, false);
    addImagePage(pdf, { bytes: png, format: 'PNG', width, height }, true);

    const stored = storedImageBytes(pdf);
    expect(stored).toBeGreaterThan(0);
    expect(stored).toBeLessThan(rawPixels / 20);
    expect(pdf.getNumberOfPages()).toBe(2);
  });

  it('reports no stored images for an empty document', () => {
    expect(storedImageBytes(new jsPDF())).toBe(0);
  });
});
