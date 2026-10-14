# El tramo como entidad propia — plan de implementación, parte 1: API

> **Para quien lo ejecute:** SUB-SKILL OBLIGATORIA: superpowers:subagent-driven-development
> (recomendada) o superpowers:executing-plans, tarea a tarea. Los pasos llevan casilla
> (`- [ ]`) para ir marcándolos.

**Objetivo:** que la API guarde el tramo como registro propio, sin sentido de marcha y con
departamento, y deje de leer `id_ciudadA` / `id_ciudadB` en ningún sitio.

**Arquitectura:** dos tablas nuevas (`departamentos`, `tramos`) y `postes.id_tramo`. Todo
lo que sabe cómo se llama y cómo se serializa un tramo vive en `src/tramos/`: el nombre
(en TypeScript y su gemelo en SQL), el `include` único y el presentador que convierte la
fila en lo que viaja. Los controladores existentes dejan de componer el tramo y pasan a
pedirlo. El trabajo es aditivo hasta la última tarea: el modelo conserva las dos columnas
viejas mientras se migran los consumidores uno a uno, y solo al final se retiran, de modo
que `npm run typecheck` es quien demuestra que no queda ninguno.

**Stack:** Express 5, Sequelize 6, PostgreSQL, TypeScript (typescript7 para comprobar),
Vitest, umzug.

**Especificación:** `api/docs/specs/2026-10-10-tramo-como-entidad-design.md`. Este plan
argumenta desde ella; quien ejecute lee los dos.

**Parte 2 (web):** se escribe cuando esta esté construida, sobre las respuestas reales.

## Restricciones globales

- **Sin commits por tarea.** Un único commit al terminar el arco (API y web), en la rama
  `isaias`, en inglés, añadiendo ficheros por nombre. Los pasos «commit» de la plantilla
  no existen en este plan.
- **Varias sesiones comparten este árbol.** Antes de editar un fichero, `git status` y
  `git diff -- <fichero>`: si lleva cambios ajenos sin commitear, no se toca y se avisa.
  `src/reportBuilder/regression.test.ts` estaba en ese caso.
- **Se construye en el árbol compartido** (decidido por Isaias el 10 de octubre: no hay
  otra sesión trabajando). `osefi_local` se migra al final de la tarea 3, con
  `npm run migrate`, una vez que la migración ha pasado contra `probe_tramos`. Desde la
  tarea 2 hasta ese momento el servidor local no arranca contra ella, y la web actual no
  funciona contra esta API hasta que esté hecha su parte.
- **Antes de migrar nada se guarda un volcado de `osefi_local`** en el scratchpad
  (`osefi_local-antes.dump`). No es una precaución añadida: es de donde se recrea
  `probe_tramos` cada vez que una prueba necesita la copia sin migrar (tareas 3, 10 y 12),
  y una vez migrada la local ya no hay de dónde sacarla.
- Comprobación de tipos: `npm run typecheck`, nunca `npx tsc`.
- Código, comentarios e identificadores en inglés o en el español que ya usa el fichero;
  mensajes al usuario en español.
- El nombre de un tramo: extremos en orden por código de carácter (id si empatan),
  unidos por ` – ` (guion largo U+2013 entre espacios). Extremo sin nombre: `#id`.
- Columnas: `tramos.id_ciudad_min`, `tramos.id_ciudad_max`, `tramos.id_departamento`,
  `tramos.id_usuario`, `postes.id_tramo`. `min`/`max` no salen del modelo.
- Fusión de ciudades, `pierde → gana`: 77→58 (Millares), 78→59 (Olivos), 76→57 (El Morro),
  79→60 (Ventillas), 86→98 (Pailas).
- Departamentos, en este orden: Chuquisaca, La Paz, Cochabamba, Oruro, Potosí, Tarija,
  Santa Cruz, Beni, Pando.
- Permisos del módulo `tramos`: `ver`, `crear`, `editar`, `archivar`.
- Al ver fallar una prueba, comprobar que falla **por el motivo que el paso dice**.

## Foco de revisión

Lo que la especificación implica y es más fácil que falle en uso real. Cada línea tiene
su prueba en la tarea que posee el código.

1. **Dos personas crean el mismo tramo a la vez.** La segunda debe recibir 409 con el
   tramo existente, no un 409 genérico ni un 500. → Tarea 6.
2. **Un poste archivado cuyo tramo está archivado aparece dentro de un evento.** Debe
   viajar con su tramo y su nombre, nunca `tramo: null`. → Tarea 5 y 8.
3. **Crear «Sucre – Potosí» enviando las ciudades al revés.** Debe dar con el mismo tramo
   que «Potosí – Sucre», no un error de la base. → Tarea 6.
4. **La base de producción trae algo que la local no:** un poste con la misma ciudad en
   los dos extremos, o un informe guardado que usa «Ciudad A». La migración debe parar
   antes de cambiar nada y decir qué filas. → Tarea 3.
5. **Un cliente con la versión anterior envía `TramoInicial` y `TramoFinal`.** Debe
   recibir un 400 que lo diga, no un reporte de toda la red. → Tarea 10.

---

## Mapa de ficheros

| Fichero | Qué es |
|---|---|
| `src/tramos/nombre.ts` (nuevo) | Orden y nombre de un tramo, en TS y en SQL |
| `src/tramos/presentacion.ts` (nuevo) | El `include` único y lo que viaja de un tramo |
| `src/models/departamento.model.ts` (nuevo) | Modelo de solo lectura |
| `src/models/tramo.model.ts` (nuevo) | Modelo, columnas públicas, asociaciones |
| `src/models/poste.model.ts` | Gana `id_tramo`; pierde las dos ciudades en la tarea 12 |
| `src/migrations/20261010000005-create-tramos.ts` (nuevo) | Esquema, fusión y datos |
| `src/migrations/20261010000006-add-tramos-permisos.ts` (nuevo) | Celdas de permiso |
| `src/controllers/tramo.controller.ts`, `src/routes/tramo.routes.ts` (nuevos) | El recurso |
| `src/controllers/{poste,evento,dashboard,ciudad,opciones,reporte}.controller.ts`, `reporteFiltro.ts` | Dejan de componer el tramo |
| `src/reportBuilder/catalog.ts` | «Tramo» y «Departamento del tramo» por subconsulta |
| `src/utils/tramo.ts` | Se elimina en la tarea 12 |

---

### Tarea 1: el nombre de un tramo

**Ficheros:**
- Crear: `src/tramos/nombre.ts`
- Prueba: `src/tramos/nombre.test.ts`

**Interfaces:**
- Produce: `SEPARADOR`, `interface Extremo { id: number; name?: string | null }`,
  `ordenarExtremos<T extends Extremo>(a: T, b: T): [T, T]`,
  `nombreDeTramo(a: Extremo, b: Extremo): string`,
  `sqlNombreDeTramo(t: string, min: string, max: string): string`,
  `sqlNombreDelTramo(idTramo: string): string`,
  `sqlNombreDelTramoDelPoste(idPoste: string): string`.

- [ ] **Paso 1: escribir la prueba**

```ts
import { describe, it, expect } from "vitest";
import {
  nombreDeTramo, ordenarExtremos, sqlNombreDeTramo, sqlNombreDelTramo, sqlNombreDelTramoDelPoste,
} from "./nombre.js";

describe("nombreDeTramo", () => {
  it("is the same name whichever end is handed over first", () => {
    const sucre = { id: 7, name: "Sucre" };
    const potosi = { id: 3, name: "Potosí" };
    expect(nombreDeTramo(sucre, potosi)).toBe("Potosí – Sucre");
    expect(nombreDeTramo(potosi, sucre)).toBe("Potosí – Sucre");
  });

  it("orders by the name and not by the id", () => {
    expect(nombreDeTramo({ id: 1, name: "Tarija" }, { id: 9, name: "Beni" })).toBe("Beni – Tarija");
  });

  it("falls back to the id when two ends carry the same name", () => {
    const [primero, segundo] = ordenarExtremos({ id: 77, name: "Millares" }, { id: 58, name: "Millares" });
    expect([primero.id, segundo.id]).toEqual([58, 77]);
  });

  it("ignores the spaces around a name, for the order and for the text", () => {
    expect(nombreDeTramo({ id: 1, name: " Villanueva " }, { id: 2, name: "Olivos" })).toBe("Olivos – Villanueva");
  });

  it("writes #id for an end that has no name, and never an empty side", () => {
    expect(nombreDeTramo({ id: 4, name: null }, { id: 2, name: "Oruro" })).toBe("#4 – Oruro");
    expect(nombreDeTramo({ id: 4, name: "  " }, { id: 2 })).toBe("#2 – #4");
  });

  it("compares by code unit, so the SQL twin can agree with it exactly", () => {
    // "Ñ" (U+00D1) sorts after "Z" (U+005A) here and under COLLATE "C" alike.
    expect(nombreDeTramo({ id: 1, name: "Ñuflo" }, { id: 2, name: "Zudáñez" })).toBe("Zudáñez – Ñuflo");
  });
});

describe("the SQL twin", () => {
  it("compares under COLLATE \"C\" and breaks ties by id", () => {
    const sql = sqlNombreDeTramo("t", "a", "b");
    expect(sql).toContain('COLLATE "C"');
    expect(sql).toContain('t."id_ciudad_min"');
    expect(sql).toContain("' – '");
    expect(sql).toContain("'#' ||");
  });

  it("reaches the name from a tramo id, and from a pole id, without naming any outer alias", () => {
    expect(sqlNombreDelTramo('"poste"."id_tramo"')).toMatch(/^\(SELECT .* WHERE t\."id" = "poste"\."id_tramo"\)$/);
    expect(sqlNombreDelTramoDelPoste('"evento"."id_poste"')).toContain('WHERE p."id" = "evento"."id_poste"');
  });
});
```

- [ ] **Paso 2: verla fallar**

Ejecutar: `npx vitest run src/tramos/nombre.test.ts`
Esperado: FALLA al resolver `./nombre.js` (el módulo no existe).

- [ ] **Paso 3: implementar**

```ts
// What a tramo is called, and in which order its two ends are read.
//
// A tramo has no direction: Sucre and Potosí are each the start or the end
// depending on where you set off from. So nothing in the data can decide which
// city comes first in the name, and a name that changed with the order of two
// columns is how the same stretch came to be written five ways on five
// screens. The order is decided here, once, by the names themselves.
//
// **It exists twice, on purpose, and the two must agree.** Controllers hold
// rows and call `nombreDeTramo`; the report generator and every `ORDER BY`
// hold SQL and call `sqlNombreDeTramo`. They agree because both compare the
// trimmed names by code point — `<` on JavaScript strings, `COLLATE "C"` in
// Postgres — and nothing locale-dependent is involved on either side. The
// price is visible and accepted: an accented capital sorts after Z.
// `tramos.db.test.ts` compares the two over every row of a real database.

export const SEPARADOR = " – ";

export interface Extremo {
  id: number;
  name?: string | null;
}

const etiqueta = (e: Extremo): string => {
  const nombre = typeof e.name === "string" ? e.name.trim() : "";
  return nombre !== "" ? nombre : `#${e.id}`;
};

/** The two ends in the order the name reads them. Ties go to the lower id. */
export const ordenarExtremos = <T extends Extremo>(a: T, b: T): [T, T] => {
  const na = etiqueta(a);
  const nb = etiqueta(b);
  if (na !== nb) return na < nb ? [a, b] : [b, a];
  return a.id <= b.id ? [a, b] : [b, a];
};

export const nombreDeTramo = (a: Extremo, b: Extremo): string =>
  ordenarExtremos(a, b).map(etiqueta).join(SEPARADOR);

/**
 * The same name as an SQL expression.
 *
 * @param t   alias of a `tramos` row
 * @param min alias of the `ciudads` row joined on `id_ciudad_min`
 * @param max alias of the `ciudads` row joined on `id_ciudad_max`
 *
 * The joins are the caller's and must be LEFT and unfiltered: an archived city
 * still names its tramo, exactly as the includes do with `paranoid: false`.
 */
export const sqlNombreDeTramo = (t: string, min: string, max: string): string => {
  const a = `COALESCE(NULLIF(btrim(${min}."name"), ''), '#' || ${t}."id_ciudad_min")`;
  const b = `COALESCE(NULLIF(btrim(${max}."name"), ''), '#' || ${t}."id_ciudad_max")`;
  return (
    `CASE WHEN (${a} COLLATE "C", ${t}."id_ciudad_min") <= (${b} COLLATE "C", ${t}."id_ciudad_max")` +
    ` THEN ${a} || '${SEPARADOR}' || ${b} ELSE ${b} || '${SEPARADOR}' || ${a} END`
  );
};

const DESDE_TRAMOS =
  `FROM "tramos" t` +
  ` LEFT JOIN "ciudads" cmin ON cmin."id" = t."id_ciudad_min"` +
  ` LEFT JOIN "ciudads" cmax ON cmax."id" = t."id_ciudad_max"`;

/** The name of the tramo whose id is the given SQL expression. */
export const sqlNombreDelTramo = (idTramo: string): string =>
  `(SELECT ${sqlNombreDeTramo("t", "cmin", "cmax")} ${DESDE_TRAMOS} WHERE t."id" = ${idTramo})`;

/**
 * The name of the tramo of the pole whose id is the given SQL expression.
 *
 * For an `ORDER BY` on a query whose pole is a joined include: Sequelize may
 * wrap the main table in a subquery to paginate, and an order that names the
 * include's alias then points at nothing. This one names only the root column.
 */
export const sqlNombreDelTramoDelPoste = (idPoste: string): string =>
  `(SELECT ${sqlNombreDeTramo("t", "cmin", "cmax")} ${DESDE_TRAMOS}` +
  ` INNER JOIN "postes" p ON p."id_tramo" = t."id" WHERE p."id" = ${idPoste})`;
```

- [ ] **Paso 4: verla pasar**

Ejecutar: `npx vitest run src/tramos/nombre.test.ts`
Esperado: 8 pruebas en verde.

---

### Tarea 2: modelos (aditivo)

**Ficheros:**
- Crear: `src/models/departamento.model.ts`, `src/models/tramo.model.ts`
- Modificar: `src/models/poste.model.ts`, `src/interfaces/index.ts`
- Prueba: `src/models/tramo.model.test.ts`

**Interfaces:**
- Produce: `DepartamentoModel`, `DEPARTAMENTOS` (los nueve nombres, en orden),
  `TramoModel`, `TRAMO_PUBLIC_ATTRIBUTES`, interfaces `ITramo`, `IDepartamento`,
  `IPoste.id_tramo`. Asociaciones: `TramoModel.belongsTo(CiudadModel, { as: "ciudadMin" })`,
  `{ as: "ciudadMax" }`, `TramoModel.belongsTo(DepartamentoModel)` (clave `departamento`),
  `PosteModel.belongsTo(TramoModel)` (clave `tramo`).
- En esta tarea `PosteModel` **conserva** `id_ciudadA` / `id_ciudadB` y sus asociaciones.

- [ ] **Paso 1: escribir la prueba**

```ts
import { describe, it, expect } from "vitest";
import { TramoModel, TRAMO_PUBLIC_ATTRIBUTES } from "./tramo.model.js";
import { DepartamentoModel, DEPARTAMENTOS } from "./departamento.model.js";
import { PosteModel, POSTE_PUBLIC_ATTRIBUTES } from "./poste.model.js";

describe("TramoModel", () => {
  it("lives in `tramos`, archives softly, and names its ends min and max", () => {
    expect(TramoModel.getTableName()).toBe("tramos");
    expect(TramoModel.options.paranoid).toBe(true);
    const columnas = Object.keys(TramoModel.getAttributes());
    expect(columnas).toEqual(expect.arrayContaining(["id_ciudad_min", "id_ciudad_max", "id_departamento", "id_usuario"]));
  });

  it("refuses the two ends the wrong way round before the database has to", async () => {
    const volcado = TramoModel.build({ id_ciudad_min: 7, id_ciudad_max: 3 });
    await expect(volcado.validate()).rejects.toThrow(/id_ciudad_min/);
    const misma = TramoModel.build({ id_ciudad_min: 3, id_ciudad_max: 3 });
    await expect(misma.validate()).rejects.toThrow(/id_ciudad_min/);
    await expect(TramoModel.build({ id_ciudad_min: 3, id_ciudad_max: 7 }).validate()).resolves.toBeDefined();
  });

  it("does not need a department", () => {
    expect(TramoModel.getAttributes().id_departamento.allowNull).not.toBe(false);
  });

  it("keeps its author out of what travels inside another response", () => {
    expect(TRAMO_PUBLIC_ATTRIBUTES).not.toContain("id_usuario");
    expect(TRAMO_PUBLIC_ATTRIBUTES).toContain("deletedAt");
  });

  it("is reachable from a pole as `tramo`, and reaches its ends and its department", () => {
    expect(Object.keys(PosteModel.associations)).toContain("tramo");
    expect(Object.keys(TramoModel.associations)).toEqual(
      expect.arrayContaining(["ciudadMin", "ciudadMax", "departamento"]),
    );
  });
});

describe("DepartamentoModel", () => {
  it("is the nine of Bolivia, with no timestamps to maintain", () => {
    expect(DepartamentoModel.getTableName()).toBe("departamentos");
    expect(DepartamentoModel.options.timestamps).toBe(false);
    expect(DEPARTAMENTOS).toEqual([
      "Chuquisaca", "La Paz", "Cochabamba", "Oruro", "Potosí", "Tarija", "Santa Cruz", "Beni", "Pando",
    ]);
  });
});

describe("a pole inside somebody else's response", () => {
  it("carries the id of its tramo", () => {
    expect(POSTE_PUBLIC_ATTRIBUTES).toContain("id_tramo");
  });
});
```

- [ ] **Paso 2: verla fallar** — `npx vitest run src/models/tramo.model.test.ts`. Esperado:
  FALLA al resolver `./tramo.model.js`.

- [ ] **Paso 3: `src/interfaces/index.ts`** — añadir tras `IPropietario`, y `id_tramo` a
  `IPoste` (las dos ciudades se quedan hasta la tarea 12):

```ts
export interface IDepartamento {
  id: number;
  name: string;
}

