# A1 — Borrar las siete rutas muertas

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** quitar de la API las siete rutas que no llama nadie, sin que se pierda
por el camino ninguna garantía que hoy esté vigilada por un test.

**Architecture:** cuatro borrados independientes —`solucion`, `revision`,
`files`— y un cierre. Cada uno arrastra su parte de dos ficheros de test que
nombran lo que desaparece.

**Prerrequisito duro: [A0](2026-08-26-a0-bitacora-no-apunta-lo-rechazado.md) tiene
que estar hecho.** Dos de las rutas condenadas —`PUT /api/revision/:id` y
`PUT /api/solucion/:id`— eran los únicos sitios del código que, además de
rechazar una reasignación de autoría, se abstenían de apuntarla en la bitácora.
A0 instala esa garantía en los controladores que sobreviven y le pone un test.
Sin A0 delante, este plan no es una limpieza: es una regresión.

**Tech Stack:** TypeScript, Express 4, Sequelize 6, Vitest. Ninguna dependencia
nueva.

**Spec:** [`docs/specs/2026-08-25-estandar-api-design.md`](../specs/2026-08-25-estandar-api-design.md) — §7 (qué se borra y por qué) y §9 (A1).

---

## Global Constraints

- **`/api/solucion` NO desaparece en esta tarea.** Conserva
  `GET /evento/:id_evento`, que tiene consumidor vivo en `web`
  (`useEventoDetalleData.ts` y `EventoSheet.tsx`, ambos con `.catch(() => null)`,
  o sea que un 404 ahí sería **silencioso** y pintaría todo evento resuelto como
  pendiente). El montaje se mueve en D1, no aquí.
- **`routeGuards.test.ts` no se sustituye ni se relaja.** Se le quitan tres
  entradas porque las rutas que nombran dejan de existir, y se le corrige un
  comentario que cuenta. Nada más.
- **No se toca `/api/rol` ni nada de `src/auth/`.** Los llevan otras sesiones.
- **`npm run lint` y `npm run typecheck` ya salen rojos** por ficheros de esas
  otras dos sesiones. Ejecutarlos **por separado**, nunca encadenados con `&&`, y
  comprobar que no aparece nada nuevo en los ficheros tocados aquí.
- **Sólo servidor.** No modifica ni un fichero de `web/`, y no necesita
  despliegue coordinado (§11).
- Un solo commit al final, con los ficheros añadidos por nombre. Nada de
  `git add -A`.
- Código, comentarios y nombres de test en inglés.

---

## Task 1: Borrar las cuatro rutas de `solucion`

**Files:**
- Modify: `src/routes/solucion.routes.ts` — de cinco rutas a una
- Modify: `src/controllers/solucion.controller.ts` — de cinco funciones a una
- Modify: `src/routes/routeGuards.test.ts` — una entrada y un comentario
- Modify: `src/controllers/authorship.test.ts` — dos casos

**Interfaces:**
- Consumes: los tests que A0 dejó en `authorship.test.ts` sobre `updateEvento` y
  `updatePoste`, que ya vigilan la garantía que aquí se pierde. **Comprobar que
  existen antes de empezar**, no darlo por hecho.
- Produces: `solucion.controller.ts` exporta **solamente** `getSolucion_evento`.

- [x] **Step 1: Comprobar que A0 está puesto**

```
cd api && npx vitest run src/controllers/logShape.test.ts
cd api && npx vitest run src/controllers/authorship.test.ts -t "refused reassignment"
```

Esperado: los dos en verde. Si el segundo no encuentra ningún caso, A0 no está
hecho: **parar aquí.**

- [x] **Step 2: Quitar las cuatro rutas**

`src/routes/solucion.routes.ts` queda así, entero:

```ts
import { Router } from "express";
import { getSolucion_evento } from "../controllers/solucion.controller.js";

const router = Router();

// The rest of this CRUD is gone. `POST /api/evento/:id/resolver` writes the
// repair and flips the event's state in one transaction, and `reabrir` undoes
// both; the loose create and delete could only ever do half of that, leaving an
// event fixed but listed as open, or resolved with no record of how. See §7 of
// the API standard spec.
router.get("/evento/:id_evento", getSolucion_evento);

export default router;
```

Fíjate en que **desaparece el import de `requirePermission`**: ya no queda
ninguna ruta con puerta en este router.

- [x] **Step 3: Quitar las cuatro funciones del controlador**

En `src/controllers/solucion.controller.ts`, borrar `getSolucion`,
`createSolucion`, `updateSolucion` y `deleteSolucion`. Queda
`getSolucion_evento` y nada más. Con ellas se quedan huérfanos cinco imports que
tumbarían el lint:

