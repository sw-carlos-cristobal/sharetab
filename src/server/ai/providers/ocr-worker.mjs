/**
 * Standalone OCR worker script — runs Tesseract.js in its own process
 * to avoid WASM/Worker conflicts with Next.js bundlers.
 *
 * Preprocessing pipeline (via sharp):
 *   1. Convert to grayscale
 *   2. Normalize contrast (stretch histogram)
 *   3. Sharpen text edges
 *   4. Upscale small images to minimum 2000px width for better OCR
 *
 * Usage: echo <base64-image> | node ocr-worker.mjs
 * Output: JSON to stdout: {"text": "...", "confidence": 0.85}
 */
import Tesseract from 'tesseract.js';

const chunks = [];
for await (const chunk of process.stdin) {
  chunks.push(chunk);
}
const rawBuffer = Buffer.from(Buffer.concat(chunks).toString('utf-8'), 'base64');

// ── Preprocess image for better OCR accuracy ──────────────────────

let imageBuffer = rawBuffer;
try {
  const sharp = (await import('sharp')).default;
  const metadata = await sharp(rawBuffer).metadata();
  const width = metadata.width || 0;

  let pipeline = sharp(rawBuffer)
    .grayscale()                    // Remove color noise
    .normalize()                    // Stretch contrast (helps faded thermal prints)
    .sharpen({ sigma: 1.5 });      // Sharpen text edges

  // Upscale small images — Tesseract needs ~300 DPI for good results
  // Most phone photos are fine, but screenshots/thumbnails may be too small
  if (width > 0 && width < 2000) {
    const scale = Math.ceil(2000 / width);
    pipeline = pipeline.resize(width * scale, null, {
      kernel: 'lanczos3',
      withoutEnlargement: false,
    });
  }

  imageBuffer = await pipeline.png().toBuffer();
} catch {
  // If sharp fails (missing dependency, corrupt image), fall back to raw buffer
}

// ── Run Tesseract OCR ─────────────────────────────────────────────

const { data } = await Tesseract.recognize(imageBuffer, 'eng', {
  tessedit_pageseg_mode: '4',       // PSM 4: single column of variable-size text
  tessedit_ocr_engine_mode: '1',    // LSTM neural net only (best for printed text)
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
