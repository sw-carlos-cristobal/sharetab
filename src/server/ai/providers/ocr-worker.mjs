/**
 * Standalone OCR worker script — runs Tesseract.js in its own process
 * to avoid WASM/Worker conflicts with Next.js bundlers.
 *
 * Usage: echo <base64-image> | node ocr-worker.mjs
 * Output: JSON to stdout: {"text": "...", "confidence": 0.85}
 */
import Tesseract from 'tesseract.js';

const chunks = [];
for await (const chunk of process.stdin) {
  chunks.push(chunk);
}
const imageBuffer = Buffer.from(Buffer.concat(chunks).toString('utf-8'), 'base64');

const { data } = await Tesseract.recognize(imageBuffer, 'eng', {
  tessedit_pageseg_mode: '4',       // PSM 4: single column of variable-size text
  load_system_dawg: '0',            // Disable system dictionary (receipt words aren't in it)
  load_freq_dawg: '0',              // Disable frequency dictionary
  preserve_interword_spaces: '1',   // Keep spacing for column alignment
});

// Compute mean word confidence from Tesseract word-level data
let confidence = 0;
if (data.words && data.words.length > 0) {
  const sum = data.words.reduce((acc, w) => acc + w.confidence, 0);
  confidence = sum / data.words.length / 100; // Tesseract returns 0-100, normalize to 0-1
}

process.stdout.write(JSON.stringify({ text: data.text, confidence }));