```ts
import { EventoModel } from "../models/evento.model.js";            // ← fuera
import { deleteImageFile } from "../utils/fileUtils.js";            // ← fuera
import { authoredBy, withoutAuthor } from "../utils/authorship.js"; // ← fuera
import { logAction } from "../utils/logAction.js";                  // ← fuera
```

El fichero queda con `Request`/`Response`, `SolucionModel` y
`SOLUCION_PUBLIC_ATTRIBUTES`.

- [x] **Step 4: Quitar la entrada de `routeGuards.test.ts`, y corregir su cuenta**

Borrar de `READ_GATE_NOT_APPLICABLE` la línea `"GET /api/solucion/",`. El caso
«keeps the read exception list honest» calcula las entradas que ya no
corresponden a ninguna ruta montada y falla si sobra alguna: si no se quita, la
suite se pone roja.

Y el comentario de encima de la lista dice «Counted: twenty». Al quitar una
quedan diecinueve. **Ese mismo fichero argumenta en otro sitio contra dejar
cuentas escritas que envejecen**, así que o se corrige el número o se quita la
frase; no se deja mintiendo.

- [x] **Step 5: Quitar los dos casos de `authorship.test.ts`**

- `it("is the session, on POST /solucion", …)`. **Se borra, no se reescribe:**
  la garantía que vigila la sigue vigilando
  `it("is the session on PUT /evento/:id/resolver, which writes the repair
  inline", …)`, que ya existe y sella `id_usuario` campo a campo.
- `it("drops id_usuario from PUT /solucion/:id", …)`. Se borra: su sitio
  equivalente lo cubren los dos casos que A0 dejó puestos.

Del `await import("./solucion.controller.js")` de la cabecera desaparecen
`createSolucion` y `updateSolucion`, y con ellos la línea entera si no queda nada
que importar de ahí.

**No borres el `vi.mock("../models/solucion.model.js", …)`.** Sigue haciendo
falta: `evento.controller.ts` importa ese modelo, y el caso de `resolver` usa su
mock de `create`. Igual con el de `revision.model.js` en la tarea siguiente.

- [x] **Step 6: Comprobar**

```
cd api && grep -cE 'router\.(post|put|delete)\(' src/routes/solucion.routes.ts
cd api && npx vitest run
```

Esperado: `0`, y suite verde. Si `routeGuards.test.ts` sigue rojo, quedó algo sin
quitar.

---

## Task 2: Borrar las dos rutas de escritura de `revision`

**Files:**
- Modify: `src/routes/revision.routes.ts` — dos líneas
- Modify: `src/controllers/revision.controller.ts` — dos funciones
- Modify: `src/routes/routeGuards.test.ts` — dos entradas
- Modify: `src/controllers/authorship.test.ts` — tres casos

- [x] **Step 1: Quitar las dos rutas**

En `src/routes/revision.routes.ts`, borrar `router.put("/:id", …)` y
`router.delete("/:id", …)`. Quedan el `POST /` y el `GET /:id_evento`, los dos
con consumidor vivo. **El comentario de cabecera sobre `editar` frente a `crear`
se queda**: sigue explicando por qué el `POST` pide `editar`, y `requirePermission`
sigue haciendo falta para él.

- [x] **Step 2: Quitar las dos funciones del controlador**

Borrar `updateRevision` y `deleteRevision`. Con `updateRevision` desaparece su
rama `else`, que era un duplicado de `createRevision` inalcanzable a través del
router —`put("/:id")` no casa con un segmento vacío—, y con ella el único uso de
`withoutAuthor` en el fichero: quitarlo del import y dejar `authoredBy`.
`EventoModel` y `logAction` **se quedan**: los usan `eventoRef` y
`createRevision`.

- [x] **Step 3: Quitar las dos entradas de `routeGuards.test.ts`**

De `EVENTOS_GATES`:

```ts
  "PUT /api/revision/:id": "eventos.editar",
  "DELETE /api/revision/:id": "eventos.archivar",
```

El bucle que las recorre empuja `"→ no está montada"` cuando no encuentra la
ruta, y la aserción falla. Sin esto, suite roja.

- [x] **Step 4: Quitar los tres casos de `authorship.test.ts`**

Los nombres exactos, tal como están escritos hoy:

- `it("is the session on the id-less branch of PUT /revision, which also creates", …)`
  — **se borra, no se reescribe.** Su propio comentario dice que vigila código
  inalcanzable; ese código se va con la función.