export interface ITramo {
  id: number;
  id_ciudad_min: number;
  id_ciudad_max: number;
  id_departamento?: number | null;
  id_usuario?: number | null;
  deletedAt?: Date | null;
}
```

```ts
  id_ciudadB: number;
  id_tramo: number;
```

- [ ] **Paso 4: `src/models/departamento.model.ts`**

```ts
import { DataTypes, ModelDefined } from "sequelize";
import { sequelize } from "../database/sequelize.js";
import { IDepartamento } from "../interfaces/index.js";

/**
 * The nine departments of Bolivia, in the order the migration seeds them.
 *
 * A table and not a constant because the report generator and the exporters
 * work in SQL, where a name has to be something a query can join to. It has no
 * screen and no write route: the list does not change, and the day it does is
 * a line in a migration.
 */
export const DEPARTAMENTOS = [
  "Chuquisaca", "La Paz", "Cochabamba", "Oruro", "Potosí", "Tarija", "Santa Cruz", "Beni", "Pando",
] as const;

export const DepartamentoModel: ModelDefined<IDepartamento, IDepartamento> = sequelize.define("departamento", {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  name: { type: DataTypes.STRING(40), allowNull: false, unique: true },
}, { tableName: "departamentos", timestamps: false });
```

- [ ] **Paso 5: `src/models/tramo.model.ts`**

```ts
import { DataTypes, ModelDefined, Optional } from "sequelize";
import { sequelize } from "../database/sequelize.js";
import { CiudadModel } from "./ciudad.model.js";
import { DepartamentoModel } from "./departamento.model.js";
import { UsuarioModel } from "./usuario.model.js";
import { ITramo } from "../interfaces/index.js";

type TramoCreation = Optional<ITramo, "id">;

/**
 * A stretch of line between two cities, with no direction.
 *
 * `id_ciudad_min` and `id_ciudad_max` are not a start and an end. They are the
 * two ends, told apart by the only thing that can tell them apart without
 * inventing an order: which id is lower. That rule is what makes a pair exist
 * once — (3,7) and (7,3) are the same row — and the database holds it with a
 * CHECK and a unique index (`20261010000005-create-tramos.ts`). The validator
 * below is the same rule one step earlier, so a controller that forgets to
 * normalise gets a sentence instead of SQLSTATE 23514, which `handler.ts` does
 * not translate.
 *
 * The two names never leave this layer: what travels is `ciudades`, built by
 * `tramos/presentacion.ts`.
 */
export const TramoModel: ModelDefined<ITramo, TramoCreation> = sequelize.define("tramo", {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  id_ciudad_min: { type: DataTypes.INTEGER, allowNull: false },
  id_ciudad_max: { type: DataTypes.INTEGER, allowNull: false },
  id_departamento: { type: DataTypes.INTEGER, allowNull: true },
  id_usuario: { type: DataTypes.INTEGER, allowNull: true },
}, {
  tableName: "tramos",
  paranoid: true,
  validate: {
    extremosEnOrden(this: { id_ciudad_min: number; id_ciudad_max: number }) {
      if (!(Number(this.id_ciudad_min) < Number(this.id_ciudad_max))) {
        throw new Error("id_ciudad_min must be lower than id_ciudad_max");
      }
    },
  },
});

/**
 * The columns of a tramo that may travel inside somebody else's response.
 *
 * `id_usuario` is the one left out, for the reason `POSTE_PUBLIC_ATTRIBUTES`
 * gives: a bare include ships the whole row, and the author of a record is
 * shown behind `seguridad.ver` and nowhere else. `deletedAt` is in because the
 * presenter turns it into `archivado`.
 */
export const TRAMO_PUBLIC_ATTRIBUTES = [
  "id", "id_ciudad_min", "id_ciudad_max", "id_departamento", "deletedAt",
] as const;

CiudadModel.hasMany(TramoModel, { foreignKey: "id_ciudad_min", as: "tramosMin" });
TramoModel.belongsTo(CiudadModel, { foreignKey: "id_ciudad_min", as: "ciudadMin" });

CiudadModel.hasMany(TramoModel, { foreignKey: "id_ciudad_max", as: "tramosMax" });
TramoModel.belongsTo(CiudadModel, { foreignKey: "id_ciudad_max", as: "ciudadMax" });

DepartamentoModel.hasMany(TramoModel, { foreignKey: "id_departamento" });
TramoModel.belongsTo(DepartamentoModel, { foreignKey: "id_departamento" });

UsuarioModel.hasMany(TramoModel, { foreignKey: "id_usuario" });
TramoModel.belongsTo(UsuarioModel, { foreignKey: "id_usuario" });
```

- [ ] **Paso 6: `src/models/poste.model.ts`** — tres cambios, las ciudades siguen:

```ts
import { TramoModel } from "./tramo.model.js";
```

```ts
  id_ciudadB: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  id_tramo: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
```

`POSTE_PUBLIC_ATTRIBUTES` pasa a llevar además `"id_tramo"` al final, y tras las
asociaciones de ciudad:

```ts
TramoModel.hasMany(PosteModel, { foreignKey: "id_tramo" });
PosteModel.belongsTo(TramoModel, { foreignKey: "id_tramo" });
```

- [ ] **Paso 7: verla pasar** — `npx vitest run src/models/tramo.model.test.ts` en verde, y
  `npm run typecheck` limpio. Si `typecheck` protesta porque algún `PosteModel.create` de
  una prueba no pasa `id_tramo`, añadirlo ahí (`id_tramo: 1`); no relajar el tipo.

---

### Tarea 3: migración de esquema y datos

**Ficheros:**
- Crear: `src/migrations/20261010000005-create-tramos.ts`
- Pruebas: `src/migrations/20261010000005-create-tramos.test.ts` (doble, corre siempre) y
  `src/tramos/tramos.db.test.ts` (base real, solo contra `probe_tramos`)

**Interfaces:**
- Consume: `DEPARTAMENTOS`, `TramoModel`, `sqlNombreDeTramo`, `nombreDeTramo`.
- Produce: `up`, `down`, `FUSIONES`, `RESTRICCIONES`.

- [ ] **Paso 1: levantar la base desechable.** No se usa `osefi_local`.

```bash
docker run -d --name osefi-tramos -e POSTGRES_PASSWORD=probe -e POSTGRES_DB=probe_tramos \
  -p 127.0.0.1:55434:5432 postgres:17
# Copia de la base local. Usuario y contraseña, los de api/.env (PG_USER, PG_PASS).
docker exec -e PGPASSWORD="$PG_PASS" osefi-tramos sh -c \
  'pg_dump -h host.docker.internal -p 5434 -U "$0" --no-owner --no-acl osefi_local | psql -q -U postgres probe_tramos' "$PG_USER"
```

Comprobar: `docker exec osefi-tramos psql -U postgres probe_tramos -c 'select count(*) from postes'`
devuelve 1687. Si `pg_dump` se queja de la versión del servidor, usar la imagen de esa
versión (`select version()` sobre la local).

- [ ] **Paso 2: la prueba con doble**

```ts
// What a reader cannot see by reading the migration once: that it looks before
// it changes anything, that nothing is dropped before every pole has been
// checked against its tramo, and that every statement rides one transaction.
// That Postgres accepts the SQL and that the constraints really refuse is
// `tramos/tramos.db.test.ts`, against a real database.

import { describe, it, expect } from "vitest";
import { up, down, FUSIONES, RESTRICCIONES } from "./20261010000005-create-tramos.js";
import { TramoModel } from "../models/tramo.model.js";
import { DEPARTAMENTOS } from "../models/departamento.model.js";

type Respuesta = (sql: string) => unknown;

const CIUDADES_DE_LA_FUSION = FUSIONES.flatMap((f) => [
  { id: f.pierde, name: f.nombre },
  { id: f.gana, name: f.nombre },
]);

/** A database with nothing wrong in it. */
const limpia: Respuesta = (sql) => {
  if (sql.includes("/* fusion */")) return CIUDADES_DE_LA_FUSION;
  if (sql.includes("/* comprobacion */")) return [{ n: "0" }];
  return [];
};

function fakeQueryInterface(responder: Respuesta = limpia) {
  const calls: { fn: string; args: unknown[] }[] = [];
  const record = (fn: string) => (...args: unknown[]) => {
    calls.push({ fn, args });
    return Promise.resolve();
  };
  return {
    calls,
    createTable: record("createTable"),
    dropTable: record("dropTable"),
    addColumn: record("addColumn"),
    removeColumn: record("removeColumn"),
    changeColumn: record("changeColumn"),
    bulkInsert: record("bulkInsert"),
    sequelize: {
      literal: (sql: string) => ({ literal: sql }),
      query: (...args: unknown[]) => {
        calls.push({ fn: "query", args });
        return Promise.resolve(responder(String(args[0])));
      },
      transaction: (cb: (t: unknown) => Promise<void>) => cb({ id: "t" }),
    },
  };
}

const sqlDe = (c: { args: unknown[] }) => String(c.args[0]).replace(/\s+/g, " ");
const cambia = (c: { fn: string; args: unknown[] }) =>
  c.fn !== "query" || /^(UPDATE|INSERT|ALTER|CREATE|DROP|DELETE)/i.test(sqlDe(c).trim());

describe("create-tramos: it looks before it builds", () => {
  const casos: [string, Respuesta, RegExp][] = [
    ["a city of the merge is missing",
      (sql) => (sql.includes("/* fusion */") ? CIUDADES_DE_LA_FUSION.slice(1) : limpia(sql)), /77/],
    ["a city of the merge is not called what is expected",
      (sql) => (sql.includes("/* fusion */")
        ? CIUDADES_DE_LA_FUSION.map((c) => (c.id === 98 ? { ...c, name: "Otra" } : c)) : limpia(sql)), /98/],
    ["a pole points at a city that does not exist",
      (sql) => (sql.includes("/* huerfanos */") ? [{ id: 41 }] : limpia(sql)), /41/],
    ["a pole would end with the same city at both ends",
      (sql) => (sql.includes("/* misma */") ? [{ id: 12 }] : limpia(sql)), /12/],
    ["a saved report uses Ciudad A or filters by the tramo text",
      (sql) => (sql.includes("/* informes */") ? [{ id: 10, name: "Propietarios" }] : limpia(sql)), /Propietarios/],
  ];

  for (const [titulo, responder, nombra] of casos) {
    it(`stops when ${titulo}, names the rows, and has changed nothing`, async () => {
      const qi = fakeQueryInterface(responder);
      await expect(up({ context: qi as never })).rejects.toThrow(nombra);
      await expect(up({ context: fakeQueryInterface(responder) as never })).rejects.toThrow(/No se ha cambiado nada/);
      // `SET LOCAL lock_timeout` is the only statement allowed before a refusal.
      expect(qi.calls.filter(cambia).map(sqlDe)).toEqual([]);
    });
  }
});

describe("create-tramos: the order things happen in", () => {
  it("cleans the names and merges the cities before it derives any tramo", async () => {
    const qi = fakeQueryInterface();
    await up({ context: qi as never });
    const pasos = qi.calls.map((c) => (c.fn === "query" ? sqlDe(c) : `${c.fn} ${String(c.args[0])}`));
    const en = (trozo: string) => pasos.findIndex((p) => p.includes(trozo));

    expect(en("regexp_replace")).toBeGreaterThan(-1);
    expect(en("regexp_replace")).toBeLessThan(en('SET "id_ciudadA" ='));
    expect(en('SET "id_ciudadA" =')).toBeLessThan(en("createTable tramos"));
    expect(en("createTable departamentos")).toBeLessThan(en("createTable tramos"));
    expect(en("createTable tramos")).toBeLessThan(en("INSERT INTO tramos"));
    expect(en("INSERT INTO tramos")).toBeLessThan(en('SET "id_tramo" ='));
  });

  it("checks every pole against its tramo before it drops the two columns", async () => {
    const qi = fakeQueryInterface();
    await up({ context: qi as never });
    const orden = qi.calls.map((c) => (c.fn === "query" ? sqlDe(c) : `${c.fn} ${String(c.args[1] ?? c.args[0])}`));
    const comprobacion = orden.findIndex((p) => p.includes("/* comprobacion */"));
    const primerBorrado = orden.findIndex((p) => p.startsWith("removeColumn"));
    expect(comprobacion).toBeGreaterThan(-1);
    expect(primerBorrado).toBeGreaterThan(comprobacion);
  });

  it("drops nothing when a single pole does not match", async () => {
    const qi = fakeQueryInterface((sql) => (sql.includes("/* comprobacion */") ? [{ n: "3" }] : limpia(sql)));
    await expect(up({ context: qi as never })).rejects.toThrow(/3 postes/);
    expect(qi.calls.some((c) => c.fn === "removeColumn")).toBe(false);
  });

  it("merges exactly the five pairs that were decided", () => {
    expect(FUSIONES.map((f) => [f.pierde, f.gana])).toEqual([[77, 58], [78, 59], [76, 57], [79, 60], [86, 98]]);
  });

  it("seeds the nine departments in their order", async () => {
    const qi = fakeQueryInterface();
    await up({ context: qi as never });
    const siembra = qi.calls.find((c) => c.fn === "bulkInsert" && c.args[0] === "departamentos");
    expect((siembra?.args[1] as { name: string }[]).map((d) => d.name)).toEqual([...DEPARTAMENTOS]);
  });
});

describe("create-tramos: what holds the rule", () => {
  it("has a CHECK that closes the reversed pair and the single city, and a unique index with no WHERE", async () => {
    const qi = fakeQueryInterface();
    await up({ context: qi as never });
    const sql = qi.calls.filter((c) => c.fn === "query").map(sqlDe);
    expect(sql.find((s) => s.includes(RESTRICCIONES.orden))).toContain("CHECK (id_ciudad_min < id_ciudad_max)");
    const unico = sql.find((s) => s.includes(RESTRICCIONES.parUnico));
    expect(unico).toContain("UNIQUE INDEX");
    // One row per pair for ever: an archived tramo still holds its pair.
    expect(unico).not.toMatch(/WHERE/i);
  });

  it("creates the columns the model declares", async () => {
    const qi = fakeQueryInterface();
    await up({ context: qi as never });
    const tabla = qi.calls.find((c) => c.fn === "createTable" && c.args[0] === "tramos");
    expect(Object.keys(tabla?.args[1] as object).sort()).toEqual(Object.keys(TramoModel.getAttributes()).sort());
  });
});

describe("create-tramos: the transaction", () => {
  it("opens with the lock timeout and carries every statement, both ways", async () => {
    for (const direccion of [up, down]) {
      const qi = fakeQueryInterface();
      await direccion({ context: qi as never });
      expect(sqlDe(qi.calls[0])).toContain("lock_timeout");
      for (const c of qi.calls) {
        const opciones = c.args.at(-1) as { transaction?: unknown } | undefined;
        expect(opciones?.transaction, `${c.fn} ${sqlDe(c).slice(0, 60)}`).toEqual({ id: "t" });
      }
    }
  });

  it("puts the two indexes back under their lower-case names on the way down", async () => {
    const qi = fakeQueryInterface();
    await down({ context: qi as never });
    const sql = qi.calls.filter((c) => c.fn === "query").map(sqlDe).join("\n");
    expect(sql).toContain("idx_postes_ciudada");
    expect(sql).toContain("idx_postes_ciudadb");
  });
});
```

- [ ] **Paso 3: verla fallar** — `npx vitest run src/migrations/20261010000005-create-tramos.test.ts`.
  Esperado: FALLA al resolver el módulo de la migración.

- [ ] **Paso 4: la migración**

```ts
import { DataTypes, QueryInterface, QueryTypes, Transaction } from "sequelize";
import { DEPARTAMENTOS } from "../models/departamento.model.js";

// The tramo becomes a row of its own. Design:
// docs/specs/2026-10-10-tramo-como-entidad-design.md §5.4.
//
// Until now a pole stored two cities and the tramo was whatever grouping them
// produced, so Sucre→Potosí and Potosí→Sucre were two pairs: 20 of the 91
// stretches existed twice. This derives one row per unordered pair, points
// every pole at it, and drops the two columns.
//
// **It also merges five cities that were loaded twice**, before deriving
// anything, because a duplicated city is the other way the same stretch came to
// exist more than once and no change of model fixes that. The pairs and the
// survivor of each were decided with the coordinates in front of us (§2.2).
//
// **It looks before it changes anything.** Everything it assumes about the data
// was measured on a copy, and this file cannot see production. Each assumption
// is a query at the top; if one does not hold it stops with the rows in its
// message, having written nothing.
//
// **There is no exact way back.** `down` rebuilds the two columns from the
// tramo, which gives every pole its pair in id order — not the order it had —
// and it does not un-merge the cities. The way back is the backup taken before
// the cut. The previous image must be stopped before this runs: it selects the
// two columns in every pole, incident and report query.

/** City `pierde` is a duplicate of `gana`; its poles move and it is archived. */
export const FUSIONES = [
  { pierde: 77, gana: 58, nombre: "Millares" },
  { pierde: 78, gana: 59, nombre: "Olivos" },
  { pierde: 76, gana: 57, nombre: "El Morro" },
  { pierde: 79, gana: 60, nombre: "Ventillas" },
  { pierde: 86, gana: 98, nombre: "Pailas" },
] as const;

export const RESTRICCIONES = {
  orden: "tramos_extremos_en_orden_chk",
  parUnico: "tramos_par_uniq",
} as const;

const NADA = "No se ha cambiado nada.";
const limpio = `btrim(regexp_replace(name, '\\s+', ' ', 'g'))`;

/** A city id as it will be once the merge has run. */
const fusionada = (columna: string) =>
  `(CASE ${columna} ${FUSIONES.map((f) => `WHEN ${f.pierde} THEN ${f.gana}`).join(" ")} ELSE ${columna} END)`;

