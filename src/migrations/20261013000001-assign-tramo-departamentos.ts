import { QueryInterface } from "sequelize";
import { DEPARTAMENTOS } from "../models/departamento.model.js";

// The department of each tramo, from the list the client sent on 13 October
// 2026. Data only: `…05` created the column and left it empty.
//
// **Only what the list says for certain.** The list names its stretches with
// the client's own spelling («RBS PLANTA MORRO», «REP TX3»), crossed by hand
// against the production copy of that day. Out, by Isaias' decision:
//   · the 30 tramos the list does not mention — many are pieces of a longer
//     stretch of the client's, but which piece belongs where is a guess;
//   · the 3 the list gives two departments (Independencia–Inquisivi,
//     Caracollo–Ayo Ayo, Villamontes–Boyuibe), pending the client's answer;
//   · every row whose city name matched only with a doubtful reading
//     («GUARAYOS», «MIRADOR LA CRUZ YACUIBA», the three «DATACENTER»,
//     «HITO BRASIL», «HITO FRONTERA»). «SAN JOSE DE CHIQUITOS» is in: no other
//     city could be meant, and a blind re-match reached the same reading;
//   · five tramos the list assigns where both ends lie in another department:
//     Pailas–Los Troncos, San Ramón–Los Troncos, San Ramón–El Puente and El
//     Puente–Yotau (Santa Cruz, listed as Beni under «SCM GUARAYOS»), and
//     Villamontes–Hito Paraguay (Tarija, listed as Santa Cruz). The list's
//     column may mean the client's operating zone rather than the department;
//     until the client says which, those are not certain either.
// Those stay empty and are set by hand on the tramo screen.
//
// **A tramo is found by its pair of cities, never by its id**: ids are handed
// out in a different order on every database (101 tramos in production, 84 in
// the local copy). And each pair also carries the two names it was matched
// with, compared after the same space clean-up `…05` applies, so on a database
// whose ids mean other cities the row simply finds nothing.
//
// **It never stops the boot.** A row that does not match is skipped, not
// fatal: this runs inside the image on every deploy, and an empty department is
// a field to fill in, while a failed migration is the whole ERP down. And it
// only writes where the department is still empty, so it never undoes one set
// by hand.

type Asignacion = readonly [
  idMin: number, nombreMin: string, idMax: number, nombreMax: string,
  departamento: (typeof DEPARTAMENTOS)[number],
];