- `it("drops id_usuario from PUT /revision/:id", …)` — se borra; lo cubre A0.
- `it("does not tell the bitácora about a change it refused", …)` — **éste es el
  que importa.** Se borra porque su sujeto desaparece, pero la garantía que
  vigilaba es exactamente la que A0 instaló en `updateEvento` y `updatePoste`. Si
  el Step 1 de la tarea 1 no dio verde, **no llegues aquí.**

Del `await import("./revision.controller.js")` desaparece `updateRevision`.

- [x] **Step 5: Comprobar**

```
cd api && grep -c 'router\.' src/routes/revision.routes.ts
cd api && npx vitest run
```

Esperado: `2` y verde.

---

## Task 3: Borrar `GET /api/files/`

La más limpia de las siete. `GET /api/files/orphans` devuelve exactamente lo
mismo —`readDiskFiles()`— más un campo diciendo si cada fichero está huérfano y
quién lo usa. Subconjunto estricto, y las dos piden `archivos:ver`.

**Files:**
- Modify: `src/routes/files.routes.ts` — una línea y un nombre del import
- Modify: `src/controllers/files.controller.ts` — una función

- [x] **Step 1: Quitar la ruta y la función**

Borrar `router.get("/", requirePermission("archivos", "ver"), getFiles);` y
`getFiles` del import de arriba. Borrar la función `getFiles` del controlador.

`readDiskFiles` **se queda**: la usan `getOrphanFiles`, `getEntityImageStats` y
las demás.

- [x] **Step 2: Comprobar**

```
cd api && grep -c 'getFiles' src/routes/files.routes.ts src/controllers/files.controller.ts
cd api && npx vitest run
```

Esperado: `0` en los dos ficheros, y verde. `routeGuards.test.ts` no nombra esta
ruta —tiene puerta declarada, así que no está en ninguna lista de excepciones— y
por eso esta tarea no lo toca.

---

## Task 4: Cerrar

- [x] **Step 1: Lint y tipos, por separado**

```
cd api && npm run lint
cd api && npm run typecheck
```

**Nunca encadenados con `&&`.** El baseline ya es rojo en los dos y no es de esta
tarea: `lint` falla en `src/controllers/rol.controller.test.ts` (sesión de roles)
y `typecheck` saca cinco errores en `src/auth/securityNotice.test.ts` (sesión de
autenticación). Lo que hay que comprobar es que **no aparece nada nuevo** en los
ficheros tocados aquí. Si el lint se queja de un import sin usar en uno de ellos,
es uno de los seis huérfanos: buscarlo, no silenciarlo.

- [x] **Step 2: Suite entera**

```
cd api && npx vitest run
```

- [x] **Step 3: Comprobar que la ruta que NO se borra sigue viva**

```
cd api && grep -n 'router\.' src/routes/solucion.routes.ts
```

Esperado: exactamente una línea,
`router.get("/evento/:id_evento", getSolucion_evento);`.

Esto es a mayores: `routeGuards.test.ts` ya la protege sola, porque una lectura
sin puerta que no esté en la lista de excepciones hace fallar la suite. Pero es
el criterio que la primera versión del spec escribió mal —decía que
`/api/solucion` tenía que desaparecer— así que se comprueba a ojo también.

- [x] **Step 4: Commit**

```bash
cd api
git add src/routes/solucion.routes.ts src/routes/revision.routes.ts src/routes/files.routes.ts \
        src/controllers/solucion.controller.ts src/controllers/revision.controller.ts \
        src/controllers/files.controller.ts src/controllers/authorship.test.ts \
        src/routes/routeGuards.test.ts
git commit -m "..."
```

El mensaje: que diga por qué cada una se va —la de `files` es un subconjunto, las
de `solucion` las jubiló `resolver`, las de `revision` nunca tuvieron pantalla— y
que la garantía de las que se borran vive ahora en A0. No sólo «se borraron siete
rutas».

**Nada de `git add -A`:** hay otras dos sesiones escribiendo en este árbol.

---

## Auditoría posterior

Tres preguntas, sobre el árbol ya modificado:

1. ¿Queda algún llamante de las siete, en `api` o en `web`, por una vía que un
   `grep` literal no vea —plantilla, concatenación, cliente genérico—?
2. De cada test borrado: ¿qué regla vigilaba, y quién la vigila ahora? Si alguna
   se quedó sin dueño, es un hallazgo grave y hay que decirlo aunque la suite
   esté verde.
3. ¿`routeGuards.test.ts` cubre lo mismo que antes menos las tres rutas que ya no
   existen, o se relajó algo por el camino —un umbral bajado, una lista
   ampliada—?