async function comprobar(queryInterface: QueryInterface, transaction: Transaction) {
  const leer = <T extends object>(sql: string) =>
    queryInterface.sequelize.query<T>(sql, { type: QueryTypes.SELECT, transaction });

  const ids = FUSIONES.flatMap((f) => [f.pierde, f.gana]);
  const ciudades = await leer<{ id: number; name: string | null }>(
    `/* fusion */ SELECT id, ${limpio} AS name FROM ciudads WHERE id IN (${ids.join(", ")})`,
  );
  const porId = new Map(ciudades.map((c) => [c.id, c.name]));
  const raras = FUSIONES.flatMap((f) => [f.pierde, f.gana].filter((id) => porId.get(id) !== f.nombre).map((id) =>
    `${id} (se esperaba «${f.nombre}», hay ${porId.has(id) ? `«${porId.get(id)}»` : "nada"})`));
  if (raras.length > 0) {
    throw new Error(`La fusión de ciudades no cuadra con esta base: ${raras.join(", ")}. ${NADA}`);
  }

  const huerfanos = await leer<{ id: number }>(
    `/* huerfanos */ SELECT p.id FROM postes p
      WHERE NOT EXISTS (SELECT 1 FROM ciudads c WHERE c.id = p."id_ciudadA")
         OR NOT EXISTS (SELECT 1 FROM ciudads c WHERE c.id = p."id_ciudadB")
      ORDER BY p.id LIMIT 50`,
  );
  if (huerfanos.length > 0) {
    throw new Error(`Hay postes que apuntan a una ciudad inexistente: ${huerfanos.map((p) => p.id).join(", ")}. ${NADA}`);
  }

  const misma = await leer<{ id: number }>(
    `/* misma */ SELECT id FROM postes
      WHERE ${fusionada('"id_ciudadA"')} = ${fusionada('"id_ciudadB"')} ORDER BY id LIMIT 50`,
  );
  if (misma.length > 0) {
    throw new Error(
      `Hay postes con la misma ciudad en los dos extremos, y un tramo une dos distintas: ${misma.map((p) => p.id).join(", ")}. ` +
      `Corrige su ciudad y vuelve a ejecutar. ${NADA}`,
    );
  }

  // Archived views too: they can be restored. `ciudad[AB]` anywhere in the
  // configuration, or a filter on a path ending in `tramo` — that one compares
  // the rendered text, which is about to change.
  const informes = await leer<{ id: number; name: string }>(
    `/* informes */ SELECT id, name FROM reporte_vistas
      WHERE config::text ~ 'ciudad[AB]'
         OR jsonb_path_exists(config, '$.filters.** ? (@.path like_regex "(^|[.])tramo$")')
      ORDER BY id`,
  );
  if (informes.length > 0) {
    throw new Error(
      `Hay informes guardados que usan «Ciudad A/B» o filtran por el texto del tramo: ` +
      `${informes.map((i) => `#${i.id} «${i.name}»`).join(", ")}. Edítalos o archívalos y vuelve a ejecutar. ${NADA}`,
    );
  }
}

export async function up({ context: queryInterface }: { context: QueryInterface }) {
  await queryInterface.sequelize.transaction(async (transaction) => {
    const sql = (texto: string) => queryInterface.sequelize.query(texto, { transaction });
    await sql("SET LOCAL lock_timeout = '5s'");
    await comprobar(queryInterface, transaction);
    const ahora = queryInterface.sequelize.literal("now()");

    // 1. Names: 41 cities carried stray spaces, which is how «Ventillas » hid.
    await sql(`UPDATE ciudads SET name = ${limpio} WHERE name IS DISTINCT FROM ${limpio}`);

    // 2. The merge. The loser is archived, not deleted: it is the record of
    //    what was merged, and nothing points at it afterwards.
    for (const { pierde, gana } of FUSIONES) {
      await sql(`UPDATE postes SET "id_ciudadA" = ${gana} WHERE "id_ciudadA" = ${pierde}`);
      await sql(`UPDATE postes SET "id_ciudadB" = ${gana} WHERE "id_ciudadB" = ${pierde}`);
      await sql(`UPDATE ciudads SET "deletedAt" = now() WHERE id = ${pierde} AND "deletedAt" IS NULL`);
    }

    // 3. Departments.
    await queryInterface.createTable("departamentos", {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true, allowNull: false },
      name: { type: DataTypes.STRING(40), allowNull: false, unique: true },
    }, { transaction });
    await queryInterface.bulkInsert("departamentos", DEPARTAMENTOS.map((name) => ({ name })), { transaction });

    // 4. Tramos.
    await queryInterface.createTable("tramos", {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true, allowNull: false },
      id_ciudad_min: {
        type: DataTypes.INTEGER, allowNull: false,
        references: { model: "ciudads", key: "id" }, onUpdate: "CASCADE", onDelete: "RESTRICT",
      },
      id_ciudad_max: {
        type: DataTypes.INTEGER, allowNull: false,
        references: { model: "ciudads", key: "id" }, onUpdate: "CASCADE", onDelete: "RESTRICT",
      },
      id_departamento: {
        type: DataTypes.INTEGER, allowNull: true,
        references: { model: "departamentos", key: "id" }, onUpdate: "CASCADE", onDelete: "RESTRICT",
      },
      id_usuario: {
        type: DataTypes.INTEGER, allowNull: true,
        references: { model: "usuarios", key: "id" }, onUpdate: "CASCADE", onDelete: "SET NULL",
      },
      createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: ahora },
      updatedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: ahora },
      deletedAt: { type: DataTypes.DATE, allowNull: true },
    }, { transaction });
    await sql(`ALTER TABLE tramos ADD CONSTRAINT ${RESTRICCIONES.orden} CHECK (id_ciudad_min < id_ciudad_max)`);
    // No WHERE: an archived tramo keeps its pair, so the pair cannot be made twice.
    await sql(`CREATE UNIQUE INDEX ${RESTRICCIONES.parUnico} ON tramos (id_ciudad_min, id_ciudad_max)`);

    // From every pole, archived ones included: none may be left without a tramo.
    await sql(
      `INSERT INTO tramos (id_ciudad_min, id_ciudad_max, "createdAt", "updatedAt")
       SELECT DISTINCT LEAST("id_ciudadA", "id_ciudadB"), GREATEST("id_ciudadA", "id_ciudadB"), now(), now()
         FROM postes ORDER BY 1, 2`,
    );

    // 5. Poles point at their tramo.
    await queryInterface.addColumn("postes", "id_tramo", {
      type: DataTypes.INTEGER, allowNull: true,
      references: { model: "tramos", key: "id" }, onUpdate: "CASCADE", onDelete: "RESTRICT",
    }, { transaction });
    await sql(
      `UPDATE postes p SET "id_tramo" = t.id FROM tramos t
        WHERE t.id_ciudad_min = LEAST(p."id_ciudadA", p."id_ciudadB")
          AND t.id_ciudad_max = GREATEST(p."id_ciudadA", p."id_ciudadB")`,
    );

    // 6. Pole by pole, before anything is dropped. The report totals cannot be
    //    this check — they already merged both directions — so it is made here,
    //    while the two columns still exist to compare against.
    const [{ n }] = await queryInterface.sequelize.query<{ n: string }>(
      `/* comprobacion */ SELECT count(*) AS n FROM postes p
         LEFT JOIN tramos t ON t.id = p."id_tramo"
        WHERE t.id IS NULL
           OR t.id_ciudad_min <> LEAST(p."id_ciudadA", p."id_ciudadB")
           OR t.id_ciudad_max <> GREATEST(p."id_ciudadA", p."id_ciudadB")`,
      { type: QueryTypes.SELECT, transaction },
    );
    if (Number(n) !== 0) {
      throw new Error(`${n} postes no coinciden con el tramo que se les ha asignado. La migración se deshace entera.`);
    }
    await sql(`ALTER TABLE postes ALTER COLUMN "id_tramo" SET NOT NULL`);
    await sql(`CREATE INDEX idx_postes_tramo ON postes ("id_tramo")`);

    // 7. The two columns. Their foreign keys go with them.
    await sql("DROP INDEX IF EXISTS idx_postes_ciudada");
    await sql("DROP INDEX IF EXISTS idx_postes_ciudadb");
    await queryInterface.removeColumn("postes", "id_ciudadA", { transaction });
    await queryInterface.removeColumn("postes", "id_ciudadB", { transaction });
  });
}

/**
 * Rebuilds the two columns from the tramo. It does not restore the direction
 * each pole had, nor the cities that were merged, nor the spaces in the names:
 * see the head of this file.
 */
export async function down({ context: queryInterface }: { context: QueryInterface }) {
  await queryInterface.sequelize.transaction(async (transaction) => {
    const sql = (texto: string) => queryInterface.sequelize.query(texto, { transaction });
    await sql("SET LOCAL lock_timeout = '5s'");

    for (const columna of ["id_ciudadA", "id_ciudadB"]) {
      await queryInterface.addColumn("postes", columna, {
        type: DataTypes.INTEGER, allowNull: true,
        references: { model: "ciudads", key: "id" }, onUpdate: "CASCADE", onDelete: "CASCADE",
      }, { transaction });
    }
    await sql(
      `UPDATE postes p SET "id_ciudadA" = t.id_ciudad_min, "id_ciudadB" = t.id_ciudad_max
         FROM tramos t WHERE t.id = p."id_tramo"`,
    );
    await sql(`ALTER TABLE postes ALTER COLUMN "id_ciudadA" SET NOT NULL`);
    await sql(`ALTER TABLE postes ALTER COLUMN "id_ciudadB" SET NOT NULL`);
    // Unquoted on purpose: that is how they were created, so that is their name.
    await sql(`CREATE INDEX idx_postes_ciudada ON postes ("id_ciudadA")`);
    await sql(`CREATE INDEX idx_postes_ciudadb ON postes ("id_ciudadB")`);

    await sql("DROP INDEX IF EXISTS idx_postes_tramo");
    await queryInterface.removeColumn("postes", "id_tramo", { transaction });
    await queryInterface.dropTable("tramos", { transaction });
    await queryInterface.dropTable("departamentos", { transaction });
  });
}
```

- [ ] **Paso 5: verla pasar** — `npx vitest run src/migrations/20261010000005-create-tramos.test.ts`.
  Si la prueba del orden falla porque `en(...)` devuelve -1, es que el trozo buscado no
  coincide con el SQL ya normalizado a un espacio: ajustar el trozo, no la migración.

- [ ] **Paso 6: la prueba contra la base real** — `src/tramos/tramos.db.test.ts`

```ts
// The tramo migration against a real PostgreSQL holding a copy of the data.
//
// **Only against a throwaway database, and never by accident.** It drops two
// columns from `postes`. The database the rest of the suite reads is shared by
// every session working in this tree, so this asks for one called exactly
// `probe_tramos` and is skipped — loudly — anywhere else. To run it, see
// docs/plans/2026-10-10-tramo-como-entidad-api.md, task 3, step 1, then:
//
//   PG_DATABASE=probe_tramos PG_USER=postgres PG_PASS=probe PG_IP=127.0.0.1 \
//     PG_PORT=55434 npx vitest run src/tramos/tramos.db.test.ts
//
// It expects the copy as it was BEFORE the migration and runs `up` itself, once.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { sequelize } from "../database/sequelize.js";
import { up, FUSIONES, RESTRICCIONES } from "../migrations/20261010000005-create-tramos.js";
import { nombreDeTramo, sqlNombreDeTramo } from "./nombre.js";

const habilitado = process.env.PG_DATABASE === "probe_tramos";
if (!habilitado) {
  console.warn("\n  !! tramos.db: sin la base desechable `probe_tramos`. Nada comprueba la migración contra PostgreSQL.\n");
}

const filas = async <T = Record<string, unknown>>(sql: string): Promise<T[]> =>
  (await sequelize.query(sql))[0] as T[];
const numero = async (sql: string) => Number((await filas<{ n: string }>(sql))[0].n);
const codigoDe = async (sql: string): Promise<string | undefined> => {
  try {
    await sequelize.query(sql);
    return undefined;
  } catch (error) {
    const e = error as { parent?: { code?: string; constraint?: string } };
    return `${e.parent?.code}:${e.parent?.constraint ?? ""}`;
  }
};

const mapa = (c: string) =>
  `(CASE ${c} ${FUSIONES.map((f) => `WHEN ${f.pierde} THEN ${f.gana}`).join(" ")} ELSE ${c} END)`;

describe.skipIf(!habilitado)("create-tramos against PostgreSQL", () => {
  let postesAntes = 0;
  let paresEsperados = 0;

  beforeAll(async () => {
    postesAntes = await numero("SELECT count(*) AS n FROM postes");
    paresEsperados = await numero(
      `SELECT count(*) AS n FROM (SELECT DISTINCT LEAST(${mapa('"id_ciudadA"')}, ${mapa('"id_ciudadB"')}),
              GREATEST(${mapa('"id_ciudadA"')}, ${mapa('"id_ciudadB"')}) FROM postes) x`,
    );
    // What each pole had, kept aside: after `up` the columns are gone.
    await sequelize.query(
      `CREATE TABLE _antes AS SELECT id, LEAST(${mapa('"id_ciudadA"')}, ${mapa('"id_ciudadB"')}) AS a,
              GREATEST(${mapa('"id_ciudadA"')}, ${mapa('"id_ciudadB"')}) AS b FROM postes`,
    );
    await up({ context: sequelize.getQueryInterface() });
  });

  afterAll(async () => {
    await sequelize.close();
  });

  it("loses no pole and leaves none without a tramo", async () => {
    expect(await numero("SELECT count(*) AS n FROM postes")).toBe(postesAntes);
    expect(await numero('SELECT count(*) AS n FROM postes WHERE "id_tramo" IS NULL')).toBe(0);
  });

  it("gives every pole the tramo of the two cities it had", async () => {
    expect(await numero(
      `SELECT count(*) AS n FROM postes p JOIN _antes x ON x.id = p.id JOIN tramos t ON t.id = p."id_tramo"
        WHERE t.id_ciudad_min <> x.a OR t.id_ciudad_max <> x.b`,
    )).toBe(0);
  });

  it("makes one tramo per pair and no more", async () => {
    expect(await numero("SELECT count(*) AS n FROM tramos")).toBe(paresEsperados);
  });

  it("has dropped the two columns", async () => {
    const columnas = await filas<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'postes'",
    );
    const nombres = columnas.map((c) => c.column_name);
    expect(nombres).toContain("id_tramo");
    expect(nombres).not.toContain("id_ciudadA");
    expect(nombres).not.toContain("id_ciudadB");
  });

  it("archived the five duplicates and left their twins alive", async () => {
    const perdedoras = FUSIONES.map((f) => f.pierde).join(", ");
    const ganadoras = FUSIONES.map((f) => f.gana).join(", ");
    expect(await numero(`SELECT count(*) AS n FROM ciudads WHERE id IN (${perdedoras}) AND "deletedAt" IS NOT NULL`)).toBe(5);
    expect(await numero(`SELECT count(*) AS n FROM ciudads WHERE id IN (${ganadoras}) AND "deletedAt" IS NULL`)).toBe(5);
    expect(await numero(`SELECT count(*) AS n FROM tramos WHERE id_ciudad_min IN (${perdedoras}) OR id_ciudad_max IN (${perdedoras})`)).toBe(0);
  });

  it("left no city name with stray spaces", async () => {
    expect(await numero(`SELECT count(*) AS n FROM ciudads WHERE name <> btrim(regexp_replace(name, '\\s+', ' ', 'g'))`)).toBe(0);
  });

  it("seeded nine departments", async () => {
    expect(await numero("SELECT count(*) AS n FROM departamentos")).toBe(9);
  });

  it("refuses a reversed pair, a single city and a repeated pair — each by its own constraint", async () => {
    const [{ a, b }] = await filas<{ a: number; b: number }>(
      "SELECT id_ciudad_min AS a, id_ciudad_max AS b FROM tramos ORDER BY id LIMIT 1",
    );
    const insertar = (min: number, max: number) =>
      `INSERT INTO tramos (id_ciudad_min, id_ciudad_max, "createdAt", "updatedAt") VALUES (${min}, ${max}, now(), now())`;
    expect(await codigoDe(insertar(b, a))).toBe(`23514:${RESTRICCIONES.orden}`);
    expect(await codigoDe(insertar(a, a))).toBe(`23514:${RESTRICCIONES.orden}`);
    expect(await codigoDe(insertar(a, b))).toBe(`23505:${RESTRICCIONES.parUnico}`);
  });

  it("still refuses the repeated pair when the first one is archived", async () => {
    const [{ id, a, b }] = await filas<{ id: number; a: number; b: number }>(
      "SELECT id, id_ciudad_min AS a, id_ciudad_max AS b FROM tramos ORDER BY id DESC LIMIT 1",
    );
    await sequelize.query(`UPDATE tramos SET "deletedAt" = now() WHERE id = ${id}`);
    expect(await codigoDe(
      `INSERT INTO tramos (id_ciudad_min, id_ciudad_max, "createdAt", "updatedAt") VALUES (${a}, ${b}, now(), now())`,
    )).toBe(`23505:${RESTRICCIONES.parUnico}`);
    await sequelize.query(`UPDATE tramos SET "deletedAt" = NULL WHERE id = ${id}`);
  });

  it("names every tramo the same in SQL and in TypeScript", async () => {
    const todos = await filas<{ nombre: string; a_id: number; a_name: string | null; b_id: number; b_name: string | null }>(
      `SELECT ${sqlNombreDeTramo("t", "a", "b")} AS nombre, a.id AS a_id, a.name AS a_name, b.id AS b_id, b.name AS b_name
         FROM tramos t LEFT JOIN ciudads a ON a.id = t.id_ciudad_min LEFT JOIN ciudads b ON b.id = t.id_ciudad_max`,
    );
    expect(todos.length).toBeGreaterThan(50);
    const distintos = todos.filter((t) =>
      t.nombre !== nombreDeTramo({ id: t.a_id, name: t.a_name }, { id: t.b_id, name: t.b_name }));
    expect(distintos).toEqual([]);
  });

  it("leaves no two tramos with the same name", async () => {
    expect(await filas(
      `SELECT ${sqlNombreDeTramo("t", "a", "b")} AS nombre, count(*) FROM tramos t
         LEFT JOIN ciudads a ON a.id = t.id_ciudad_min LEFT JOIN ciudads b ON b.id = t.id_ciudad_max
        GROUP BY 1 HAVING count(*) > 1`,
    )).toEqual([]);
  });
});
```

- [ ] **Paso 7: ejecutarla contra `probe_tramos`** con la línea de la cabecera. Esperado:
  11 pruebas en verde; sobre la copia local, 84 tramos. Anotar la cifra real.
  Si hay que repetir, la base se recrea desde el paso 1 (`docker rm -f osefi-tramos`): la
  prueba espera la copia sin migrar.

- [ ] **Paso 8:** `npx vitest run src/tramos` sin las variables: la suite de base aparece
  como omitida y avisa por consola.

---

### Tarea 4: el módulo de permisos `tramos`

**Ficheros:**
- Modificar: `src/permissions/matrix.ts`
- Crear: `src/migrations/20261010000006-add-tramos-permisos.ts` y su `.test.ts`

**Interfaces:**
- Produce: `PERMISSIONS.tramos`, `MODULE_LABELS.tramos`; `requirePermission("tramos", …)`
  compila a partir de aquí.

- [ ] **Paso 1: la prueba**

```ts
import { describe, it, expect } from "vitest";
import { up, down } from "./20261010000006-add-tramos-permisos.js";
import { MODULES, MODULE_LABELS, PERMISSIONS, isActionOf } from "../permissions/matrix.js";

