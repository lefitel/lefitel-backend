# A0 — La bitácora no apunta lo que el servidor rechazó

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** que el registro de auditoría deje de afirmar cambios que el servidor
rechazó, en los nueve controladores donde hoy lo hace, y que un test de forma
impida que el décimo vuelva a hacerlo.

**Architecture:** el commit `ce91b1b` cerró la puerta y dejó el recibo. Metió
`assignable()` y `withoutAuthor()` en el `set()` de cada edición, así que un
cuerpo con `deletedAt` o `id_usuario` ya no toca la fila — pero el `logAction`
de al lado sigue construyendo su `before`/`after` desde `req.body` **sin
filtrar**. Resultado: un `PUT /api/ciudad/5` con `deletedAt` responde 200, no
archiva nada, y escribe en la bitácora que se archivó. El arreglo es una línea
por controlador —calcular el diff desde el cuerpo ya filtrado, que es lo que
`usuario.controller.ts` hace bien— y un test de forma que lo sostenga, porque el
defecto no es un valor equivocado sino una línea que falta, y así es como
reaparece: alguien escribe el siguiente controlador copiando el anterior.

Va **antes que A1** y no por gusto. Los dos únicos sitios del código que hoy
hacen esto bien son `updateRevision` y `updateSolucion`, y A1 los borra junto con
los dos tests que lo vigilan. Sin A0 delante, A1 es una regresión.

**Tech Stack:** TypeScript, Express 4, Sequelize 6, Vitest. Ninguna dependencia
nueva.

**Dos cosas que conviene tener claras antes de empezar.**

Primero, **esto era visible**, no latente. `web/src/pages/menu/bitacora/index.tsx`
pinta el diff filtrando a los campos que cambiaron, así que `id` —que no cambia—
nunca se mostraba, pero `deletedAt` pasando de vacío a una fecha, y `id_usuario`
de 3 a 9, sí. Cualquiera que abriera el detalle de una entrada veía el cambio
falso.

Y segundo, **A0 no arregla lo ya escrito.** Las filas que hay hoy en la tabla de
bitácora conservan su diff mentiroso; esta tarea sólo impide los siguientes.
Rellenar hacia atrás no se puede: no queda registro de qué claves rechazó el
servidor en cada una. Si alguna vez importa, la fecha de este commit es la
frontera.

**Spec:** [`docs/specs/2026-08-25-estandar-api-design.md`](../specs/2026-08-25-estandar-api-design.md) — §3.9 (lo que entra tiene forma) y §9 (A0).

---

## Global Constraints

- **`rol.controller.ts` no se toca.** Tiene el mismo defecto y es de la sesión de
  roles. Entra en el test como excepción escrita, con su motivo, igual que
  `routeGuards.test.ts` hace con las suyas. Y se les avisa.
- **No se toca nada de `src/auth/`.** `npm run typecheck` ya sale con cinco
  errores en `src/auth/securityNotice.test.ts` y `npm run lint` con uno en
  `src/controllers/rol.controller.test.ts`: **son de otras sesiones y estaban
  rojos antes de empezar.** No encadenar los dos comandos con `&&`, o el segundo
  no llega a correr.
- Esta tarea **no borra ninguna ruta ni cambia ningún contrato**. Sólo servidor,
  sin despliegue coordinado.
- Un solo commit al final, con los ficheros añadidos por nombre. Nada de
  `git add -A`: hay otras dos sesiones escribiendo en este árbol.
- Código, comentarios y nombres de test en inglés.

---

## Task 1: El test de forma, en rojo

Primero la red, y que enseñe los nueve sitios de una vez. Es el hermano de
`requestShape.test.ts` —que vigila lo que se escribe— pero mirando lo que se
apunta.

**Files:**
- Create: `src/controllers/logShape.test.ts`

**Interfaces:**
- Produces: nada que otro fichero importe. Lo que produce es la lista de
  infractores, que las tareas 2 a 4 van vaciando.

- [ ] **Step 1: Escribir el test**

Crear `src/controllers/logShape.test.ts`. La cabecera explica el porqué, como
hacen sus dos hermanos; el cuerpo recorre las llamadas a `logAction(` de cada
`*.controller.ts`, aísla su `metadata:` y falla si ahí dentro aparece `req.body`
sin pasar por un filtro.

