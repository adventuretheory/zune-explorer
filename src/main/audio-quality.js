// How much of the sound a file really has: the highest frequency with real
// content. MP3 encoders cut off the top end — around 16 kHz at 128 kbps,
// 19–20 kHz at 256–320 kbps — so a "320 kbps" file that stops at 16 kHz was
// made from a 128 kbps copy and sounds like one.

const { spawn } = require('child_process');

const SAMPLE_RATE = 44100;
const FFT_SIZE = 4096;
const SECONDS = 12;

/** In-place radix-2 FFT on real/imag arrays (length = power of two). */
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

/**
 * Average power spectrum (dB per bin, FFT_SIZE/2 bins up to 22.05 kHz) of
 * mono float samples.
 */
function averageSpectrum(samples) {
  const half = FFT_SIZE / 2;
  const power = new Float64Array(half);
  const win = new Float64Array(FFT_SIZE);
  for (let i = 0; i < FFT_SIZE; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1));
  let frames = 0;
  const re = new Float64Array(FFT_SIZE);
  const im = new Float64Array(FFT_SIZE);
  for (let off = 0; off + FFT_SIZE <= samples.length; off += FFT_SIZE) {
    for (let i = 0; i < FFT_SIZE; i++) { re[i] = samples[off + i] * win[i]; im[i] = 0; }
    fft(re, im);
    for (let k = 0; k < half; k++) power[k] += re[k] * re[k] + im[k] * im[k];
    frames++;
  }
  if (!frames) return null;
  const db = new Float64Array(half);
  for (let k = 0; k < half; k++) db[k] = 10 * Math.log10(power[k] / frames + 1e-20);
  return db;
}

/**
 * Highest frequency with real content, from a spectrum in dB.
 * @returns {{ cutoffHz: number, refDb: number } | null} null when the
 *   excerpt is too quiet to judge
 */
function cutoffFromSpectrum(db) {
  if (!db) return null;
  const hz = SAMPLE_RATE / FFT_SIZE;
  const bin = (f) => Math.round(f / hz);
  // Reference: typical level in the 2–8 kHz range
  const mids = Array.from(db.slice(bin(2000), bin(8000))).sort((a, b) => a - b);
  const refDb = mids[Math.floor(mids.length / 2)];
  if (!(refDb > -40)) return null; // near silence
  // Smooth over ~250 Hz and walk down from the top until there's content
  const width = Math.max(1, Math.round(250 / hz));
  const top = bin(21500);
  for (let k = top; k >= bin(10000); k--) {
    let sum = 0;
    for (let j = k - width; j <= k; j++) sum += db[j];
    if (sum / (width + 1) > refDb - 60) return { cutoffHz: Math.round(k * hz), refDb };
  }
  return { cutoffHz: 10000, refDb };
}

/**
 * Measure a song's cutoff from an excerpt a third of the way in.
 * @param {number} durationSec  song length (to pick the excerpt), 0 if unknown
 */
function measureCutoff(ffmpegPath, filePath, durationSec = 0) {
  return new Promise((resolve) => {
    const start = durationSec > SECONDS * 2 ? Math.floor(durationSec / 3) : 0;
    const proc = spawn(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-ss', String(start), '-t', String(SECONDS),
      '-i', filePath, '-vn', '-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 'f32le', '-']);
    const chunks = [];
    proc.stdout.on('data', (c) => chunks.push(c));
    proc.stderr.on('data', () => {});
    proc.on('error', () => resolve(null));
    proc.on('close', () => {
      const buf = Buffer.concat(chunks);
      if (buf.length < FFT_SIZE * 4 * 8) return resolve(null);
      const samples = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 4));
      resolve(cutoffFromSpectrum(averageSpectrum(samples)));
    });
  });
}

module.exports = { measureCutoff, cutoffFromSpectrum, averageSpectrum, fft };