function fakeQueryInterface() {
  const calls: { sql: string; opciones: { transaction?: unknown } }[] = [];
  return {
    calls,
    sequelize: {
      query: (sql: string, opciones: { transaction?: unknown } = {}) => {
        calls.push({ sql: sql.replace(/\s+/g, " ").trim(), opciones });
        return Promise.resolve(undefined);
      },
      transaction: (cb: (t: unknown) => Promise<void>) => cb({ id: "t" }),
    },
  };
}

describe("add-tramos-permisos", () => {
  it("copies, role by role, what each one holds today on ciudades", async () => {
    const qi = fakeQueryInterface();
    await up({ context: qi as never });
    const insert = qi.calls.find((c) => c.sql.startsWith("INSERT INTO permisos"))?.sql ?? "";
    // From the live rows, not from a snapshot of three roles: the matrix editor
    // ships in the same cut, so a custom role may already exist.
    expect(insert).toContain("FROM rols r CROSS JOIN unnest(ARRAY['ver', 'crear', 'editar', 'archivar'])");
    expect(insert).toContain("p.modulo = 'ciudades'");
    expect(insert).toContain("COALESCE(p.permitido, false)");
    expect(insert).toContain("ON CONFLICT (id_rol, modulo, accion) DO NOTHING");
  });

  it("removes the module and nothing else on the way down", async () => {
    const qi = fakeQueryInterface();
    await down({ context: qi as never });
    expect(qi.calls.find((c) => c.sql.startsWith("DELETE"))?.sql).toBe("DELETE FROM permisos WHERE modulo = 'tramos'");
  });

  it("runs inside one transaction with the lock timeout first, both ways", async () => {
    for (const direccion of [up, down]) {
      const qi = fakeQueryInterface();
      await direccion({ context: qi as never });
      expect(qi.calls[0].sql).toContain("lock_timeout");
      for (const c of qi.calls) expect(c.opciones.transaction).toEqual({ id: "t" });
    }
  });
});

describe("the module it seeds", () => {
  it("is declared with the four verbs the migration writes", () => {
    expect(PERMISSIONS.tramos).toEqual(["ver", "crear", "editar", "archivar"]);
    for (const accion of PERMISSIONS.tramos) expect(isActionOf("tramos", accion)).toBe(true);
  });

  it("is drawn right under Ciudades, with a label", () => {
    expect(MODULES.indexOf("tramos")).toBe(MODULES.indexOf("ciudades") + 1);
    expect(MODULE_LABELS.tramos).toBe("Tramos");
  });
});
```

- [ ] **Paso 2: verla fallar** — FALLA al resolver la migración.

- [ ] **Paso 3: `matrix.ts`** — tras la línea de `ciudades` en `PERMISSIONS`:

```ts
  // A stretch of line between two cities. Its own module rather than a reading
  // of `ciudades`: who may say which stretches exist decides where every pole
  // can be placed. Seeded with what each role holds on `ciudades`
  // (`20261010000006`).
  tramos: ["ver", "crear", "editar", "archivar"],
```

y en `MODULE_LABELS`, tras `ciudades`: `tramos: "Tramos",`.

- [ ] **Paso 4: la migración**

```ts
import { QueryInterface } from "sequelize";

/**
 * The `tramos` module on the permission matrix. Design:
 * docs/specs/2026-10-10-tramo-como-entidad-design.md §5.4.
 *
 * Each role is born with what it holds today on `ciudades`, cell by cell: who
 * could create a city can create a stretch between two. Read from the live
 * rows rather than from the three roles the first migration seeded, because
 * the screen that makes new roles ships in this same cut.
 *
 * One row per role that exists, archived ones included, so the screen has a
 * box for each. A role with no `ciudades` row for an action gets `false`.
 * `ON CONFLICT DO NOTHING` so a second run overwrites no decision.
 *
 * Its own file, after the one that changes the schema: if this one fails the
 * schema stays migrated and the module is simply closed to everybody, which is
 * the safe direction. Run it again.
 */
export async function up({ context: queryInterface }: { context: QueryInterface }) {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.sequelize.query("SET LOCAL lock_timeout = '5s'", { transaction });
    await queryInterface.sequelize.query(
      `INSERT INTO permisos (id_rol, modulo, accion, permitido, "createdAt", "updatedAt")
       SELECT r.id, 'tramos', a.accion, COALESCE(p.permitido, false), now(), now()
         FROM rols r
        CROSS JOIN unnest(ARRAY['ver', 'crear', 'editar', 'archivar']) AS a(accion)
         LEFT JOIN permisos p ON p.id_rol = r.id AND p.modulo = 'ciudades' AND p.accion = a.accion
       ON CONFLICT (id_rol, modulo, accion) DO NOTHING`,
      { transaction },
    );
  });
}

export async function down({ context: queryInterface }: { context: QueryInterface }) {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.sequelize.query("SET LOCAL lock_timeout = '5s'", { transaction });
    await queryInterface.sequelize.query("DELETE FROM permisos WHERE modulo = 'tramos'", { transaction });
  });
}
```

- [ ] **Paso 5: verla pasar**, y `npx vitest run src/permissions` entero: `vocabulary.test.ts`
  y cualquier prueba que cuente módulos o celdas. Si una fija «diez módulos» o un número
  de celdas, se actualiza la cifra en esa prueba y se dice en el informe final.

- [ ] **Paso 6:** contra `probe_tramos` (ya migrada por la tarea 3), ejecutar la migración
  y medir:

```bash
PG_DATABASE=probe_tramos PG_USER=postgres PG_PASS=probe PG_IP=127.0.0.1 PG_PORT=55434 npm run migrate
docker exec osefi-tramos psql -U postgres probe_tramos -c \
  "select c.id_rol, c.accion, c.permitido = t.permitido as igual from permisos c join permisos t on t.id_rol=c.id_rol and t.accion=c.accion and t.modulo='tramos' where c.modulo='ciudades' order by 1,2"
```

Esperado: `igual = t` en todas las filas, cuatro por rol. (`npm run migrate` marcará la
`…05` como pendiente y la ejecutará de nuevo si la tarea 3 la corrió a mano sin
registrarla: en ese caso recrear la base y dejar que `migrate` corra las dos.)

---

### Tarea 5: el `include` único y lo que viaja

**Ficheros:**
- Crear: `src/tramos/presentacion.ts`
- Prueba: `src/tramos/presentacion.test.ts`

**Interfaces:**
- Consume: `TramoModel`, `TRAMO_PUBLIC_ATTRIBUTES`, `DepartamentoModel`, `CiudadModel`,
  `ordenarExtremos`, `nombreDeTramo`.
- Produce:
  - `INCLUDE_TRAMO` — el objeto de `include`, con `paranoid: false` en el tramo y en sus
    dos ciudades.
  - `interface TramoPresentado { id: number; nombre: string; ciudades: [CiudadDeTramo, CiudadDeTramo]; id_departamento: number | null; departamento: { id: number; name: string } | null; archivado: boolean }`
  - `interface CiudadDeTramo { id: number; name: string | null; lat: number | null; lng: number | null }`
  - `presentarTramo(crudo: unknown): TramoPresentado`
  - `presentarTramos(valor: unknown): unknown` — recorre cualquier respuesta y sustituye
    cada clave `tramo` cruda por su forma presentada.

- [ ] **Paso 1: la prueba**

```ts
import { describe, it, expect } from "vitest";
import { INCLUDE_TRAMO, presentarTramo, presentarTramos } from "./presentacion.js";
import { TRAMO_PUBLIC_ATTRIBUTES } from "../models/tramo.model.js";

const crudo = (extra: Record<string, unknown> = {}) => ({
  id: 14,
  id_ciudad_min: 3,
  id_ciudad_max: 7,
  id_departamento: 5,
  deletedAt: null,
  ciudadMin: { id: 3, name: "Sucre", lat: -19.04, lng: -65.26 },
  ciudadMax: { id: 7, name: "Potosí", lat: -19.58, lng: -65.75 },
  departamento: { id: 5, name: "Potosí" },
  ...extra,
});

describe("presentarTramo", () => {
  it("sends a name and two cities in the order of the name, and neither min nor max", () => {
    const t = presentarTramo(crudo());
    expect(t).toEqual({
      id: 14,
      nombre: "Potosí – Sucre",
      ciudades: [
        { id: 7, name: "Potosí", lat: -19.58, lng: -65.75 },
        { id: 3, name: "Sucre", lat: -19.04, lng: -65.26 },
      ],
      id_departamento: 5,
      departamento: { id: 5, name: "Potosí" },
      archivado: false,
    });
    expect(JSON.stringify(t)).not.toMatch(/min|max/);
  });

  it("says so when the tramo is archived, and still names it", () => {
    const t = presentarTramo(crudo({ deletedAt: "2026-10-01T00:00:00.000Z" }));
    expect(t.archivado).toBe(true);
    expect(t.nombre).toBe("Potosí – Sucre");
  });

  it("stands a city that did not come in the join on its id, rather than failing", () => {
    const t = presentarTramo(crudo({ ciudadMin: null }));
    expect(t.nombre).toBe("#3 – Potosí");
    expect(t.ciudades[0]).toEqual({ id: 3, name: null, lat: null, lng: null });
  });

  it("has no department when none was assigned", () => {
    const t = presentarTramo(crudo({ id_departamento: null, departamento: null }));
    expect(t.departamento).toBeNull();
    expect(t.id_departamento).toBeNull();
  });
});

describe("presentarTramos", () => {
  it("replaces every raw tramo, however deep, and leaves the rest alone", () => {
    const respuesta = {
      data: [
        { id: 1, name: "P-1", tramo: crudo(), eventos: [{ id: 9, poste: { id: 1, tramo: crudo() } }] },
        { id: 2, name: "P-2", tramo: null },
      ],
      total: 2,
    };
    const salida = presentarTramos(respuesta) as typeof respuesta & { data: { tramo: { nombre?: string } | null }[] };
    expect(salida.total).toBe(2);
    expect(salida.data[0].tramo?.nombre).toBe("Potosí – Sucre");
    expect((salida.data[0] as never as { eventos: { poste: { tramo: { nombre: string } } }[] }).eventos[0].poste.tramo.nombre)
      .toBe("Potosí – Sucre");
    expect(salida.data[1].tramo).toBeNull();
    expect(JSON.stringify(salida)).not.toContain("id_ciudad_min");
  });

  it("goes through model instances the way the response would", () => {
    const instancia = { toJSON: () => ({ id: 1, tramo: crudo() }) };
    expect((presentarTramos(instancia) as { tramo: { nombre: string } }).tramo.nombre).toBe("Potosí – Sucre");
  });

  it("does not touch a `tramo` that is already presented, or one that is not a tramo", () => {
    const ya = { tramo: presentarTramo(crudo()), otro: { tramo: "texto" } };
    expect(presentarTramos(ya)).toEqual(JSON.parse(JSON.stringify(ya)));
  });
});

describe("INCLUDE_TRAMO", () => {
  it("names its columns, and brings an archived tramo and an archived city all the same", () => {
    expect(INCLUDE_TRAMO.attributes).toEqual([...TRAMO_PUBLIC_ATTRIBUTES]);
    expect(INCLUDE_TRAMO.paranoid).toBe(false);
    const ciudades = INCLUDE_TRAMO.include.filter((i) => "as" in i);
    expect(ciudades.map((i) => (i as { as: string }).as)).toEqual(["ciudadMin", "ciudadMax"]);
    for (const c of ciudades) {
      expect((c as { paranoid: boolean }).paranoid).toBe(false);
      expect(c.attributes).toEqual(["id", "name", "lat", "lng"]);
    }
  });
});
```

- [ ] **Paso 2: verla fallar** — FALLA al resolver `./presentacion.js`.

- [ ] **Paso 3: implementar**

```ts
// What a tramo looks like once it leaves the server, and the one way to ask
// the database for it.
//
// Before this, each controller included the two cities of a pole and each
// screen glued a name out of them. Now a controller includes `INCLUDE_TRAMO`
// and passes its answer through `presentarTramos`; nobody downstream knows
// there is a min and a max.
//
// **Archived rows travel.** A pole can be shown inside an incident long after
// its tramo or one of its cities was archived, and the client reads
// `poste.tramo.ciudades` with no guard — this application has no error
// boundary. So the include asks for them with `paranoid: false`, and the
// presenter says `archivado` instead of sending `null`.

import { CiudadModel } from "../models/ciudad.model.js";
import { DepartamentoModel } from "../models/departamento.model.js";
import { TramoModel, TRAMO_PUBLIC_ATTRIBUTES } from "../models/tramo.model.js";
import { nombreDeTramo, ordenarExtremos } from "./nombre.js";

/** What a caller needs of each end: a label and a point to draw. */
export const CIUDAD_DE_TRAMO = ["id", "name", "lat", "lng"] as const;

export const INCLUDE_TRAMO = {
  model: TramoModel,
  paranoid: false,
  attributes: [...TRAMO_PUBLIC_ATTRIBUTES],
  include: [
    { model: CiudadModel, as: "ciudadMin", paranoid: false, attributes: [...CIUDAD_DE_TRAMO] },
    { model: CiudadModel, as: "ciudadMax", paranoid: false, attributes: [...CIUDAD_DE_TRAMO] },
    { model: DepartamentoModel, attributes: ["id", "name"] },
  ],
};

export interface CiudadDeTramo {
  id: number;
  name: string | null;
  lat: number | null;
  lng: number | null;
}

export interface TramoPresentado {
  id: number;
  nombre: string;
  /** The two ends, in the order `nombre` reads them. */
  ciudades: [CiudadDeTramo, CiudadDeTramo];
  id_departamento: number | null;
  departamento: { id: number; name: string } | null;
  archivado: boolean;
}

interface TramoCrudo {
  id: number;
  id_ciudad_min: number;
  id_ciudad_max: number;
  id_departamento?: number | null;
  deletedAt?: unknown;
  ciudadMin?: Partial<CiudadDeTramo> | null;
  ciudadMax?: Partial<CiudadDeTramo> | null;
  departamento?: { id: number; name: string } | null;
}

const esCrudo = (v: unknown): v is TramoCrudo =>
  typeof v === "object" && v !== null && "id_ciudad_min" in v && "id_ciudad_max" in v;

const ciudad = (id: number, c: Partial<CiudadDeTramo> | null | undefined): CiudadDeTramo => ({
  id,
  name: c?.name ?? null,
  lat: c?.lat ?? null,
  lng: c?.lng ?? null,
});

export function presentarTramo(valor: unknown): TramoPresentado {
  const crudo = (typeof (valor as { toJSON?: unknown })?.toJSON === "function"
    ? (valor as { toJSON(): unknown }).toJSON()
    : valor) as TramoCrudo;
  const ciudades = ordenarExtremos(
    ciudad(crudo.id_ciudad_min, crudo.ciudadMin),
    ciudad(crudo.id_ciudad_max, crudo.ciudadMax),
  );
  return {
    id: crudo.id,
    nombre: nombreDeTramo(ciudades[0], ciudades[1]),
    ciudades,
    id_departamento: crudo.id_departamento ?? null,
    departamento: crudo.departamento ? { id: crudo.departamento.id, name: crudo.departamento.name } : null,
    archivado: crudo.deletedAt != null,
  };
}

const recorrer = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(recorrer);
  if (typeof v !== "object" || v === null) return v;
  const salida: Record<string, unknown> = {};
  for (const [clave, valor] of Object.entries(v)) {
    salida[clave] = clave === "tramo" && esCrudo(valor) ? presentarTramo(valor) : recorrer(valor);
  }
  return salida;
};

/**
 * A whole response, with every raw tramo in it presented.
 *
 * Through JSON first, which is exactly what `res.json` would have done with
 * the same value: model instances become their plain rows and dates become
 * strings. It costs a second serialisation of the list — milliseconds on the
 * 5.000-row ceiling `listar` enforces — and buys not having to know which of
 * the nested values are instances.
 */
export const presentarTramos = (valor: unknown): unknown =>
  recorrer(JSON.parse(JSON.stringify(valor)));
```

- [ ] **Paso 4: verla pasar** — 8 pruebas.

- [ ] **Paso 5: vigilar el modelo en `controllers/responseShape.test.ts`.** Añadir
  `"TramoModel"` a `GUARDED` y `join(here, "..", "tramos")` a `DIRECTORIOS`. Ejecutar
  `npx vitest run src/controllers/responseShape.test.ts`. Esperado: verde — el único
  `model: TramoModel` del árbol es el de `presentacion.ts`, que lleva `attributes`. Para
  comprobar que la vigilancia muerde, quitar un momento `attributes` de `INCLUDE_TRAMO`:
  debe fallar «never includes one of the guarded models bare» nombrando
  `presentacion.ts`. Restaurarlo.

---

### Tarea 6: el recurso `/api/tramo`

**Ficheros:**
- Crear: `src/controllers/tramo.controller.ts`, `src/routes/tramo.routes.ts`,
  `src/controllers/tramo.controller.test.ts`
- Modificar: `src/app.ts`, `src/utils/bitacoraVocabulary.ts`,
  `src/controllers/opciones.controller.ts`,
  `src/routes/routeGuards.test.ts`, `src/routes/naming.test.ts`,
  `src/routes/listShape.test.ts`, `src/routes/statusCodes.test.ts`

**Interfaces:**
- Consume: todo lo de las tareas 1, 2, 4 y 5.
- Produce las rutas:

| Ruta | Permiso | Respuesta |
|---|---|---|
| `GET /api/tramo/` | `tramos.ver` | sobre de lista; cada fila es `TramoPresentado` + `postes?: number` |
| `GET /api/tramo/options` | `tramos.ver` | `{ ciudad: {id,name}[], departamento: {id,name}[] }` |
| `GET /api/tramo/:id` | `tramos.ver` | `TramoPresentado`, o 404 |
| `POST /api/tramo/` | `tramos.crear` | 201 `TramoPresentado`; 409 `{ message, tramo }` |
| `PUT /api/tramo/:id` | `tramos.editar` | 200 `TramoPresentado` |
| `DELETE /api/tramo/:id` | `tramos.archivar` | 204; 409 con postes vivos |
| `PATCH /api/tramo/:id/restore` | `tramos.archivar` | 204 |

  Parámetros de la lista: `archived=true`, `departamento=<id>|ninguno`, paginación.
- Exporta además `leerCiudades(body): [number, number] | string` y `TRAMO_NO_DISPONIBLE`
  (mensaje), que usa la tarea 7.

- [ ] **Paso 1: vocabulario de bitácora** (`utils/bitacoraVocabulary.ts`), en orden
  alfabético dentro de cada bloque:

```ts
  CREATE_TRAMO:            a("Nuevo tramo", "crear"),
  UPDATE_TRAMO:         a("Editó tramo", "editar"),
  DELETE_TRAMO:         a("Archivó tramo", "archivar"),
  RESTORE_TRAMO:       a("Desarchivó tramo", "restaurar"),