```ts
// No audit entry may describe a change the server refused.
//
// The hermano of `requestShape.test.ts`: that one watches what a write accepts,
// this one watches what the log claims happened. Same reason for being
// source-level — the defect is a missing filter, and it recurs when somebody
// writes the next controller the way the last one was written.
//
// What it exists for. `ce91b1b` put `assignable()` and `withoutAuthor()` on
// every `set()`, so a body carrying `deletedAt` or `id_usuario` no longer
// touches the row. The `logAction` beside it kept building its before/after
// from `req.body` untouched. So `PUT /api/ciudad/5` with `deletedAt` answers
// 200, archives nothing, and writes into the bitácora that it archived — in the
// one record a reader consults precisely to find out whether it happened.
//
// Only `metadata` is judged. A `detail` string may mention `req.body.id_evento`
// to build a human sentence; that is a label, not a claim about a column.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** The wrappers that already drop what a client may not assign. */
const FILTERS = ["assignable", "withoutAuthor", "authoredBy", "pick"];

/**
 * `rol.controller.ts` carries the same defect and belongs to the roles session,
 * which owns that file while its screen is being built. Listed rather than
 * fixed, so this test is honest about what it does not cover. Remove the entry
 * — do not relax the rule — when that session lands the same one-line change.
 */
const NOT_OURS = ["rol.controller.ts"];

/** Every `logAction(...)` argument in the controllers, with its file and line. */
function logCalls() {
  const found: { file: string; line: number; arg: string }[] = [];
  const files = readdirSync(here).filter(
    (f) => f.endsWith(".controller.ts") && !NOT_OURS.includes(f),
  );

  for (const file of files) {
    const source = readFileSync(join(here, file), "utf8");
    const needle = "logAction(";
    let at = source.indexOf(needle);
    while (at !== -1) {
      const open = at + needle.length - 1;
      let depth = 0;
      let close = -1;
      for (let i = open; i < source.length; i++) {
        if (source[i] === "(") depth++;
        else if (source[i] === ")") {
          depth--;
          if (depth === 0) { close = i; break; }
        }
      }
      if (close !== -1) {
        found.push({
          file,
          line: source.slice(0, at).split("\n").length,
          arg: source.slice(open + 1, close),
        });
      }
      at = source.indexOf(needle, at + needle.length);
    }
  }
  return found;
}

/** The `metadata:` value of one call, from its brace to the matching one. */
function metadataOf(arg: string): string | null {
  const at = arg.indexOf("metadata:");
  if (at === -1) return null;
  const open = arg.indexOf("{", at);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < arg.length; i++) {
    if (arg[i] === "{") depth++;
    else if (arg[i] === "}") {
      depth--;
      if (depth === 0) return arg.slice(open, i + 1);
    }
  }
  return null;
}

describe("what the bitácora may claim", () => {
  it("never builds an audit diff from the unfiltered request body", () => {
    const raw = logCalls()
      .map((c) => ({ ...c, meta: metadataOf(c.arg) }))
      .filter((c) => c.meta !== null && c.meta.includes("req.body"))
      .filter((c) => !FILTERS.some((f) => c.meta!.includes(`${f}(`)))
      .map((c) => `${c.file}:${c.line}`);

    expect(
      raw,
      `estas entradas de auditoría describen el cuerpo recibido, no lo que se escribió:\n  ${raw.join("\n  ")}`,
    ).toEqual([]);
  });
});
```

- [ ] **Step 2: Ejecutar y ver la lista completa**

```
cd api && npx vitest run src/controllers/logShape.test.ts
```

Esperado: **FAIL**, con seis ficheros en la lista —`adss`, `ciudad`, `material`,
`propietario`, `tipoObs` y `obs`—. `rol` no aparece porque está en `NOT_OURS`.

**`evento` y `poste` tampoco aparecerán, y eso es correcto**: los dos construyen
su diff en un bucle que lee `req.body` a través de una variable intermedia
(`bodyWithoutObs`, `bodyWithoutAdss`), así que un test de forma no puede verlos.
Los cubre la tarea 4 con tests de comportamiento. Si el test de forma listara
ocho en vez de seis, algo se leyó mal: comprobar antes de seguir.

- [ ] **Step 3: Commit del test en rojo, no**

No se commitea todavía. El commit es uno solo, al final (§9 del spec y norma de
la casa).

---

## Task 2: Los cinco catálogos que apuntan el cuerpo entero

`adss`, `ciudad`, `material`, `propietario` y `tipoObs` comparten el mismo
`updateX`, línea por línea. Los cinco escriben `after: req.body` **literal**, y
construyen su `before` recorriendo `Object.keys(req.body)`, así que las dos
mitades del diff hablan del cuerpo recibido y no de lo escrito.

**Files:**
- Modify: `src/controllers/adss.controller.ts:61,64`
- Modify: `src/controllers/ciudad.controller.ts:37,43`
- Modify: `src/controllers/material.controller.ts:61,64`
- Modify: `src/controllers/propietario.controller.ts:91,94`
- Modify: `src/controllers/tipoObs.controller.ts:61,64`

**Interfaces:**
- Consumes: `assignable` de `src/utils/authorship.js`, ya importado en los cinco
  (lo metió `ce91b1b`). No hace falta tocar ningún import.

- [ ] **Step 1: Aplicar el mismo cambio en los cinco**

Tomando `ciudad` como ejemplo — los otros cuatro son idénticos salvo el nombre
de la variable y de la entidad. Antes:

```ts
    const beforeCiudad = Object.fromEntries(Object.keys(req.body).map(k => [k, dv[k]]));
    TempCiudad.set(assignable(req.body));
```

Después:

```ts
    // The diff is built from what will actually be written. `assignable` refuses
    // id/createdAt/updatedAt/deletedAt at the write, and an entry that records
    // the refused change is worse than no entry: the bitácora is where a reader
    // goes to find out whether the row was archived.
    const editable = assignable(req.body);
    const beforeCiudad = Object.fromEntries(Object.keys(editable).map(k => [k, dv[k]]));
    TempCiudad.set(editable);
```

Y en la llamada a `logAction`, `after: req.body` pasa a `after: editable`.

**No tocar** las lecturas de `req.body.image` que vienen después para decidir si
se borra la imagen vieja: `assignable` no filtra `image`, así que dan igual, y
cambiarlas es ruido en el diff.

- [ ] **Step 2: Ejecutar el test de forma y ver bajar la lista**

```
cd api && npx vitest run src/controllers/logShape.test.ts
```

Esperado: sigue **FAIL**, pero ahora la lista tiene **un solo** fichero, `obs`.

- [ ] **Step 3: Comprobar que no se rompió nada de los cinco**

```
cd api && npx vitest run
```

Esperado: verde salvo el `logShape` que aún falta por cerrar.

---

## Task 3: `obs`, que construye un diff de verdad pero desde el cuerpo crudo

`updateObs` no escribe `req.body` literal: recorre sus claves comparando contra
la fila. Mismo defecto, otra forma — `deletedAt` entra en el bucle igual.

**Files:**
- Modify: `src/controllers/obs.controller.ts:53-57` y `:69`

- [ ] **Step 1: Filtrar antes del bucle**

Con el mismo comentario que en la tarea 2, añadir antes del bucle:

```ts
    const editable = assignable(req.body);
```

y sustituir dentro del bucle `Object.keys(req.body)` → `Object.keys(editable)` y
`req.body[k]` → `editable[k]`; en el bloque de `id_tipoObs`,
`req.body["id_tipoObs"]` → `editable["id_tipoObs"]`; y en la escritura,
`TempObs.set(assignable(req.body))` → `TempObs.set(editable)`.

- [ ] **Step 2: El test de forma pasa a verde**

```
cd api && npx vitest run src/controllers/logShape.test.ts
```

Esperado: **PASS**. Si aún lista algo, quedó un `req.body` dentro de un
`metadata`.

---

## Task 4: `evento` y `poste`, que el test de forma no puede ver

Los dos construyen su diff desde una variable intermedia, así que hacen falta
tests de comportamiento. Y son los dos que importan más, porque **son los que se
quedan sin guardián cuando A1 borre `updateRevision` y `updateSolucion`.**

**Files:**
- Modify: `src/controllers/evento.controller.ts:263-284` y `:294`
- Modify: `src/controllers/poste.controller.ts:196-218` y `:223`
- Test: `src/controllers/authorship.test.ts`

**Interfaces:**
- Consumes: `withoutAuthor`, ya importado en los dos. Ojo: **no** es `assignable`
  — estos dos modelos sí tienen autor, y `withoutAuthor` quita además
  `id_usuario`.

- [ ] **Step 1: Arreglar primero los mocks, o el fichero de test no carga**

Esto lo encontró la auditoría previa y es la razón por la que la primera versión
de este plan no se podía ejecutar. `authorship.test.ts` no puede importar
`updatePoste` tal como está: `poste.controller.ts` arrastra `AdssModel`,
`AdssPosteModel` y `MaterialModel`, que **no** están mockeados ahí y llaman a
`sequelize.define(...)` al cargarse — y el mock de `sequelize` de ese fichero no
tiene `define`. El resultado no sería un test rojo: sería el fichero entero sin
cargar, con sus quince casos caídos.

Añadir junto a los demás `vi.mock` (líneas 28-66):

```ts
vi.mock("../models/adss.model.js", () => ({ AdssModel: {} }));
vi.mock("../models/adssPoste.model.js", () => ({ AdssPosteModel: { findAll: vi.fn(), create: vi.fn(), destroy: vi.fn() } }));
vi.mock("../models/material.model.js", () => ({ MaterialModel: {} }));
```

Y **dos correcciones más en mocks que ya existen**, o el test fallará por la
razón equivocada:

- El de poste sólo declara `findByPk`, y `updatePoste` llama a `findOne`:

```ts
vi.mock("../models/poste.model.js", () => ({
  PosteModel: { findByPk: vi.fn().mockResolvedValue(null), findOne: vi.fn() },
}));
```

- El de usuario es `{ UsuarioModel: {} }`, y `poste.controller.ts` importa
  además `USUARIO_AS_AUTHOR`, que se usa desplegado con `[...]`:

```ts
vi.mock("../models/usuario.model.js", () => ({ UsuarioModel: {}, USUARIO_AS_AUTHOR: ["id", "name", "lastname"] }));
```

Por último, añadir `updatePoste` al import de la cabecera:

```ts
const { updatePoste } = await import("./poste.controller.js");
```

- [ ] **Step 2: Escribir los dos tests que fallan**

En el `describe("an edit cannot reassign the author")`, después del caso de
`PUT /solucion/:id`:

```ts
  // These two survive A1, and until now they refused the reassignment at the
  // write and recorded it anyway. `updateRevision` and `updateSolucion` did it
  // right and are about to be deleted, so the guard moves here first.
  it("does not tell the bitácora about a refused reassignment, on PUT /evento/:id", async () => {
    const { logAction } = await import("../utils/logAction.js");
    eventoFindOne.mockResolvedValue({
      dataValues: { id: 5, state: false, image: null, id_poste: 1, id_usuario: 3, description: "vieja" },
      set: vi.fn(),
      save: vi.fn(),
    });

    await updateEvento(reqOf({ description: "otra", id_usuario: 9 }, { id: "5" }), resOf());

    const entry = vi.mocked(logAction).mock.calls[0][0];
    const meta = entry.metadata as { before?: Record<string, unknown>; after?: Record<string, unknown> };
    expect(meta.after).not.toHaveProperty("id_usuario");
    expect(meta.before).not.toHaveProperty("id_usuario");
  });

  it("refuses and does not record a reassignment, on PUT /poste/:id", async () => {
    // Two assertions on purpose. `updatePoste` has no test at all today, so this
    // is also the only thing checking that its write drops the author — which is
    // what the deleted `PUT /revision/:id` case used to check for its own.
    const set = vi.fn();
    const { logAction } = await import("../utils/logAction.js");
    const { PosteModel } = await import("../models/poste.model.js");
    vi.mocked(PosteModel.findOne).mockResolvedValue({
      dataValues: { id: 8, name: "P-8", image: null, id_usuario: 3 },
      set,
      save: vi.fn(),
    } as never);

    await updatePoste(reqOf({ name: "P-9", id_usuario: 9 }, { id: "8" }), resOf());

    expect(set.mock.calls[0][0]).not.toHaveProperty("id_usuario");
    const entry = vi.mocked(logAction).mock.calls[0][0];
    const meta = entry.metadata as { before?: Record<string, unknown>; after?: Record<string, unknown> };
    expect(meta.after).not.toHaveProperty("id_usuario");
    expect(meta.before).not.toHaveProperty("id_usuario");
  });
```

- [ ] **Step 3: Ejecutar y comprobar que fallan por la razón correcta**

```
cd api && npx vitest run src/controllers/authorship.test.ts
```

Esperado: los dos nuevos en **FAIL** con `expected { … id_usuario: 9 } not to
have property "id_usuario"`, y **los quince anteriores en verde**. Si el fichero
no carga, o si falla con `TypeError`, es el Step 1 que quedó a medias: volver,
no seguir.

- [ ] **Step 4: Arreglar `updateEvento`**

Tras la desestructuración de `obs_ids` y `state`, añadir:

```ts
    // The diff below is computed from what will actually be written, not from
    // what arrived. `withoutAuthor` refuses `id_usuario` at the write, and a log
    // that records the refused change is worse than no log at all: the bitácora
    // is the one place a reader goes to find out who reassigned a row.
    const editable = withoutAuthor(bodyWithoutObs);
```

Y sustituir `bodyWithoutObs` por `editable` en: el bucle de metadatos
(`Object.keys(...)` y el valor), `avPoste`, `postePresent`, y el
`TempEvento.set(...)`.

**Mientras estás dentro, borra la rama muerta.** `state` se desestructura fuera
unas líneas antes, así que `bodyWithoutObs.state` es `undefined` siempre y el
`if (!wasResolved && bodyWithoutObs.state === true)` no se cumple nunca:
`updateEvento` **no puede emitir `RESOLVE_EVENTO`**, lo emite sólo
`resolverEvento`. Quitar la rama y dejar el `if` del diff. Y si te sobra un
minuto, `src/migrations/20260822000002-add-authorship.ts:24` sigue afirmando lo
contrario en un comentario.

- [ ] **Step 5: Arreglar `updatePoste` igual**

Mismo cambio, con `withoutAuthor(bodyWithoutAdss)`, sustituyendo en el bucle de
metadatos, en el bloque de claves foráneas y en el `set()`.

- [ ] **Step 6: Ejecutar y comprobar que pasan**

```
cd api && npx vitest run src/controllers/authorship.test.ts
cd api && npx vitest run
```

Esperado: verde entero. `evento.lifecycle.test.ts` es el candidato a chillar —
manda `id: 500` en un cuerpo, y `withoutAuthor` ahora lo quita también del diff.
Sólo asserta sobre `state`, así que debería aguantar; si no, mirar antes de
tocar la aserción.

---

## Task 5: Cerrar

- [ ] **Step 1: Avisar a la sesión de roles**

`rol.controller.ts:47,50` tiene el mismo defecto y está en `NOT_OURS`. El cambio
es idéntico al de la tarea 2 y son tres líneas. Que lo hagan ellos y quiten la
entrada.

- [ ] **Step 2: Lint y tipos, por separado**

```
cd api && npm run lint
cd api && npm run typecheck
```

**Por separado, no encadenados.** El baseline de hoy ya es rojo en los dos, y
nada de eso es de esta tarea: `lint` falla en
`src/controllers/rol.controller.test.ts` (sesión de roles) y `typecheck` saca
cinco errores en `src/auth/securityNotice.test.ts` (sesión de autenticación).
Lo que hay que comprobar es que **no aparece ninguno nuevo** en los ficheros
tocados aquí.

- [ ] **Step 3: Suite entera**

```
cd api && npx vitest run
```

- [ ] **Step 4: Commit**

```bash
cd api
git add src/controllers/logShape.test.ts src/controllers/authorship.test.ts \
        src/controllers/adss.controller.ts src/controllers/ciudad.controller.ts \
        src/controllers/material.controller.ts src/controllers/propietario.controller.ts \
        src/controllers/tipoObs.controller.ts src/controllers/obs.controller.ts \
        src/controllers/evento.controller.ts src/controllers/poste.controller.ts
git commit -m "..."
```

El mensaje tiene que decir que `ce91b1b` arregló la escritura y dejó el
registro, no sólo que se cambiaron ocho ficheros.

---

## Auditoría posterior

Tres preguntas, sobre el árbol ya modificado:

1. ¿Queda algún sitio donde el registro de auditoría describa el cuerpo recibido
   y no lo escrito? Incluidas las creaciones, que este plan no ha mirado, y las
   entradas que se construyen con variable intermedia, que el test de forma no
   ve.
2. ¿El test de forma tiene falsos negativos? Concretamente: ¿qué formas de
   escribir un `logAction` se le escapan, y cuántas de ellas existen ya en el
   repositorio?
3. ¿Se rompió algún comportamiento? El cambio quita del diff `id`, `createdAt`,
   `updatedAt` y `deletedAt`, que antes aparecían cuando el cliente los mandaba:
   ¿había alguna pantalla o algún informe leyendo eso de la bitácora?
