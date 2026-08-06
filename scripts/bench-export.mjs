// Measures what an export costs against the local database.
//
// The caps in reportBuilder/export live or die by these numbers, and the numbers
// move as the data grows. Re-run this rather than trusting the ones written in
// the spec.
//
//   npm run bench:export -- <directorio-de-salida>
//
// Files are written where you point it, to be opened and judged by eye.
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const OUT = process.argv[2];
if (!OUT) {
  console.error("Uso: npm run bench:export -- <directorio-de-salida>");
  process.exit(1);
}
mkdirSync(OUT, { recursive: true });

const { buildExport } = await import("../src/reportBuilder/export/index.ts");

const ADMIN = 1;
const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1);

async function run(label, request) {
  if (global.gc) global.gc();
  // RSS as well as heap: sharp allocates outside the JavaScript heap, and what
  // has to fit on the server is the resident set.
  const before = process.memoryUsage();
  let peakRss = before.rss;
  const watch = setInterval(() => {
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
  }, 20);

  const started = process.hrtime.bigint();
  const output = await buildExport(request);
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  clearInterval(watch);

  writeFileSync(join(OUT, output.filename), output.buffer);
  console.log(
    `${label.padEnd(30)} ${String(output.rows).padStart(6)} filas  ` +
    `${(output.buffer.length / 1024).toFixed(0).padStart(7)} KB  ` +
    `${(ms / 1000).toFixed(1).padStart(6)} s  ` +
    `RSS +${mb(peakRss - before.rss).padStart(6)} MB` +
    (output.photos ? `  fotos ${output.photos.loaded}/${output.photos.requested}` : ""),
  );
}

const general = {
  root: "evento",
  columns: [
    { path: "poste.name", label: "Nº Poste" },
    { path: "poste.propietario.name", label: "Propietario" },
    { path: "poste.tramo", label: "Tramo" },
    { path: "description", label: "Descripción" },
    { path: "criticidad", label: "Criticidad" },
    { path: "state", label: "Resuelto" },
    { path: "date", label: "Fecha" },
    { path: "numRevisiones", label: "Revisiones" },
    { path: "diasAbierto", label: "Días abierto" },
    { path: "image", label: "Foto del evento" },
    { path: "solucion.image", label: "Foto de la solución" },
  ],
  sort: [{ path: "date", dir: "desc" }],
  limit: 20000,
};

const porTramo = {
  root: "evento",
  columns: [
    { path: "poste.tramo", label: "Tramo" },
    { path: "id", agg: "count", label: "Eventos" },
    { path: "numRevisiones", agg: "sum", label: "Revisiones" },
    { path: "diasAbierto", agg: "avg", label: "Días abierto (prom.)" },
  ],
  groupBy: ["poste.tramo"],
  sort: [{ path: "id", agg: "count", dir: "desc" }],
  limit: 500,
};

console.log("reporte                          filas      peso   tiempo    memoria");
console.log("─".repeat(84));

await run("General · Excel", {
  config: general, role: ADMIN, format: "excel", title: "Reporte general de eventos",
  subtitle: "Una fila por evento",
});
await run("General · Excel con fotos", {
  config: general, role: ADMIN, format: "excel", title: "Reporte general con fotos",
  subtitle: "Una fila por evento", photos: true,
});
await run("General · PDF", {
  config: general, role: ADMIN, format: "pdf", title: "Reporte general de eventos",
  subtitle: "Una fila por evento",
});
await run("Por tramo · Excel", {
  config: porTramo, role: ADMIN, format: "excel", title: "Eventos por tramo",
  subtitle: "Una fila por tramo",
});
await run("Por tramo · PDF", {
  config: porTramo, role: ADMIN, format: "pdf", title: "Eventos por tramo",
  subtitle: "Una fila por tramo",
});

console.log(`\nArchivos en ${OUT}`);
process.exit(0);
