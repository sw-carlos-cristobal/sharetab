/**
 * Standalone OCR worker script — runs Tesseract.js in its own process
 * to avoid WASM/Worker conflicts with Next.js bundlers.
 *
 * Usage: echo <base64-image> | node ocr-worker.mjs
 * Output: OCR text to stdout
 */
import Tesseract from 'tesseract.js';

const chunks = [];
for await (const chunk of process.stdin) {
  chunks.push(chunk);
}
const imageBuffer = Buffer.from(Buffer.concat(chunks).toString('utf-8'), 'base64');

const { data } = await Tesseract.recognize(imageBuffer, 'eng');
process.stdout.write(data.text);
