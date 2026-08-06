// Measures what embedding photographs costs, using the file names the database
// really holds.
//
// Development has a handful of images while production has thousands, so the
// files are generated locally under the stored names. Gaussian noise, not flat
// colour: a solid image compresses to almost nothing and the measurement would
// be a fiction.
//
//   npm run bench:photos -- <directorio-de-salida> [cuántas]
import { promises as fs, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import dotenv from "dotenv";
import sharp from "sharp";
import pg from "pg";

dotenv.config();

const OUT = process.argv[2];
const HOW_MANY = Number(process.argv[3] ?? 3000);
if (!OUT) {
  console.error("Uso: npm run bench:photos -- <directorio-de-salida> [cuántas]");
  process.exit(1);
}
mkdirSync(OUT, { recursive: true });

const client = new pg.Client({
  host: process.env.PG_IP,
  port: Number(process.env.PG_PORT),
  database: process.env.PG_DATABASE,
  user: process.env.PG_USER,
  password: process.env.PG_PASS,
});
await client.connect();
const { rows } = await client.query(
  `SELECT image FROM eventos   WHERE image IS NOT NULL AND image <> '' AND "deletedAt" IS NULL
   UNION ALL
   SELECT image FROM solucions WHERE image IS NOT NULL AND image <> '' AND "deletedAt" IS NULL`,
);
await client.end();

const directory = await fs.mkdtemp(path.join(os.tmpdir(), "osefi-bench-"));
const sample = await sharp({
  create: {
    width: 1280, height: 960, channels: 3,
    noise: { type: "gaussian", mean: 128, sigma: 40 },
  },
}).jpeg({ quality: 80 }).toBuffer();

const names = rows.slice(0, HOW_MANY).map((r) => r.image);
console.log(`Generando ${names.length} fotografías de ${(sample.length / 1024).toFixed(0)} KB en ${directory}`);
for (const name of names) {
  // The same two stored shapes the resolver accepts: "/foto.jpg" and
  // "images/foto.jpg".
  await fs.writeFile(path.join(directory, name.replace(/^(?:[/\\]+|images[/\\]+)+/i, "")), sample);
}

process.env.IMAGES_DIR = directory;
const { buildExport } = await import("../src/reportBuilder/export/index.ts");

const config = {
  root: "evento",
  columns: [
    { path: "poste.name", label: "Nº Poste" },
    { path: "description", label: "Descripción" },
    { path: "criticidad", label: "Criticidad" },
    { path: "state", label: "Resuelto" },
    { path: "image", label: "Foto del evento" },
    { path: "solucion.image", label: "Foto de la solución" },
  ],
  limit: 20000,
};

if (global.gc) global.gc();
const before = process.memoryUsage();
let peakHeap = before.heapUsed;
let peakRss = before.rss;
const watch = setInterval(() => {
  const now = process.memoryUsage();
  peakHeap = Math.max(peakHeap, now.heapUsed);
  peakRss = Math.max(peakRss, now.rss);
}, 20);

const started = process.hrtime.bigint();
const output = await buildExport({
  config, role: 1, format: "excel", title: "Reporte general con fotografías",
  subtitle: "Una fila por evento", photos: true,
});
const ms = Number(process.hrtime.bigint() - started) / 1e6;
clearInterval(watch);

writeFileSync(path.join(OUT, output.filename), output.buffer);

console.log(`filas          ${output.rows}`);
console.log(`fotos          ${output.photos.loaded} de ${output.photos.requested} (omitidas ${output.photos.skipped})`);
console.log(`peso           ${(output.buffer.length / 1024 / 1024).toFixed(1)} MB`);
console.log(`tiempo         ${(ms / 1000).toFixed(1)} s`);
console.log(`pico heap      ${((peakHeap - before.heapUsed) / 1024 / 1024).toFixed(0)} MB`);
console.log(`pico RSS       +${((peakRss - before.rss) / 1024 / 1024).toFixed(0)} MB (absoluto ${(peakRss / 1024 / 1024).toFixed(0)} MB)`);

await fs.rm(directory, { recursive: true, force: true });
process.exit(0);