export const ASIGNACIONES: readonly Asignacion[] = [
  [55, "Aiquile", 56, "Chaco", "Chuquisaca"],
  [27, "Camiri", 28, "Muyupampa", "Chuquisaca"],
  [56, "Chaco", 57, "El Morro", "Chuquisaca"],
  [57, "El Morro", 58, "Millares", "Chuquisaca"],
  [29, "Monteagudo", 30, "Padilla", "Chuquisaca"],
  [28, "Muyupampa", 29, "Monteagudo", "Chuquisaca"],
  [30, "Padilla", 31, "Zudañez", "Chuquisaca"],
  [31, "Zudañez", 57, "El Morro", "Chuquisaca"],
  [18, "Alpacoma", 23, "Ayo Ayo", "La Paz"],
  [18, "Alpacoma", 19, "Patacamaya", "La Paz"],
  [8, "Cajuata", 9, "Irupana", "La Paz"],
  [10, "Chulumani", 11, "Coripata", "La Paz"],
  [11, "Coripata", 12, "Coroico", "La Paz"],
  [12, "Coroico", 18, "Alpacoma", "La Paz"],
  [20, "Curahuara de Carangas", 21, "Tambo Quemado", "La Paz"],
  [16, "Desaguadero", 18, "Alpacoma", "La Paz"],
  [7, "Inquisivi", 8, "Cajuata", "La Paz"],
  [9, "Irupana", 10, "Chulumani", "La Paz"],
  [19, "Patacamaya", 20, "Curahuara de Carangas", "La Paz"],
  [52, "Arani", 54, "Mizque", "Cochabamba"],
  [52, "Arani", 53, "Temporal", "Cochabamba"],
  [67, "Locotal", 68, "Villa Tunari", "Cochabamba"],
  [54, "Mizque", 55, "Aiquile", "Cochabamba"],
  [5, "Morochata", 6, "Independencia", "Cochabamba"],
  [5, "Morochata", 53, "Temporal", "Cochabamba"],
  [53, "Temporal", 66, "Confital", "Cochabamba"],
  [53, "Temporal", 67, "Locotal", "Cochabamba"],
  [68, "Villa Tunari", 69, "Ivirgarzama", "Cochabamba"],
  [17, "Caracollo", 66, "Confital", "Oruro"],
  [61, "Challapata", 62, "Poopo", "Oruro"],
  [63, "Oruro Sud", 119, "Panduro", "Oruro"],
  [62, "Poopo", 63, "Oruro Sud", "Oruro"],
  [58, "Millares", 59, "Olivos", "Potosí"],
  [59, "Olivos", 60, "Ventillas", "Potosí"],
  [60, "Ventillas", 61, "Challapata", "Potosí"],
  [34, "Villanueva", 35, "Camargo", "Potosí"],
  [34, "Villanueva", 59, "Olivos", "Potosí"],
  [35, "Camargo", 36, "Iscayachi", "Tarija"],
  [38, "Entre Rios", 39, "Palos Blancos", "Tarija"],
  [36, "Iscayachi", 37, "Lourdes", "Tarija"],
  [37, "Lourdes", 38, "Entre Rios", "Tarija"],
  [44, "Boyuibe", 45, "Hito Villazon", "Santa Cruz"],
  [74, "Buena Vista", 117, "Montero", "Santa Cruz"],
  [74, "Buena Vista", 118, "Yapacani", "Santa Cruz"],
  [27, "Camiri", 44, "Boyuibe", "Santa Cruz"],
  [110, "Candelaria", 112, "Yacuses", "Santa Cruz"],
  [75, "Ichoa", 118, "Yapacani", "Santa Cruz"],
  [69, "Ivirgarzama", 75, "Ichoa", "Santa Cruz"],
  [117, "Montero", 122, "Los Troncos", "Santa Cruz"],
  [24, "Paragua", 98, "Pailas", "Santa Cruz"],
  [24, "Paragua", 25, "Rio Seco", "Santa Cruz"],
  [102, "Pozo del Tigre", 104, "El Tinto", "Santa Cruz"],
  [104, "El Tinto", 106, "San Jose", "Santa Cruz"],
  [113, "Puerto Suarez", 114, "Puerto Quijarro", "Santa Cruz"],
  [25, "Rio Seco", 26, "Gutierrez", "Santa Cruz"],
  [106, "San Jose", 107, "Robore", "Santa Cruz"],
  [107, "Robore", 110, "Candelaria", "Santa Cruz"],
  [112, "Yacuses", 113, "Puerto Suarez", "Santa Cruz"],
  [123, "Buen Jesus", 124, "Elvira", "Beni"],
  [97, "Guayaramerin", 120, "Rep TX3", "Beni"],
  [95, "La Pascana", 125, "San Ramon B", "Beni"],
  [96, "Puerto Siles", 125, "San Ramon B", "Beni"],
  [92, "San Pablo", 123, "Buen Jesus", "Beni"],
  [94, "Trinidad", 124, "Elvira", "Beni"],
  [94, "Trinidad", 95, "La Pascana", "Beni"],
];

const limpio = (columna: string) => `btrim(regexp_replace(${columna}, '\\s+', ' ', 'g'))`;

function valores(queryInterface: QueryInterface) {
  const e = (v: string) => queryInterface.sequelize.escape(v);
  return ASIGNACIONES
    .map(([min, nMin, max, nMax, dep]) => `(${min}, ${e(nMin)}, ${max}, ${e(nMax)}, ${e(dep)})`)
    .join(",\n         ");
}

export async function up({ context: queryInterface }: { context: QueryInterface }) {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.sequelize.query("SET LOCAL lock_timeout = '5s'", { transaction });
    await queryInterface.sequelize.query(
      `UPDATE tramos t SET id_departamento = d.id, "updatedAt" = now()
         FROM (VALUES
         ${valores(queryInterface)}
         ) AS v(id_min, nombre_min, id_max, nombre_max, departamento)
         JOIN departamentos d ON d.name = v.departamento
         JOIN ciudads a ON a.id = v.id_min AND ${limpio("a.name")} = v.nombre_min
         JOIN ciudads b ON b.id = v.id_max AND ${limpio("b.name")} = v.nombre_max
        WHERE t.id_ciudad_min = v.id_min
          AND t.id_ciudad_max = v.id_max
          AND t.id_departamento IS NULL`,
      { transaction },
    );
  });
}

/**
 * Empties the department of the listed tramos that still hold the one this
 * wrote. One set by hand to that same department afterwards is emptied too:
 * nothing records which of the two wrote it.
 */
export async function down({ context: queryInterface }: { context: QueryInterface }) {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.sequelize.query("SET LOCAL lock_timeout = '5s'", { transaction });
    await queryInterface.sequelize.query(
      `UPDATE tramos t SET id_departamento = NULL, "updatedAt" = now()
         FROM (VALUES
         ${valores(queryInterface)}
         ) AS v(id_min, nombre_min, id_max, nombre_max, departamento)
         JOIN departamentos d ON d.name = v.departamento
        WHERE t.id_ciudad_min = v.id_min
          AND t.id_ciudad_max = v.id_max
          AND t.id_departamento = d.id`,
      { transaction },
    );
  });
}