```

y en `BITACORA_ENTITIES`, tras `Ciudad`: `Tramo: "Tramo",`.

- [ ] **Paso 2: la prueba del controlador**

```ts
// The tramo resource. What is pinned here is what the constraints in the
// database cannot say on their own: which answer a person gets.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

const tramo = {
  findOne: vi.fn(), findByPk: vi.fn(), findAndCountAll: vi.fn(), create: vi.fn(), restore: vi.fn(), destroy: vi.fn(),
};
const ciudad = { count: vi.fn(), findAll: vi.fn() };
const departamento = { findByPk: vi.fn(), findAll: vi.fn() };
const poste = { count: vi.fn() };
const logAction = vi.fn();

vi.mock("../models/tramo.model.js", () => ({
  TramoModel: tramo,
  TRAMO_PUBLIC_ATTRIBUTES: ["id", "id_ciudad_min", "id_ciudad_max", "id_departamento", "deletedAt"],
}));
vi.mock("../models/ciudad.model.js", () => ({ CiudadModel: ciudad }));
vi.mock("../models/departamento.model.js", () => ({ DepartamentoModel: departamento }));
vi.mock("../models/poste.model.js", () => ({ PosteModel: poste }));
vi.mock("../utils/logAction.js", () => ({ logAction }));
vi.mock("../database/sequelize.js", () => ({
  sequelize: { transaction: (cb: (t: unknown) => Promise<unknown>) => cb({ LOCK: { UPDATE: "UPDATE" } }) },
}));

const permisos = new Set<string>();
vi.mock("../permissions/store.js", () => ({
  can: async (_rol: number, modulo: string, accion: string) => permisos.has(`${modulo}.${accion}`),
}));

const { createTramo, updateTramo, deleteTramo, getTramo, leerCiudades } = await import("./tramo.controller.js");

const fila = (extra: Record<string, unknown> = {}) => {
  const datos: Record<string, unknown> = {
    id: 14, id_ciudad_min: 3, id_ciudad_max: 7, id_departamento: null, deletedAt: null,
    ciudadMin: { id: 3, name: "Sucre", lat: 0, lng: 0 }, ciudadMax: { id: 7, name: "Potosí", lat: 0, lng: 0 },
    departamento: null, ...extra,
  };
  return {
    dataValues: datos,
    get: (k: string) => datos[k],
    toJSON: () => datos,
    set: vi.fn((cambios: Record<string, unknown>) => Object.assign(datos, cambios)),
    save: vi.fn(), restore: vi.fn(async () => { datos.deletedAt = null; }), destroy: vi.fn(),
  };
};

const reqOf = (partes: Partial<Request> = {}) =>
  ({ query: {}, params: {}, body: {}, user: { id: 7, id_rol: 3 }, ...partes }) as unknown as Request;
const resOf = () =>
  ({ status: vi.fn().mockReturnThis(), json: vi.fn(), end: vi.fn(), headersSent: false }) as unknown as Response;
const cuerpo = (res: Response) => vi.mocked(res.json).mock.calls[0][0] as Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  permisos.clear();
  ciudad.count.mockResolvedValue(2);
  departamento.findByPk.mockResolvedValue({ id: 5 });
  poste.count.mockResolvedValue(0);
});

describe("leerCiudades", () => {
  it("hands back the two ids lowest first, whatever order they came in", () => {
    expect(leerCiudades({ ciudades: [7, 3] })).toEqual([3, 7]);
    expect(leerCiudades({ ciudades: ["3", "7"] })).toEqual([3, 7]);
  });

  it("refuses anything that is not two different cities", () => {
    for (const ciudades of [undefined, [], [3], [3, 3], [3, 7, 9], [3, "x"], [0, 7], [3.5, 7], "3,7"]) {
      expect(typeof leerCiudades({ ciudades }), JSON.stringify(ciudades)).toBe("string");
    }
  });
});

