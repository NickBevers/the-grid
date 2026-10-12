/**
 * A minimal PNG decoder for the checks: 8-bit RGB or RGBA, non-interlaced, as Playwright writes them.
 * Returns { width, height, pixel(x, y) => [r, g, b] }.
 */
import { inflateSync } from 'node:zlib';

export function decodePng(buffer) {
    let offset = 8;
    let width = 0;
    let height = 0;
    let channels = 0;
    const chunks = [];
    while (offset < buffer.length) {
        const length = buffer.readUInt32BE(offset);
        const type = buffer.toString('ascii', offset + 4, offset + 8);
        const data = buffer.subarray(offset + 8, offset + 8 + length);
        if (type === 'IHDR') {
            width = data.readUInt32BE(0);
            height = data.readUInt32BE(4);
            const colorType = data[9];
            if (data[8] !== 8 || data[12] !== 0 || (colorType !== 2 && colorType !== 6)) {
                throw new Error('decodePng: only 8-bit, non-interlaced RGB or RGBA');
            }
            channels = colorType === 6 ? 4 : 3;
        } else if (type === 'IDAT') {
            chunks.push(data);
        }
        offset += 12 + length;
    }
    const raw = inflateSync(Buffer.concat(chunks));
    const stride = width * channels;
    const pixels = Buffer.alloc(height * stride);
    for (let y = 0; y < height; y++) {
        const filter = raw[y * (stride + 1)];
        for (let x = 0; x < stride; x++) {
            const value = raw[y * (stride + 1) + 1 + x];
            const left = x >= channels ? pixels[y * stride + x - channels] : 0;
            const up = y > 0 ? pixels[(y - 1) * stride + x] : 0;
            const upLeft = y > 0 && x >= channels ? pixels[(y - 1) * stride + x - channels] : 0;
            let predicted = 0;
            if (filter === 1) predicted = left;
            else if (filter === 2) predicted = up;
            else if (filter === 3) predicted = (left + up) >> 1;
            else if (filter === 4) {
                const p = left + up - upLeft;
                const pa = Math.abs(p - left);
                const pb = Math.abs(p - up);
                const pc = Math.abs(p - upLeft);
                predicted = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
            }
            pixels[y * stride + x] = (value + predicted) & 0xff;
        }
    }

    return {
        width,
        height,
        pixel(x, y) {
            const index = y * stride + x * channels;

            return [pixels[index], pixels[index + 1], pixels[index + 2]];
        },
    };
}
