// What each role actually sees in the report builder.
//
// Field visibility in the generator is two things multiplied together: the
// catalog says a field is `staffOnly` — somebody else's personal data — and the
// permission matrix says whether this role holds `seguridad.ver`. Both halves
// live in different places and both are editable, the matrix from the Seguridad
// screen. So "can the Cliente role see phone numbers" is not a question you can
// answer by reading either file.
//
// That gap is not hypothetical: role 2 was refused by `GET /usuario` while the
// generator handed it names, usernames, phone numbers and role names, because
// the catalog carried its own list of role numbers. See reportBuilder/viewer.ts.
// This prints the real answer for every real role, so the next time the matrix
// moves it takes ten seconds to check rather than an afternoon.
//
//   npm run show:catalog              # one line per role
//   npm run show:catalog -- 3         # every field role 3 can reach
//   npm run show:catalog -- 3 usuario # only paths matching "usuario"
import dotenv from "dotenv";

dotenv.config();

const { sequelize } = await import("../src/database/sequelize.ts");
const { buildCatalogView } = await import("../src/reportBuilder/catalogView.ts");
const { can } = await import("../src/permissions/store.ts");
const { RolModel } = await import("../src/models/rol.model.ts");

const wantedRole = process.argv[2] ? Number(process.argv[2]) : null;
const filter = process.argv[3] ? new RegExp(process.argv[3], "i") : null;

await sequelize.authenticate();

try {
const roles = await RolModel.findAll({ attributes: ["id", "name"], order: [["id", "ASC"]] });

console.log(`\nBase: ${process.env.PG_DATABASE}\n`);

for (const row of roles) {
  const role = Number(row.dataValues.id);
  if (wantedRole !== null && role !== wantedRole) continue;

  // Exactly how the controller builds it: `staff` is `seguridad.ver`, the same
  // permission that guards the screen where personal data is administered.
  const staff = await can(role, "seguridad", "ver");
  const view = buildCatalogView({ role, staff });
  const total = view.roots.reduce((sum, r) => sum + r.fields.length, 0);

  console.log(
    `── rol ${role} · ${row.dataValues.name}` +
    `  ${staff ? "[ve datos de personal]" : "[no ve datos de personal]"}`,
  );
  console.log(`   ${view.roots.length} niveles de detalle, ${total} campos en total`);
  console.log(
    "   " + view.roots.map((r) => `${r.label}=${r.fields.length}`).join("  "),
  );

  if (wantedRole === null) {
    console.log("");
    continue;
  }

  // Asked about one role: print the fields, so the answer can be read rather
  // than trusted.
  for (const root of view.roots) {
    const fields = root.fields.filter(
      (f) => !filter || filter.test(f.path) || filter.test(f.label) || filter.test(f.group),
    );
    if (fields.length === 0) continue;
    console.log(`\n   ${root.label} — ${root.rowMeaning} (${fields.length}/${root.fields.length})`);
    for (const f of fields) {
      console.log(`     ${f.group} › ${f.label}   [${f.path}]`);
    }
    if (root.aggregateOnly.length > 0 && !filter) {
      console.log(`     (+${root.aggregateOnly.length} relaciones sólo agregables)`);
    }
  }
  console.log("");
}

if (wantedRole !== null && !roles.some((r) => Number(r.dataValues.id) === wantedRole)) {
  console.error(`No existe el rol ${wantedRole}.`);
}
} finally {
  // A failing query must not leave the pool open and the process hanging on an
  // unhandled rejection.
  await sequelize.close();
}