describe("POST /api/tramo/", () => {
  it("creates the pair normalised, authored by the session, and answers 201 with the presented tramo", async () => {
    tramo.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce(fila());
    tramo.create.mockResolvedValue(fila());
    const res = resOf();
    await createTramo(reqOf({ body: { ciudades: [7, 3], id_usuario: 99 } }), res);

    expect(tramo.create).toHaveBeenCalledWith(
      { id_ciudad_min: 3, id_ciudad_max: 7, id_departamento: null, id_usuario: 7 },
    );
    expect(res.status).toHaveBeenCalledWith(201);
    expect(cuerpo(res).nombre).toBe("Potosí – Sucre");
    expect(logAction).toHaveBeenCalledWith(expect.objectContaining({ action: "CREATE_TRAMO", entity: "Tramo" }));
  });

  it("answers 409 with the tramo that is already there, so the form can select it", async () => {
    tramo.findOne.mockResolvedValue(fila());
    const res = resOf();
    await createTramo(reqOf({ body: { ciudades: [3, 7] } }), res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect((cuerpo(res).tramo as { id: number }).id).toBe(14);
    expect(tramo.create).not.toHaveBeenCalled();
    expect(logAction).not.toHaveBeenCalled();
  });

  it("gives the same 409 when somebody else created it between the look and the write", async () => {
    tramo.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce(fila());
    tramo.create.mockRejectedValue(Object.assign(new Error("dup"), { name: "SequelizeUniqueConstraintError" }));
    const res = resOf();
    await createTramo(reqOf({ body: { ciudades: [3, 7] } }), res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect((cuerpo(res).tramo as { id: number }).id).toBe(14);
  });

  it("brings an archived pair back instead of making a second row, with the department sent", async () => {
    const archivado = fila({ deletedAt: new Date() });
    tramo.findOne.mockResolvedValueOnce(archivado).mockResolvedValueOnce(fila({ id_departamento: 5 }));
    const res = resOf();
    await createTramo(reqOf({ body: { ciudades: [3, 7], id_departamento: 5 } }), res);

    expect(archivado.restore).toHaveBeenCalled();
    expect(archivado.set).toHaveBeenCalledWith({ id_departamento: 5 });
    expect(tramo.create).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(201);
    expect(logAction).toHaveBeenCalledWith(expect.objectContaining({ action: "RESTORE_TRAMO" }));
  });

  it("refuses a city that does not exist, and a department that does not exist, before writing", async () => {
    ciudad.count.mockResolvedValue(1);
    const sinCiudad = resOf();
    await createTramo(reqOf({ body: { ciudades: [3, 7] } }), sinCiudad);
    expect(sinCiudad.status).toHaveBeenCalledWith(400);

    ciudad.count.mockResolvedValue(2);
    departamento.findByPk.mockResolvedValue(null);
    const sinDepartamento = resOf();
    await createTramo(reqOf({ body: { ciudades: [3, 7], id_departamento: 42 } }), sinDepartamento);
    expect(sinDepartamento.status).toHaveBeenCalledWith(400);
    expect(tramo.create).not.toHaveBeenCalled();
  });
});

describe("PUT /api/tramo/:id", () => {
  it("changes the department of a tramo that has poles", async () => {
    const t = fila();
    tramo.findOne.mockResolvedValue(t);
    tramo.findByPk.mockResolvedValue(fila({ id_departamento: 5, departamento: { id: 5, name: "Potosí" } }));
    poste.count.mockResolvedValue(30);
    const res = resOf();
    await updateTramo(reqOf({ params: { id: "14" }, body: { id_departamento: 5 } }), res);

    expect(t.set).toHaveBeenCalledWith({ id_departamento: 5 });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(logAction).toHaveBeenCalledWith(expect.objectContaining({ action: "UPDATE_TRAMO" }));
  });

  it("refuses to move the ends of a tramo that has poles, archived ones counted", async () => {
    tramo.findOne.mockResolvedValue(fila());
    poste.count.mockResolvedValue(1);
    const res = resOf();
    await updateTramo(reqOf({ params: { id: "14" }, body: { ciudades: [3, 9] } }), res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(poste.count).toHaveBeenCalledWith(expect.objectContaining({ paranoid: false }));
  });

  it("does not ask about poles when the ends sent are the ones it already has", async () => {
    const t = fila();
    tramo.findOne.mockResolvedValue(t);
    tramo.findByPk.mockResolvedValue(fila());
    const res = resOf();
    await updateTramo(reqOf({ params: { id: "14" }, body: { ciudades: [7, 3] } }), res);

    expect(poste.count).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
  });
});

describe("DELETE /api/tramo/:id", () => {
  it("refuses while a live pole stands on it, and locks the row to look", async () => {
    tramo.findOne.mockResolvedValue(fila());
    poste.count.mockResolvedValue(4);
    const res = resOf();
    await deleteTramo(reqOf({ params: { id: "14" } }), res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(tramo.findOne).toHaveBeenCalledWith(expect.objectContaining({ lock: "UPDATE" }));
    expect(logAction).not.toHaveBeenCalled();
  });

  it("archives an empty one and writes it down", async () => {
    const t = fila();
    tramo.findOne.mockResolvedValue(t);
    const res = resOf();
    await deleteTramo(reqOf({ params: { id: "14" } }), res);

    expect(t.destroy).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(204);
    expect(logAction).toHaveBeenCalledWith(expect.objectContaining({ action: "DELETE_TRAMO" }));
  });

  it("answers 404 and logs nothing when there is no such tramo", async () => {
    tramo.findOne.mockResolvedValue(null);
    const res = resOf();
    await deleteTramo(reqOf({ params: { id: "999" } }), res);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(logAction).not.toHaveBeenCalled();
  });
});

describe("GET /api/tramo/", () => {
  beforeEach(() => tramo.findAndCountAll.mockResolvedValue({ count: 1, rows: [fila({ postes: 12 })] }));

  const opciones = () => tramo.findAndCountAll.mock.calls[0][0] as {
    where: Record<string, unknown>; attributes: { include?: unknown[] } | string[];
  };

  it("counts poles only for a role that may read poles", async () => {
    const sin = resOf();
    await getTramo(reqOf(), sin);
    expect(JSON.stringify(opciones().attributes)).not.toContain("postes");
    expect((cuerpo(sin).data as Record<string, unknown>[])[0]).not.toHaveProperty("postes");

    tramo.findAndCountAll.mockClear();
    permisos.add("postes.ver");
    const con = resOf();
    await getTramo(reqOf(), con);
    expect((cuerpo(con).data as { postes: number }[])[0].postes).toBe(12);
  });

  it("filters by a department, and by having none", async () => {
    await getTramo(reqOf({ query: { departamento: "5" } }), resOf());
    expect(opciones().where).toMatchObject({ id_departamento: 5 });

    tramo.findAndCountAll.mockClear();
    await getTramo(reqOf({ query: { departamento: "ninguno" } }), resOf());
    expect(opciones().where).toMatchObject({ id_departamento: null });
  });

  it("refuses a department it cannot read rather than ignoring the filter", async () => {
    const res = resOf();
    await getTramo(reqOf({ query: { departamento: "abc" } }), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(tramo.findAndCountAll).not.toHaveBeenCalled();
  });

  it("answers the envelope with presented rows", async () => {
    const res = resOf();
    await getTramo(reqOf(), res);
    expect(Object.keys(cuerpo(res)).sort()).toEqual(["data", "limit", "page", "total"]);
    expect((cuerpo(res).data as { nombre: string }[])[0].nombre).toBe("Potosí – Sucre");
  });
});
```

- [ ] **Paso 3: verla fallar** — FALLA al resolver `./tramo.controller.js`.

- [ ] **Paso 4: el controlador**

```ts
import { Request, Response } from "express";
import { literal, Op } from "sequelize";
import { sequelize } from "../database/sequelize.js";
import { CiudadModel } from "../models/ciudad.model.js";
import { DepartamentoModel } from "../models/departamento.model.js";
import { PosteModel } from "../models/poste.model.js";
import { TramoModel } from "../models/tramo.model.js";
import { can } from "../permissions/store.js";
import { INCLUDE_TRAMO, presentarTramo, type TramoPresentado } from "../tramos/presentacion.js";
import { sqlNombreDelTramo } from "../tramos/nombre.js";
import { desarchivar, NADA_QUE_ARCHIVAR, NADA_QUE_DESARCHIVAR } from "../utils/archivado.js";
import { logAction } from "../utils/logAction.js";
import { log } from "../utils/logger.js";
import { makeHandler } from "../utils/handler.js";
import { leerPaginacion } from "../utils/paginacion.js";
import { excedeElTecho, listar, responderExcede } from "../utils/listado.js";

const tramoLog = log("tramo");
const handler = makeHandler(tramoLog);

const DOS_CIUDADES = "Un tramo une dos ciudades distintas.";
const CIUDAD_INEXISTENTE = "Una de las ciudades no existe o está archivada.";
const DEPARTAMENTO_INEXISTENTE = "El departamento indicado no existe.";
const DEPARTAMENTO_ILEGIBLE = "El departamento indicado no es válido.";
const YA_EXISTE = "Ese tramo ya existe.";
const CON_POSTES = "No se pueden cambiar las ciudades de un tramo que tiene postes.";
const NO_ARCHIVABLE = "No se puede archivar un tramo que tiene postes.";
const NO_ENCONTRADO = "El tramo no existe.";
/** What a pole write answers when its tramo cannot take it. Used by `poste.controller.ts`. */
export const TRAMO_NO_DISPONIBLE = "El tramo indicado no existe o está archivado.";

const entero = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && /^\d+$/.test(v) ? Number(v) : NaN;
  return Number.isInteger(n) && n > 0 ? n : null;
};

/**
 * The two ends out of a body, lowest id first, or the sentence to answer with.
 *
 * Lowest first because that is the one form the table accepts. The caller sends
 * them in whatever order the person picked them — a tramo has none.
 */
export const leerCiudades = (body: unknown): [number, number] | string => {
  const ciudades = (body as { ciudades?: unknown } | null)?.ciudades;
  if (!Array.isArray(ciudades) || ciudades.length !== 2) return DOS_CIUDADES;
  const [a, b] = ciudades.map(entero);
  if (a === null || b === null || a === b) return DOS_CIUDADES;
  return a < b ? [a, b] : [b, a];
};

/** `undefined` when the body does not mention it, so a partial update leaves it alone. */
const leerDepartamento = (body: unknown): number | null | undefined | string => {
  if (typeof body !== "object" || body === null || !Object.hasOwn(body, "id_departamento")) return undefined;
  const valor = (body as { id_departamento: unknown }).id_departamento;
  if (valor === null || valor === "") return null;
  return entero(valor) ?? DEPARTAMENTO_ILEGIBLE;
};

/** One tramo as it travels, archived or not; the caller decides what an archived one means. */
const cargar = async (id: number): Promise<TramoPresentado | null> => {
  const fila = await TramoModel.findByPk(id, {
    paranoid: false, attributes: INCLUDE_TRAMO.attributes, include: INCLUDE_TRAMO.include,
  });
  return fila ? presentarTramo(fila) : null;
};

const porPar = (min: number, max: number) =>
  TramoModel.findOne({
    where: { id_ciudad_min: min, id_ciudad_max: max },
    paranoid: false,
    attributes: INCLUDE_TRAMO.attributes,
    include: INCLUDE_TRAMO.include,
  });

const esDuplicado = (error: unknown): boolean =>
  (error as { name?: string } | null)?.name === "SequelizeUniqueConstraintError";

/** Live poles on a tramo, as a column. Behind `postes.ver`. */
const CIFRA_DE_POSTES: [ReturnType<typeof literal>, string] = [
  literal(`(SELECT COUNT(*)::int FROM "postes" WHERE "postes"."id_tramo" = "tramo"."id" AND "postes"."deletedAt" IS NULL)`),
  "postes",
];

export const getTramo = handler("getTramo", async (req: Request, res: Response) => {
  const archived = req.query.archived === "true";
  const paginacion = leerPaginacion(req.query);
  if (typeof paginacion === "string") return res.status(400).json({ message: paginacion });

  const where: Record<string, unknown> = archived ? { deletedAt: { [Op.ne]: null } } : {};
  const { departamento } = req.query;
  if (departamento !== undefined && departamento !== "") {
    if (departamento === "ninguno") where.id_departamento = null;
    else {
      const id = entero(departamento);
      if (id === null) return res.status(400).json({ message: DEPARTAMENTO_ILEGIBLE });
      where.id_departamento = id;
    }
  }

  // The route asks for `tramos.ver`, which says nothing about poles. Absent,
  // not zero, for a role that could not read them on their own screen.
  const rol = req.user?.id_rol;
  const verPostes = rol === undefined ? false : await can(rol, "postes", "ver");

  const listado = await listar(TramoModel, {
    where,
    paranoid: !archived,
    // By the name people read, and by id so that a tie cannot reorder between pages.
    order: [[literal(sqlNombreDelTramo(`"tramo"."id"`)), "ASC"], ["id", "ASC"]],
    attributes: { include: verPostes ? [CIFRA_DE_POSTES] : [] },
    include: INCLUDE_TRAMO.include,
  }, paginacion);
  if (excedeElTecho(listado)) return responderExcede(res, listado.excede);

  const data = listado.data.map((fila) => {
    const crudo = JSON.parse(JSON.stringify(fila)) as { postes?: number };
    return { ...presentarTramo(crudo), ...(verPostes ? { postes: Number(crudo.postes ?? 0) } : {}) };
  });
  return res.status(200).json({ ...listado, data });
});

export const searchTramo = handler("searchTramo", async (req: Request, res: Response) => {
  const id = entero(req.params.id);
  const tramo = id === null ? null : await cargar(id);
  if (!tramo || tramo.archivado) return res.status(404).json({ message: NO_ENCONTRADO });
  res.status(200).json(tramo);
});

export const createTramo = handler("createTramo", async (req: Request, res: Response) => {
  const ciudades = leerCiudades(req.body);
  if (typeof ciudades === "string") return res.status(400).json({ message: ciudades });
  const [min, max] = ciudades;

  const departamento = leerDepartamento(req.body);
  if (typeof departamento === "string") return res.status(400).json({ message: departamento });

  if ((await CiudadModel.count({ where: { id: [min, max] } })) !== 2) {
    return res.status(400).json({ message: CIUDAD_INEXISTENTE });
  }
  if (typeof departamento === "number" && !(await DepartamentoModel.findByPk(departamento))) {
    return res.status(400).json({ message: DEPARTAMENTO_INEXISTENTE });
  }

  const existente = await porPar(min, max);
  if (existente && existente.get("deletedAt") == null) {
    return res.status(409).json({ message: YA_EXISTE, tramo: presentarTramo(existente) });
  }

  if (existente) {
    // One row per pair for ever: the archived one comes back, with its
    // archived poles still on it. What the request says about the department
    // wins; silence leaves the one it had.
    await existente.restore();
    if (departamento !== undefined) {
      existente.set({ id_departamento: departamento });
      await existente.save();
    }
    const id = existente.get("id") as number;
    const tramo = presentarTramo((await porPar(min, max)) ?? existente);
    logAction({ id_usuario: req.user?.id, action: "RESTORE_TRAMO", entity: "Tramo", entity_id: id, detail: `Desarchivó tramo ${tramo.nombre}`, severity: "info" });
    return res.status(201).json(tramo);
  }

  try {
    await TramoModel.create({
      id_ciudad_min: min, id_ciudad_max: max, id_departamento: departamento ?? null, id_usuario: req.user?.id ?? null,
    });
  } catch (error) {
    // Somebody created it between the look above and this write. The unique
    // index is what cannot be raced; this turns its refusal into the same
    // answer the look would have given.
    if (!esDuplicado(error)) throw error;
    const ganador = await porPar(min, max);
    if (!ganador) throw error;
    return res.status(409).json({ message: YA_EXISTE, tramo: presentarTramo(ganador) });
  }

  const creado = await porPar(min, max);
  const tramo = presentarTramo(creado);
  logAction({
    id_usuario: req.user?.id, action: "CREATE_TRAMO", entity: "Tramo", entity_id: tramo.id,
    detail: `Creó tramo ${tramo.nombre}`,
    metadata: { after: { name: tramo.nombre, departamento: tramo.departamento?.name ?? null } }, severity: "info",
  });
  res.status(201).json(tramo);
});

export const updateTramo = handler("updateTramo", async (req: Request, res: Response) => {
  const id = entero(req.params.id);
  const fila = id === null ? null : await TramoModel.findOne({
    where: { id }, attributes: INCLUDE_TRAMO.attributes, include: INCLUDE_TRAMO.include,
  });
  if (!fila || id === null) return res.status(404).json({ message: NO_ENCONTRADO });
  const antes = presentarTramo(fila);

  const cambios: Record<string, unknown> = {};

  const departamento = leerDepartamento(req.body);
  if (typeof departamento === "string") return res.status(400).json({ message: departamento });
  if (departamento !== undefined && departamento !== antes.id_departamento) {
    if (typeof departamento === "number" && !(await DepartamentoModel.findByPk(departamento))) {
      return res.status(400).json({ message: DEPARTAMENTO_INEXISTENTE });
    }
    cambios.id_departamento = departamento;
  }

  if (Object.hasOwn(req.body ?? {}, "ciudades")) {
    const ciudades = leerCiudades(req.body);
    if (typeof ciudades === "string") return res.status(400).json({ message: ciudades });
    const [min, max] = ciudades;
    if (min !== fila.get("id_ciudad_min") || max !== fila.get("id_ciudad_max")) {
      // Archived poles count: they still belong to this stretch, and would
      // come back standing somewhere else.
      if ((await PosteModel.count({ where: { id_tramo: id }, paranoid: false })) > 0) {
        return res.status(409).json({ message: CON_POSTES });
      }
      if ((await CiudadModel.count({ where: { id: [min, max] } })) !== 2) {
        return res.status(400).json({ message: CIUDAD_INEXISTENTE });
      }
      const otro = await porPar(min, max);
      if (otro) return res.status(409).json({ message: YA_EXISTE, tramo: presentarTramo(otro) });
      cambios.id_ciudad_min = min;
      cambios.id_ciudad_max = max;
    }
  }

  if (Object.keys(cambios).length > 0) {
    fila.set(cambios);
    await fila.save();
  }
  const despues = (await cargar(id)) ?? antes;
  if (Object.keys(cambios).length > 0) {
    logAction({
      id_usuario: req.user?.id, action: "UPDATE_TRAMO", entity: "Tramo", entity_id: id,
      detail: `Editó tramo ${despues.nombre}`,
      metadata: {
        before: { name: antes.nombre, departamento: antes.departamento?.name ?? null },
        after: { name: despues.nombre, departamento: despues.departamento?.name ?? null },
      },
      severity: "warning",
    });
  }
  res.status(200).json(despues);
});

export const deleteTramo = handler("deleteTramo", async (req: Request, res: Response) => {
  const id = entero(req.params.id);
  if (id === null) return res.status(404).json({ message: NADA_QUE_ARCHIVAR });

  // The look and the archive under one lock on the row. `createPoste` takes a
  // shared lock on the same row before it writes, so a pole cannot land on
  // this tramo between the count and the archive.
  const resultado = await sequelize.transaction(async (t) => {
    const fila = await TramoModel.findOne({ where: { id }, transaction: t, lock: t.LOCK.UPDATE });
    if (!fila) return "nada" as const;
    if ((await PosteModel.count({ where: { id_tramo: id }, transaction: t })) > 0) return "con-postes" as const;
    await fila.destroy({ transaction: t });
    return "archivado" as const;
  });

  if (resultado === "nada") return res.status(404).json({ message: NADA_QUE_ARCHIVAR });
  if (resultado === "con-postes") return res.status(409).json({ message: NO_ARCHIVABLE });
  logAction({ id_usuario: req.user?.id, action: "DELETE_TRAMO", entity: "Tramo", entity_id: id, detail: `Archivó tramo #${id}`, severity: "critical" });
  return res.status(204).end();
});

export const desarchivarTramo = handler("desarchivarTramo", async (req: Request, res: Response) => {
  const { id } = req.params;
  // No clash to ask about first, unlike a role: the pair is unique among the
  // archived too, so nothing can have taken its place.
  if (!(await desarchivar(TramoModel, id))) return res.status(404).json({ message: NADA_QUE_DESARCHIVAR });
  logAction({ id_usuario: req.user?.id, action: "RESTORE_TRAMO", entity: "Tramo", entity_id: Number(id), detail: `Desarchivó tramo #${id}`, severity: "info" });
  return res.status(204).end();
});
```

- [ ] **Paso 5: opciones del diálogo** — en `opciones.controller.ts`, importar
  `DepartamentoModel` y añadir:

```ts
/** The nine departments, in the order they were seeded: the order people recite them in. */
export const departamentos = () =>
  DepartamentoModel.findAll({ attributes: [...NOMBRE], order: [["id", "ASC"]], raw: true });

/**
 * `tramos:ver`, for the tramo dialog opened from its own screen.
 *
 * The same dialog opened from the pole form does not come here: that form is
 * reached with `postes.*` and possibly without `tramos.ver`, and it already
 * holds both lists from `/api/poste/options`.
 */
export const getOpcionesTramo = handler("getOpcionesTramo", async (_req: Request, res: Response) => {
  const [ciudad, departamento] = await Promise.all([lista(CiudadModel, NOMBRE), departamentos()]);
  res.status(200).json({ ciudad, departamento });
});
```

- [ ] **Paso 6: rutas** — `src/routes/tramo.routes.ts`

```ts
import { Router } from "express";
import {
  createTramo, deleteTramo, desarchivarTramo, getTramo, searchTramo, updateTramo,
} from "../controllers/tramo.controller.js";
import { getOpcionesTramo } from "../controllers/opciones.controller.js";
import { requirePermission } from "../middleware/requirePermission.js";

const router = Router();

router.post("/", requirePermission("tramos", "crear"), createTramo);
router.put("/:id", requirePermission("tramos", "editar"), updateTramo);
router.patch("/:id/restore", requirePermission("tramos", "archivar"), desarchivarTramo);
router.get("/", requirePermission("tramos", "ver"), getTramo);
// Before `/:id` — a literal declared after a parametric sibling never runs.
// See `routeOrder.test.ts`.
router.get("/options", requirePermission("tramos", "ver"), getOpcionesTramo);
router.get("/:id", requirePermission("tramos", "ver"), searchTramo);
router.delete("/:id", requirePermission("tramos", "archivar"), deleteTramo);

export default router;
```

En `src/app.ts`: `import tramoRoutes from "./routes/tramo.routes.js";` junto a los demás y,
tras la línea de `tipo-obs`: `app.use("/api/tramo", authenticate, tramoRoutes);`.

- [ ] **Paso 7: las tablas de contrato.** Cada una es una lista que las pruebas comparan
  con la aplicación montada; sin la entrada nueva, fallan nombrando la ruta.

  - `routes/routeGuards.test.ts`: tras `CIUDADES_GATES`,

    ```ts
    /** The tramo register: a stretch between two cities, and where every pole is placed. */
    const TRAMOS_GATES: Record<string, string> = {
      "GET /api/tramo/": "tramos.ver",
      "GET /api/tramo/options": "tramos.ver",
      "GET /api/tramo/:id": "tramos.ver",
      "POST /api/tramo/": "tramos.crear",
      "PUT /api/tramo/:id": "tramos.editar",
      "DELETE /api/tramo/:id": "tramos.archivar",
      "PATCH /api/tramo/:id/restore": "tramos.archivar",
    };
    ```

    `"tramo"` en `TABULADOS` y `["TRAMOS_GATES", TRAMOS_GATES]` en `TABLAS`, tras
    `CIUDADES_GATES`. El comentario «The nine tables» y cualquier cuenta de tablas del
    fichero suben en uno.
  - `routes/naming.test.ts`: `"tramo"` en `NEGOCIO_EN_ESPANOL`, en su sitio alfabético.
  - `routes/listShape.test.ts`: `"/api/tramo/"` en `LISTADOS`, `"/api/tramo/:id"` en
    `DETALLES`, `"/api/tramo/": TramoModel` en `MODELOS` (con su import).
  - `routes/statusCodes.test.ts`: en `ESPERADO`, `"POST /api/tramo/": 201`,
    `"DELETE /api/tramo/:id": 204`, `"PATCH /api/tramo/:id/restore": 204`,
    `"PUT /api/tramo/:id": 200`, cada una en su bloque.

- [ ] **Paso 8: verificar**

```bash
npx vitest run src/controllers/tramo.controller.test.ts src/routes src/permissions src/controllers/responseShape.test.ts
npm run typecheck
```

Esperado: todo verde. Las suites de `src/routes` montan la aplicación con modelos
simulados; si `listShape` o `statusCodes` fallan en `/api/tramo/` porque su doble de
`TramoModel` no responde a `findAndCountAll` / `findOne`, seguir el patrón que el propio
fichero usa para `CiudadModel` (un `vi.spyOn` por método). No relajar la tabla.

- [ ] **Paso 9: contra `probe_tramos`**, con el servidor levantado
  (`PG_DATABASE=probe_tramos … npm run dev`) y una sesión de administrador:

  1. `POST /api/tramo` con dos ciudades de un tramo existente, en orden inverso → 409 con
     `tramo.id`.
  2. `POST` con un par nuevo → 201; `GET /api/tramo/?departamento=ninguno` lo contiene.
  3. `PUT` con `id_departamento: 5` → 200 y `departamento.name === "Potosí"`.
  4. `DELETE` del nuevo → 204; `POST` del mismo par → 201 con el **mismo `id`** y el
     departamento conservado.
  5. `DELETE` de un tramo con postes → 409.

  Anotar las cinco respuestas en el informe.

---

### Tarea 7: postes

**Ficheros:**
- Modificar: `src/controllers/poste.controller.ts`
- Pruebas: `src/controllers/poste.tramo.test.ts` (nueva), y actualizar
  `poste.coordenadas.test.ts`, `authorship.test.ts`, `routes/listShape.test.ts`

**Interfaces:**
- Consume: `INCLUDE_TRAMO`, `presentarTramo`, `presentarTramos`, `sqlNombreDelTramo`,
  `TRAMO_NO_DISPONIBLE`, `TramoModel`.
- Produce: `GET /api/poste/` y `/:id` devuelven `id_tramo` y `tramo: TramoPresentado`.
  Filtros de lista: `tramo=<id>` (sustituye a `ciudadA`+`ciudadB`), `ciudadId=<id>`.

- [ ] **Paso 1: la prueba nueva** — `poste.tramo.test.ts`, con los modelos simulados como
  en `poste.coordenadas.test.ts` (leer ese fichero primero y reutilizar su arranque).
  Casos, cada uno con su aserción:

```ts
describe("filtroDePostes", () => {
  it("filters by a tramo as one id, and counts from the first pole", () => {
    const f = filtroDePostes({ tramo: "14" }) as FiltroPostes;
    expect(f.where).toEqual({ id_tramo: 14 });
    expect(f.order).toEqual([["id", "ASC"]]);
    expect(f.descripcion).toEqual(["un tramo"]);
  });

  it("filters by a city through the tramos that touch it", () => {
    const f = filtroDePostes({ ciudadId: "3" }) as FiltroPostes;
    const sql = JSON.stringify(f.where, (_k, v) => (v && v.val ? v.val : v));
    expect(sql).toContain('"id_ciudad_min" = 3 OR "id_ciudad_max" = 3');
    expect(sql).not.toContain("id_ciudadA");
  });

  it("refuses a tramo or a city it cannot read, instead of listing everything", () => {
    expect(filtroDePostes({ tramo: "abc" })).toBe("El tramo indicado no es válido.");
    expect(filtroDePostes({ ciudadId: "1; drop" })).toBe("La ciudad indicada no es válida.");
  });

  it("refuses the two-city filter of the previous client by name", () => {
    expect(filtroDePostes({ ciudadA: "3", ciudadB: "7" })).toMatch(/tramo/);
  });

  it("orders by the name of the tramo, not by one of its cities", () => {
    const f = filtroDePostes({ sortBy: "tramo", sortOrder: "asc" }) as FiltroPostes;
    expect(JSON.stringify(f.order)).toContain("id_ciudad_min");
    expect(JSON.stringify(f.order)).not.toContain("ciudadA");
  });
});

describe("createPoste", () => {
  it("refuses a pole with no tramo, and one whose tramo is missing or archived, with its own sentence", async () => {
    // tramoFindOne resolves null → 400 TRAMO_NO_DISPONIBLE, PosteModel.create not called
  });
  it("looks the tramo up inside the transaction with a shared lock", async () => {
    // expect(tramoFindOne).toHaveBeenCalledWith(expect.objectContaining({ lock: "SHARE", transaction: T }))
  });
});

describe("updatePoste", () => {
  it("records a move to another tramo by the two names", async () => {
    // before.id_tramo = { id: 14, name: "Potosí – Sucre" }, after.id_tramo = { id: 20, name: "Oruro – Potosí" }
  });
  it("does not ask the tramo for a `name` column it does not have", async () => {
    // every tramo findByPk call carries INCLUDE_TRAMO.attributes, never ["id","name"]
  });
  it("refuses a move to a tramo that is archived", async () => { /* 400 TRAMO_NO_DISPONIBLE */ });
});

describe("desarchivarPoste", () => {
  it("brings the pole's tramo back with it when that was archived too", async () => {
    // TramoModel.restore called with { where: { id: 14 } }; a RESTORE_TRAMO line logged
  });
  it("leaves a live tramo alone", async () => { /* restore not called */ });
});

describe("what the list and the detail send", () => {
  it("sends each pole with its tramo presented and no city columns", async () => {
    // body.data[0].tramo.nombre defined; JSON.stringify(body) has no "ciudadA", "id_ciudad_min"
  });
});
```

  Los cuerpos marcados con comentario se escriben completos siguiendo el arranque del
  fichero de coordenadas; lo que cada uno afirma es exactamente lo que dice su comentario.

- [ ] **Paso 2: verla fallar.** Esperado: `filtroDePostes({ tramo: "14" })` devuelve
  `where: {}` (el parámetro no existe todavía).

- [ ] **Paso 3: `filtroDePostes`.** Sustituir la lectura de `ciudadA`/`ciudadB`:

```ts
const ENTERO = /^\d+$/;
const TRAMO_INVALIDO = "El tramo indicado no es válido.";
const CIUDAD_INVALIDA = "La ciudad indicada no es válida.";
const DOS_CIUDADES_YA_NO =
  "La lista de postes ya no se filtra por dos ciudades: indique el tramo.";

/** The tramos that touch a city, as a subquery. The id is digits only by the time it gets here. */
const tramosDeLaCiudad = (id: number) =>
  literal(`(SELECT "id" FROM "tramos" WHERE "id_ciudad_min" = ${id} OR "id_ciudad_max" = ${id})`);
```

```ts
  const { tramo, ciudadA, ciudadB, ciudadId, archived, filterColumn, filterValue, sortBy, sortOrder } = query;
  const isArchived = archived === "true";

  // A client from before the cut. Refused by name: answering with every pole
  // to somebody who asked for one stretch is the failure this file exists to
  // prevent.
  if (ciudadA !== undefined || ciudadB !== undefined) return DOS_CIUDADES_YA_NO;
  if (tramo !== undefined && !(typeof tramo === "string" && ENTERO.test(tramo))) return TRAMO_INVALIDO;
  if (ciudadId !== undefined && !(typeof ciudadId === "string" && ENTERO.test(ciudadId))) return CIUDAD_INVALIDA;

  const where: Record<string, unknown> = isArchived
    ? { deletedAt: { [Op.ne]: null } }
    : ciudadId
    ? { id_tramo: { [Op.in]: tramosDeLaCiudad(Number(ciudadId)) } }
    : tramo
      ? { id_tramo: Number(tramo) }
      : {};
```

  `descripcion`: `else if (tramo) descripcion.push("un tramo");`. En el orden:
  `if (col === "tramo") return [literal(sqlNombreDelTramo('"poste"."id_tramo"')), dir];`
  y las dos apariciones de `ciudadA && ciudadB` pasan a `tramo` (`!!tramo`).

- [ ] **Paso 4: lista, detalle y exportación.** En `getPoste`, `searchPoste` y
  `exportarPostes`, las dos líneas `{ model: CiudadModel, as: "ciudadA"/"ciudadB", … }` se
  sustituyen por `INCLUDE_TRAMO`. Las respuestas:

```ts
  return res.status(200).json({ ...listado, data: presentarTramos(listado.data) });
```

```ts
  res.status(200).json(presentarTramos(TempPoste));
```

  `PosteExportado` cambia `ciudadA`/`ciudadB` por `tramo?: unknown`, y la celda:

```ts
        tramo: p.tramo ? presentarTramo(p.tramo).nombre : "",
```

- [ ] **Paso 5: `createPoste`.** Antes de la transacción:

```ts
  const idTramo = Number(posteBody.id_tramo);
  if (!Number.isInteger(idTramo) || idTramo <= 0) return res.status(400).json({ message: TRAMO_NO_DISPONIBLE });
```

  y dentro, como primera instrucción:

```ts
    // Shared lock on the tramo for the length of this write: archiving it
    // takes the row FOR UPDATE and counts its poles, so one of the two waits.
    // Without it a pole could land on a tramo archived a millisecond before.
    const tramo = await TramoModel.findOne({ where: { id: idTramo }, attributes: ["id"], transaction: t, lock: t.LOCK.SHARE });
    if (!tramo) throw new TramoNoDisponible();
```

  con, sobre el handler,

```ts
/** Thrown inside a transaction so it rolls back, and answered as a 400 outside it. */
class TramoNoDisponible extends Error {}
```

  y la transacción envuelta:

```ts
  let TempPoste;
  try {
    TempPoste = await sequelize.transaction(async (t) => { /* … */ });
  } catch (error) {
    if (error instanceof TramoNoDisponible) return res.status(400).json({ message: TRAMO_NO_DISPONIBLE });
    throw error;
  }
```

- [ ] **Paso 6: `updatePoste`.** `fkKeys` pasa a
  `new Set(["id_propietario", "id_material", "id_tramo"])`, la lista de pares pierde las
  dos ciudades, y el tramo se resuelve aparte porque no tiene columna `name`:

```ts
  const tramoRef = async (pk: number | null | undefined) => {
    if (pk == null) return null;
    const fila = await TramoModel.findByPk(pk, {
      paranoid: false, attributes: INCLUDE_TRAMO.attributes, include: INCLUDE_TRAMO.include,
    });
    return fila ? { id: pk, name: presentarTramo(fila).nombre } : null;
  };
  if (Object.hasOwn(editable, "id_tramo")) {
    const antes = dv.id_tramo as number;
    const despues = Number(editable.id_tramo);
    if (despues !== antes) {
      const destino = await TramoModel.findOne({ where: { id: despues }, attributes: ["id"] });
      if (!destino) return res.status(400).json({ message: TRAMO_NO_DISPONIBLE });
      [beforeMeta.id_tramo, afterMeta.id_tramo] = await Promise.all([tramoRef(antes), tramoRef(despues)]);
    }
  }
```

- [ ] **Paso 7: `desarchivarPoste`.**

```ts
export const desarchivarPoste = handler("desarchivarPoste", async (req: Request, res: Response) => {
  const { id } = req.params;

  if (!(await desarchivar(PosteModel, id))) return res.status(404).json({ message: NADA_QUE_DESARCHIVAR });
  logAction({ id_usuario: req.user?.id, action: "RESTORE_POSTE", entity: "Poste", entity_id: Number(id), detail: `Desarchivó Poste #${id}`, severity: 'info' });

  // A live pole cannot stand on an archived tramo: nothing would list it under
  // a stretch, and the pair could not be created again to give it one.
  const poste = await PosteModel.findOne({ where: { id }, attributes: ["id", "id_tramo"] });
  const idTramo = poste?.get("id_tramo") as number | undefined;
  if (idTramo !== undefined && (await desarchivar(TramoModel, idTramo))) {
    logAction({ id_usuario: req.user?.id, action: "RESTORE_TRAMO", entity: "Tramo", entity_id: idTramo, detail: `Desarchivó tramo #${idTramo} al desarchivar el Poste #${id}`, severity: 'info' });
  }
  return res.status(204).end();
});
```

- [ ] **Paso 8:** quitar del fichero los imports que ya no usa (`CiudadModel`,
  `nombreDeTramo` de `utils/tramo.js`). Actualizar el comentario de la línea ~351 que
  habla de `id_ciudadA`/`id_ciudadB` — ya no es cierto.

- [ ] **Paso 9: pruebas existentes.** `poste.coordenadas.test.ts:40` y
  `authorship.test.ts:189-202` construyen postes con las dos ciudades: pasan a
  `id_tramo: 1` y su doble de `TramoModel.findOne` devuelve `{ id: 1 }`.
  `routes/listShape.test.ts:685-712` fija `"Sucre > Potosí"`: el doble del poste lleva
  `tramo` crudo y la celda esperada es `"Potosí – Sucre"`.

- [ ] **Paso 10:** `npx vitest run src/controllers/poste.tramo.test.ts src/controllers/poste.coordenadas.test.ts src/controllers/authorship.test.ts src/routes/listShape.test.ts`
  y `npm run typecheck`.

---

### Tarea 8: eventos e inicio

**Ficheros:**
- Modificar: `src/controllers/evento.controller.ts`, `src/controllers/dashboard.controller.ts`
- Pruebas: `src/controllers/evento.list.test.ts`, y la que cubra el dashboard si existe
  (`grep -rl "dashboard.controller" src --include=*.test.ts`)

**Interfaces:**
- Produce: todo poste anidado en un evento lleva `id_tramo` y `tramo: TramoPresentado`.
  `GET /api/dashboard` devuelve `postes[].tramo`.

- [ ] **Paso 1: prueba.** En `evento.list.test.ts` añadir:

```ts
it("sends the pole of each incident with its tramo, archived or not, and never the two cities", async () => {
  // rows: one event whose poste.tramo is raw with deletedAt set
  // expect body.data[0].poste.tramo.archivado toBe(true); nombre defined
  // expect JSON.stringify(body) not toMatch(/ciudadA|ciudadB|id_ciudad_min/)
});

it("orders by the name of the tramo through the incident's own column", async () => {
  // sortBy=tramo → JSON.stringify(order) contains '"evento"."id_poste"' and not "ciudadA"
});

it("asks for the tramo of an archived pole too", async () => {
  // the PosteModel include carries INCLUDE_TRAMO, whose paranoid is false
});
```

- [ ] **Paso 2: verla fallar** — la respuesta lleva `ciudadA`.

- [ ] **Paso 3: `evento.controller.ts`.** Cinco sitios:
  - Orden (línea ~216):
    `if (col === "tramo") return [literal(sqlNombreDelTramoDelPoste('"evento"."id_poste"')), dir];`
    — por la columna propia del evento y no por el alias del include: esta lista pagina
    con subconsulta.
  - Lista (~254): `attributes: ["id", "name", "lat", "lng", "id_tramo", "id_propietario"]`
    y, en su `include`, `INCLUDE_TRAMO` en lugar de las dos ciudades.
  - Exportación (~378): igual; `EventoExportado.poste` cambia las dos ciudades por
    `tramo?: unknown`; celda `tramo: e.poste?.tramo ? presentarTramo(e.poste.tramo).nombre : ""`.
  - `searchEvento` (~495): `INCLUDE_TRAMO` en lugar de las dos ciudades peladas, y
    `{ model: PropietarioModel, attributes: ["id", "name"] }`.
  - Cada `res.json` que devuelve eventos con poste pasa por `presentarTramos(...)`: la
    lista (`{ ...listado, data: presentarTramos(listado.data) }`), `searchEvento`,
    `getEvento_poste` y `getEvento_usuario` si incluyen poste (comprobar con
    `grep -n "model: PosteModel" src/controllers/evento.controller.ts`).

- [ ] **Paso 4: `dashboard.controller.ts`.** En el `PosteModel.findAll` de postes, las dos
  ciudades se sustituyen por `INCLUDE_TRAMO` y `attributes` gana `"id_tramo"`. La
  respuesta: `res.status(200).json(presentarTramos({ eventos, postes }));`. Si el include
  de `PosteModel` dentro de `eventos` (línea ~24) alimenta algo que pinta el tramo en el
  mapa del inicio, lleva también `INCLUDE_TRAMO`; hoy solo lleva `PropietarioModel`, y se
  deja así.

- [ ] **Paso 5:** limpiar imports, `npx vitest run src/controllers/evento.list.test.ts src/controllers/evento.lifecycle.test.ts src/controllers/responseShape.test.ts`
  y `npm run typecheck`.

---

### Tarea 9: opciones y ciudades

**Ficheros:**
- Modificar: `src/controllers/opciones.controller.ts`, `src/controllers/ciudad.controller.ts`
- Pruebas: `src/routes/opciones.test.ts`, `src/controllers/ciudad.controller.test.ts`

**Interfaces:**
- Produce:
  - `GET /api/poste/options` → `{ adss, material, propietario, ciudad, tramos, departamento }`
  - `GET /api/reporte/options` → `{ ciudad, adss, material, propietario, obs, tramos }`
  - `tramos` es `TramoPresentado[]`: todos los no archivados, ordenados por `nombre`.
  - `GET /api/ciudad/` conserva `postes` y `vecinas`, calculados a través de `tramos`.

- [ ] **Paso 1: prueba de opciones.** Sustituir en `opciones.test.ts` las aserciones sobre
  `posteFindAll` (líneas ~290-294) y los dos casos de `tramos` (~340-356) por:

```ts
it("serves every live tramo, presented and in the order of its name", async () => {
  tramoFindAll.mockResolvedValue([
    crudo({ id: 2, ciudadMin: { id: 1, name: "Tarija" }, ciudadMax: { id: 9, name: "Sucre" } }),
    crudo({ id: 1, ciudadMin: { id: 3, name: "Beni" }, ciudadMax: { id: 4, name: "Oruro" } }),
  ]);
  const res = await request(app).get("/api/reporte/options").set("Cookie", COOKIE);
  expect(res.body.tramos.map((t: { nombre: string }) => t.nombre)).toEqual(["Beni – Oruro", "Sucre – Tarija"]);
  expect(JSON.stringify(res.body.tramos)).not.toMatch(/id_ciudad_(min|max)|id_ciudadA/);
});

it("leaves archived tramos out of a list of choices, and keeps their cities' names in", async () => {
  await request(app).get("/api/reporte/options").set("Cookie", COOKIE);
  // The tramo itself: default paranoid, so `paranoid` is not passed as false.
  expect(consulta(tramoFindAll)?.paranoid).not.toBe(false);
  // Its cities: asked for even when archived, so the name is whole.
  expect(consulta(tramoFindAll)?.include.filter((i: { as?: string }) => i.as).every((i: { paranoid: boolean }) => i.paranoid === false)).toBe(true);
});

it("no longer derives tramos from the pole register", async () => {
  await request(app).get("/api/reporte/options").set("Cookie", COOKIE);
  expect(posteFindAll).not.toHaveBeenCalled();
});

it("gives the pole form its tramos and the departments, so it can create a tramo without another gate", async () => {
  const res = await request(app).get("/api/poste/options").set("Cookie", COOKIE);
  expect(Object.keys(res.body).sort()).toEqual(["adss", "ciudad", "departamento", "material", "propietario", "tramos"]);
});
```

  (`crudo` es el ayudante de la prueba de `presentacion.test.ts`; copiarlo al fichero.)

- [ ] **Paso 2: verla fallar** — `res.body.tramos` son pares de ids.

- [ ] **Paso 3: `opciones.controller.ts`.** Borrar `tramosEntre` entero y su comentario;
  quitar el import de `PosteModel`. Añadir:

```ts
/**
 * Every live tramo, presented and in the order of its name.
 *
 * All of them, with poles or without: a tramo created a minute ago has none,
 * and it is exactly the one the pole form is about to need. The earlier version
 * of this block derived the pairs from the pole register and so could only
 * ever offer stretches that already had a pole on them.
 *
 * The tramo is read paranoid — an archived stretch is not a choice — but its
 * two cities are not, so one that was archived still gives the tramo its name.
 */
const tramosVivos = async (): Promise<TramoPresentado[]> => {
  const filas = await TramoModel.findAll({
    attributes: INCLUDE_TRAMO.attributes,
    include: INCLUDE_TRAMO.include,
    order: [["id", "ASC"]],
  });
  return filas.map(presentarTramo).sort((a, b) => (a.nombre < b.nombre ? -1 : a.nombre > b.nombre ? 1 : a.id - b.id));
};
```

  `getOpcionesPoste` añade `tramosVivos()` y `departamentos()` al `Promise.all` y responde
  `{ adss, material, propietario, ciudad, tramos, departamento }`. `getOpcionesReporte`
  deja de leer las ciudades primero: un solo `Promise.all` con `tramosVivos()` en el sitio
  de `tramosEntre(...)`. Reescribir los comentarios de cabecera de ambos handlers que
  describen el mecanismo viejo.

- [ ] **Paso 4: prueba de ciudades.** En `ciudad.controller.test.ts` añadir:

```ts
it("counts a city's poles through the tramos that touch it, and no longer names the two columns", async () => {
  permisos.add("postes.ver").add("eventos.ver");
  await getCiudad(reqOf(), resOf());
  const opciones = findAndCountAll.mock.calls[0][0] as { attributes: { include: [{ val: string }, string][] } };
  const sql = opciones.attributes.include.map(([l]) => l.val).join("\n");
  expect(sql).not.toMatch(/id_ciudadA|id_ciudadB/);
  expect(sql).toContain('"id_ciudad_min" = "ciudad"."id"');
  // A neighbour is a city reached over a tramo that has a live pole on it.
  expect(sql).toContain('"postes"."deletedAt" IS NULL');
});
```

- [ ] **Paso 5: `ciudad.controller.ts`.**

```ts
/** The tramos a city is one end of. */
const TRAMOS_DE_LA_CIUDAD =
  `(SELECT "t"."id" FROM "tramos" AS "t" WHERE "t"."id_ciudad_min" = "ciudad"."id" OR "t"."id_ciudad_max" = "ciudad"."id")`;

/** The live poles of a city: a pole belongs to both ends of its tramo. */
const DE_LA_CIUDAD =
  `"postes"."id_tramo" IN ${TRAMOS_DE_LA_CIUDAD} AND "postes"."deletedAt" IS NULL`;
```

  y `vecinas`:

```ts
  [literal(
    `ARRAY(SELECT DISTINCT "vecina"."id" FROM "postes" ` +
    `INNER JOIN "tramos" AS "tv" ON "tv"."id" = "postes"."id_tramo" ` +
    `INNER JOIN "ciudads" AS "vecina" ON "vecina"."id" = CASE WHEN "tv"."id_ciudad_min" = "ciudad"."id" ` +
    `THEN "tv"."id_ciudad_max" ELSE "tv"."id_ciudad_min" END AND "vecina"."deletedAt" IS NULL ` +
    `WHERE ${DE_LA_CIUDAD} AND "vecina"."id" <> "ciudad"."id" ORDER BY "vecina"."id")`,
  ), "vecinas"],
```

  El comentario sobre `vecinas` deja de citar `tramosEntre`: la regla es «solo vecinas
  vivas, y solo por tramos que tienen un poste vivo».

- [ ] **Paso 6:** `npx vitest run src/routes/opciones.test.ts src/controllers/ciudad.controller.test.ts`
  y `npm run typecheck`. Contra `probe_tramos`: `GET /api/ciudad/?limit=all` y comparar,
  para tres ciudades, `postes` y `vecinas` con lo que da la base local por el camino
  viejo (teniendo en cuenta las cinco fusiones). Anotar las tres.

---

### Tarea 10: reportes fijos

**Ficheros:**
- Modificar: `src/controllers/reporteFiltro.ts`, `src/controllers/reporte.controller.ts`
- Pruebas: `src/controllers/reporteFiltro.test.ts`, `src/controllers/reporte.tiempos.test.ts`,
  `src/routes/reporte.contract.test.ts`

**Interfaces:**
- Produce: `FiltroReporte.tramo: number | null` (desaparecen `tramoInicial`/`tramoFinal`);
  parámetro de consulta `tramo`. Filas de `estado-red`:
  `{ tramo: TramoPresentado, totalPostes, conPendientes, totalPendientes, totalEventos, pctSalud }`.
  Filas de `tiempos`: `{ tramo: TramoPresentado, count, avgVisitas, avgDias, minDias, maxDias }`.

- [ ] **Paso 1: prueba del filtro.** En `reporteFiltro.test.ts`, sustituir los casos de
  `TramoInicial`/`TramoFinal` (126-163, 200) por:

```ts
it("reads the tramo as one id", () => {
  expect(leerFiltro({ ...RANGO, tramo: "14" })).toMatchObject({ tramo: 14 });
  expect(leerFiltro({ ...RANGO })).toMatchObject({ tramo: null });
  expect(leerFiltro({ ...RANGO, tramo: "" })).toMatchObject({ tramo: null });
});

it("refuses a tramo it cannot read", () => {
  for (const tramo of ["abc", "1.5", "-3", ["1", "2"]]) {
    expect(leerFiltro({ ...RANGO, tramo } as never)).toBe("El tramo indicado no es válido.");
  }
});

it("asks for the tramo by name on the report that cannot answer without one", () => {
  expect(leerFiltro({ ...RANGO }, { tramo: "obligatorio" })).toBe("Indique el tramo.");
});

it("refuses the two-city filter of the previous client, on every report", () => {
  const viejo = { ...RANGO, TramoInicial: "3", TramoFinal: "7" };
  expect(leerFiltro(viejo)).toMatch(/dos ciudades/);
  expect(leerFiltroSinRango({ TramoInicial: "3" })).toMatch(/dos ciudades/);
});
```

  (`RANGO` es el par de fechas válido que el fichero ya usa; conservar su nombre real.)

- [ ] **Paso 2: verla fallar** — `tramo` no existe en el resultado.

- [ ] **Paso 3: `reporteFiltro.ts`.**

```ts
export interface FiltroReporte {
  fechaInicial: Date;
  fechaFinal: Date;
  excludeOld: boolean;
  /** The stretch of line the report is narrowed to, or null when it names none. */
  tramo: number | null;
}
```

```ts
const TRAMO_INVALIDO = "El tramo indicado no es válido.";
const TRAMO_REQUERIDO = "Indique el tramo.";
const DOS_CIUDADES_YA_NO = "Los reportes ya no se filtran por dos ciudades: indique el tramo.";

type Comunes = Pick<FiltroReporte, "excludeOld" | "tramo">;
```

  En `comunes`:

```ts
  // A client from before the cut. Ignoring the two parameters would answer a
  // question about one stretch with the whole network.
  if (query.TramoInicial !== undefined || query.TramoFinal !== undefined) return DOS_CIUDADES_YA_NO;

  const tramo = id(query.tramo);
  if (tramo === ILEGIBLE) return TRAMO_INVALIDO;

  return { excludeOld, tramo: tramo === AUSENTE ? null : tramo };
```

  y en `leerFiltro`: `if (opciones.tramo === "obligatorio" && base.tramo === null) return TRAMO_REQUERIDO;`.
  Actualizar los comentarios de las líneas 21, 71 y 104 que citan `?TramoInicial=`.

- [ ] **Paso 4: `reporte.controller.ts`.**
  - Tipos de cabecera: `IPosteConEventos` e `IEventoConSolucion.poste` cambian las dos
    ciudades por `id_tramo: number; tramo: unknown`.
  - `getReporteGeneral`: en el include del poste, `INCLUDE_TRAMO` por las dos ciudades;
    respuesta `res.status(200).json(presentarTramos(data));`.
  - `getReporteTramo`: `const posteWhere = filtro.tramo !== null ? { id_tramo: filtro.tramo } : undefined;`,
    `INCLUDE_TRAMO`, respuesta presentada.
  - `getReporteRecorrido`: `where: { id_tramo: filtro.tramo }`, `INCLUDE_TRAMO`, respuesta
    presentada.
  - `getEstadoRed`: `attributes: ["id", "id_tramo"]`, `INCLUDE_TRAMO`; el mapa se indexa
    por `pd.id_tramo` y guarda `tramo: presentarTramo(pd.tramo)`; desaparece el bloque
    «Normalizar tramo».

```ts
  const tramoMap = new Map<number, {
    tramo: TramoPresentado;
    totalPostes: number; conPendientes: number;
    totalPendientes: number; totalEventos: number;
  }>();

  for (const p of postes) {
    const pd = p.toJSON() as unknown as IPosteConEventos;
    if (!tramoMap.has(pd.id_tramo)) {
      tramoMap.set(pd.id_tramo, {
        tramo: presentarTramo(pd.tramo),
        totalPostes: 0, conPendientes: 0, totalPendientes: 0, totalEventos: 0,
      });
    }
    const row = tramoMap.get(pd.id_tramo)!;
```

  - `getTiemposResumen`: lo mismo; `attributes: ["id", "id_tramo"]`, mapa por
    `p.id_tramo`, y el resultado:

```ts
    .map((t) => ({
      tramo: t.tramo,
      count: t.dias.length,
```

  - Los dos comentarios que citan `reporte.controller.ts:225/228` en `catalog.ts` se
    corrigen en la tarea 11.

- [ ] **Paso 5: pruebas de contrato.** `reporte.contract.test.ts` (81, 222-245, 267-270,
  294-296, 332) y `reporte.tiempos.test.ts:74-77`: los dobles de poste llevan `id_tramo`
  y `tramo` crudo; las consultas usan `?tramo=14`; las filas esperadas llevan `tramo` con
  `nombre`. Añadir en el contrato:

```ts
it("groups by the tramo itself, so two poles of one stretch are one row whichever way they were stored", async () => {
  // two poles with the same id_tramo → estado-red answers one row with totalPostes 2
});
```

- [ ] **Paso 6:** `npx vitest run src/controllers/reporteFiltro.test.ts src/controllers/reporte.tiempos.test.ts src/routes/reporte.contract.test.ts`
  y `npm run typecheck`.

- [ ] **Paso 7: antes y después, sobre datos reales.** Con la API de esta rama contra
  `probe_tramos` y la API de `HEAD` (worktree aparte, `git worktree add ../api-antes HEAD`,
  **sin enlazar `node_modules`**: `npm ci` propio) contra `osefi_local`, pedir
  `estado-red` sin fechas a las dos y comparar con un script en el scratchpad:
  mismo `sum(totalPostes)`, mismo `sum(totalEventos)`, mismo `sum(totalPendientes)`; el
  número de filas baja de 91 a 84 y las siete que desaparecen son exactamente los tramos
  que la fusión une. Listarlas en el informe. Borrar el worktree al terminar
  (`git worktree remove ../api-antes`).

---

### Tarea 11: generador de reportes

**Ficheros:**
- Modificar: `src/reportBuilder/catalog.ts`, y los comentarios de `types.ts` (150-152,
  173, 216) y `catalogView.ts` (287-289) que describen `tramo` con `ciudadA`/`ciudadB`
- Pruebas: `src/reportBuilder/sqlBuilder.test.ts`, `prune.test.ts`, `sqlExecution.test.ts`,
  `export/export.integration.test.ts`; `regression.test.ts` solo si no lleva cambios
  ajenos

**Interfaces:**
- Produce: `poste.tramo` (misma clave, sin dependencias) y `poste.departamento` (nueva),
  las dos resolubles desde las siete raíces. Desaparecen las relaciones `poste.ciudadA`
  y `poste.ciudadB`.

- [ ] **Paso 1: prueba.** En `sqlBuilder.test.ts`, sustituir el caso de la línea 52
  (`revision → evento.poste.ciudadA.name`) y añadir:

```ts
describe("the tramo of a pole", () => {
  const RAICES: [string, string][] = [
    ["poste", "tramo"], ["evento", "poste.tramo"], ["revision", "evento.poste.tramo"],
    ["eventoObs", "evento.poste.tramo"], ["solucion", "evento.poste.tramo"],
  ];

  for (const [root, path] of RAICES) {
    it(`resolves from ${root} without spending a hop on it`, () => {
      const q = buildQuery({ root, columns: [{ path }], limit: 10 } as never, ADMIN);
      expect(q.sql).toContain('FROM "tramos" t');
      expect(q.sql).not.toMatch(/id_ciudadA|id_ciudadB/);
    });

    it(`offers the department beside it from ${root}`, () => {
      const q = buildQuery({ root, columns: [{ path: path.replace(/tramo$/, "departamento") }], limit: 10 } as never, ADMIN);
      expect(q.sql).toContain('"departamentos"');
    });
  }

  it("groups by the tramo id, so two stretches with one name stay two rows", () => {
    const q = buildQuery({
      root: "poste", columns: [{ path: "tramo" }, { path: "id", agg: "count" }], groupBy: ["tramo"], limit: 10,
    } as never, ADMIN);
    expect(q.sql).toMatch(/GROUP BY[^;]*"id_tramo"/);
  });

  it("no longer knows Ciudad A or Ciudad B", () => {
    expect(() => buildQuery({ root: "poste", columns: [{ path: "ciudadA.name" }], limit: 10 } as never, ADMIN))
      .toThrow(/no existe en el catálogo/);
  });
});
```

  (Usar el nombre real de la función que construye la consulta y el de `ADMIN` en ese
  fichero.)

- [ ] **Paso 2: verla fallar** — la SQL lleva `id_ciudadA`.

- [ ] **Paso 3: `catalog.ts`.**
  - `TABLE` gana `tramo: "tramos",` y `departamento: "departamentos",`.
  - Las tres cifras de `ciudad` sustituyen
    `(p."id_ciudadA" = ${a}."id" OR p."id_ciudadB" = ${a}."id")` por:

```ts
/** `p` is a pole; true when it stands on a tramo the city `a` is one end of. */
const enUnTramoDe = (a: string): string =>
  `p."id_tramo" IN (SELECT t."id" FROM "${TABLE.tramo}" t` +
  ` WHERE t."id_ciudad_min" = ${a}."id" OR t."id_ciudad_max" = ${a}."id")`;
```

    El comentario que las precede dice «twice, less the two poles whose two ends are the
    same city»: es falso (medido: no hay ninguno) y además la cifra cambia con la fusión.
    Reescribirlo con la suma medida sobre `probe_tramos`
    (`select sum(n) from (… numPostes por ciudad …)`) y sin la excepción.
  - Borrar `tramoExpr` y su comentario. En `poste`, quitar las relaciones `ciudadA` y
    `ciudadB`, y sustituir el campo calculado:

```ts
    // The name a tramo has everywhere else: `tramos/nombre.ts`, whose SQL twin
    // this is. A scalar subquery rather than a relation, and that is the point:
    // a pole is already two hops away from an inspection or a repair, and the
    // cities sit two further — one more than MAX_DEPTH allows. Costing no hop
    // is what keeps this field offered from every root.
    tramo: {
      kind: "string",
      label: "Tramo",
      sql: (a) => sqlNombreDelTramo(`${a}."id_tramo"`),
      // By the id, not by the rendered name: two stretches can read the same.
      // The name is listed so Postgres accepts it in the SELECT; it depends on
      // the id, so it does not change the grouping.
      groupKeys: (a) => [`${a}."id_tramo"`, sqlNombreDelTramo(`${a}."id_tramo"`)],
    },
    departamento: {
      kind: "string",
      label: "Departamento del tramo",
      sql: (a) =>
        `(SELECT d."name" FROM "${TABLE.tramo}" t` +
        ` JOIN "${TABLE.departamento}" d ON d."id" = t."id_departamento"` +
        ` WHERE t."id" = ${a}."id_tramo")`,
    },
```

    con `import { sqlNombreDelTramo } from "../tramos/nombre.js";`.
  - `catalogView.ts:319` supone que cada dependencia de un campo calculado cuesta un
    salto. Ya no hay ninguna en `tramo`, así que el cálculo sigue siendo correcto; se
    comprueba en el paso 5 que el selector ofrece `evento.poste.tramo` desde `revision`.

- [ ] **Paso 4: pruebas que fijaban lo viejo.**
  - `prune.test.ts:176-181, 335-336`: las rutas `…ciudadA.name` / `ciudadA.numPostes` se
    sustituyen por otra relación de un salto que siga existiendo (`propietario.name`)
    cuando lo que la prueba ejercita es la poda, no la ciudad. Leer cada caso antes: si
    lo que prueba es específicamente «una relación a ciudad», el caso se elimina y se
    dice.
  - `sqlBuilder.test.ts:883, 1378`: lo mismo.
  - `sqlExecution.test.ts:154` espera 89 grupos y `export.integration.test.ts:85-104`
    «Eighty-nine rows»: la cifra nueva se mide en el paso 5 y se escribe con su porqué.
    `sqlExecution.test.ts:215-255` ejecuta SQL crudo sobre `id_ciudadA`: reescribir cada
    consulta de referencia sobre `id_tramo` y `tramos`.
  - `regression.test.ts:110, 202` compone «A - B» desde el reporte heredado:
    `git diff --stat -- src/reportBuilder/regression.test.ts`. Si está limpio, compone con
    `nombreDeTramo`. Si lleva cambios ajenos, no se toca y se avisa a Isaias.

- [ ] **Paso 5: contra la base real.** Estas suites usan `describe.skipIf(!dbAvailable)`
  sobre la base configurada:

```bash
PG_DATABASE=probe_tramos PG_USER=postgres PG_PASS=probe PG_IP=127.0.0.1 PG_PORT=55434 \
  npx vitest run src/reportBuilder
```

  Esperado: «every advertised path produces SQL Postgres accepts» en verde — es la que
  demuestra que `tramo` y `departamento` resuelven desde las siete raíces. La de los 89
  grupos fallará con la cifra real: comprobar que es la que da
  `select count(distinct p."id_tramo") from revicions r join eventos e on e.id=r.id_evento and e."deletedAt" is null join postes p on p.id=e.id_poste where r."deletedAt" is null`
  y escribir esa. Ejecutar el informe guardado #10 («Propietarios de postes») por
  `POST /api/generator/run` con su configuración y comprobar que devuelve las mismas
  filas que en `osefi_local`, salvo la columna «Tramo».

- [ ] **Paso 6:** `npm run show:catalog` y comprobar a ojo que «Tramo» y «Departamento
  del tramo» aparecen bajo Poste y que no queda «Ciudad A». `npm run typecheck`.

---

### Tarea 12: retirar lo viejo, documentar y cerrar

**Ficheros:**
- Modificar: `src/models/poste.model.ts`, `src/interfaces/index.ts`, `scripts/bench-export.mjs`
  (solo si nombra las columnas), `docs/ARCHITECTURE.md`,
  `docs/plans/2026-10-09-corte-de-despliegue.md`
- Eliminar: `src/utils/tramo.ts`

- [ ] **Paso 1: quitar las dos columnas del modelo.** En `poste.model.ts`, borrar
  `id_ciudadA`, `id_ciudadB`, sus cuatro asociaciones y el import de `CiudadModel` si
  queda sin uso; `POSTE_PUBLIC_ATTRIBUTES` queda
  `["id", "name", "date", "lat", "lng", "id_propietario", "id_material", "id_tramo"]`. En
  `interfaces/index.ts`, borrarlas de `IPoste`.

- [ ] **Paso 2: `npm run typecheck`.** Es la comprobación de que no queda ningún
  consumidor. Cada error es un sitio que las tareas 7-11 dejaron atrás: se arregla ahí,
  con su prueba, no con un `as`.

- [ ] **Paso 3: barrido de texto**, porque el compilador no ve cadenas ni SQL:

```bash
grep -rn "id_ciudadA\|id_ciudadB\|ciudadA\|ciudadB\|TramoInicial\|TramoFinal\|tramosEntre\|utils/tramo" src scripts --include=*.ts --include=*.mjs
```

  Esperado: solo las dos migraciones (`…04000001-hand-made-indexes` y la `…05`), sus
  pruebas, las pruebas que afirman la ausencia (`not.toMatch(/ciudadA/)`) y los mensajes
  `DOS_CIUDADES_YA_NO`. Cualquier otra aparición se resuelve.

- [ ] **Paso 4:** `git rm src/utils/tramo.ts` (comprobando antes con `git status` que no
  tiene cambios ajenos).

- [ ] **Paso 5: comentarios vecinos.** Releer los comentarios de los ficheros tocados que
  hablen de tramos, pares, «menor id primero» o `useTramoNeighbors`
  (`grep -rn "useTramoNeighbors\|menor id\|min/max\|bidirectional" src`) y corregir los
  que hayan dejado de ser ciertos.

- [ ] **Paso 6: documentación.**
  - `docs/ARCHITECTURE.md` 228 y 272-277: tablas `tramos` y `departamentos`, el índice
    `idx_postes_tramo` en lugar de los dos de ciudad, y la regla del par único.
  - `docs/plans/2026-10-09-corte-de-despliegue.md`: en la lista inicial, que **la imagen
    anterior se para antes de arrancar la nueva** (esta migración elimina columnas que la
    anterior consulta); en el paso de la prueba de migración, que se repite entera e
    incluye las cuatro comprobaciones previas, con lo que hacer si alguna se dispara; en
    la marcha atrás, que restaurar la copia es la única exacta y pierde lo posterior al
    corte.

- [ ] **Paso 7: todo, sin base.**

```bash
npm run typecheck && npm run lint && npx vitest run
```

  Esperado: verde, con `tramos.db` y `store.db` omitidas y avisando.

- [ ] **Paso 8: todo, con base.** Recrear `probe_tramos` desde cero (tarea 3, paso 1),
  ejecutar `npm run migrate` contra ella (corre la `…05` y la `…06` registrándolas) y:

```bash
PG_DATABASE=probe_tramos PG_USER=postgres PG_PASS=probe PG_IP=127.0.0.1 PG_PORT=55434 npx vitest run
```

  `tramos.db.test.ts` espera la copia sin migrar: se ejecuta **antes** de `npm run migrate`
  en una base recién creada, y el resto de suites después.

- [ ] **Paso 9: `down` y otra vez `up`** sobre `probe_tramos`, para saber que la marcha
  atrás al menos ejecuta: tras `down`, `postes` tiene las dos columnas sin nulos y no hay
  tabla `tramos`; tras `up` de nuevo, las cifras del paso 7 de la tarea 3.

- [ ] **Paso 10: comprobar `osefi_local`**, migrada desde la tarea 3: `npm run dev`
  arranca contra ella y `GET /api/poste/?limit=1` devuelve un poste con `tramo.nombre`.

- [ ] **Paso 11: auditoría posterior**, con un agente auditor sobre el diff de la API:
  autorización de `/api/tramo`, fuga del autor por includes, carreras de crear/archivar,
  y un barrido propio de consumidores — desde el código, no desde este plan.

- [ ] **Paso 12:** `docker rm -f osefi-tramos` cuando la parte 2 (web) ya no la necesite.

---

## Lo que queda para la parte 2 (web)

Pantalla Tramos y `TramoSheet`; selector de tramo en `PosteSheet` con «Crear tramo
nuevo»; un selector en los cinco reportes y el fin de «Tramo desde / hasta» en Recorrido;
`poste.tramo` en las 35 pantallas y exportadores que hoy leen dos ciudades; `tramoOrden`
leyendo `tramo.ciudades`; el espejo del permiso `tramos` en `lib/permissions.ts`, el menú
y `ModuleRoute`; la entidad «Tramo» en `constants/bitacora.ts`. Se escribe sobre las
respuestas reales de esta parte.
