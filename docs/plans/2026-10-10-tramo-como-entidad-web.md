# El tramo como entidad propia — plan de implementación, parte 2: web

> **Para quien lo ejecute:** SUB-SKILL OBLIGATORIA: superpowers:subagent-driven-development
> (recomendada) o superpowers:executing-plans, tarea a tarea. Los pasos llevan casilla
> (`- [ ]`) para ir marcándolos.

**Objetivo:** que la web deje de pensar en «dos ciudades» y trabaje con el tramo que
devuelve la API: pantalla de Tramos, un selector de tramo donde había dos de ciudad, y el
nombre del tramo leído del servidor en todas partes.

**Arquitectura:** la web no compone nada. El nombre (`tramo.nombre`), los dos extremos
(`tramo.ciudades`, ya en el orden del nombre) y el departamento llegan hechos. Un fichero,
`src/lib/tramo.ts`, es el único que sabe leer un tramo de un poste; un cliente,
`src/api/Tramo.api.ts`, el único que habla con `/api/tramo`. Como en la API, el trabajo es
aditivo hasta la última tarea: los tipos conservan los campos viejos, marcados como
obsoletos, mientras se migran las pantallas, y al final se quitan para que `npm run
typecheck` demuestre que nadie los lee.

**Stack:** React, TypeScript (typescript7 para comprobar), Vite, Vitest + Testing Library,
axios, TanStack Table, MapLibre. Repo `web`, rama `isaias`.

**Especificación:** `api/docs/specs/2026-10-10-tramo-como-entidad-design.md` (§6 y §7).
**Parte 1 (API):** `api/docs/plans/2026-10-10-tramo-como-entidad-api.md`, ya construida.

## Restricciones globales

- **Sin commits por tarea.** Un commit al final del arco en cada repo (`api` y `web`), en
  inglés, añadiendo ficheros por nombre. La web y la API salen juntas.
- Antes de editar un fichero, `git status` y `git diff -- <fichero>`: si lleva cambios
  ajenos, no se toca y se avisa.
- Comprobación: `npm run typecheck` (nunca `npx tsc`), `npm run lint`, `npx vitest run`.
- **La web no compone el nombre de un tramo.** Nada de pegar dos nombres de ciudad con
  ` > `, ` - `, ` — `, ` → ` ni con iconos de flecha. Se muestra `tramo.nombre`.
- **No se reordena por `nombre` en el navegador con `localeCompare`**: el servidor ordena
  por código de carácter y las páginas no cuadrarían. Para ordenar una lista local se usa
  la comparación simple `<` / `>`, o se respeta el orden en que llegó.
- **Parámetros vacíos se omiten, no se envían en blanco.** `tramo=""`, `ciudadId=""` y
  `departamento=""` responden 400. «Sin departamento» es `departamento=ninguno`.
- Un tramo o una ciudad pueden llegar archivados dentro de un poste
  (`tramo.archivado === true`, ciudad con nombre). No se ocultan: se pintan igual.
- `tramo.ciudades[i].lat` / `.lng` pueden ser `null`. Todo lo que dibuja comprueba antes.
- Lo que la API responde, tal como es (medido, no supuesto):

```ts
// Un tramo, en cualquier respuesta.
interface Tramo {
  id: number;
  nombre: string;                              // «Potosí – Sucre»
  ciudades: [CiudadDeTramo, CiudadDeTramo];    // en el orden de `nombre`
  id_departamento: number | null;
  departamento: { id: number; name: string } | null;
  archivado: boolean;
}
interface CiudadDeTramo { id: number; name: string | null; lat: number | null; lng: number | null }
```

| Dónde | Forma |
|---|---|
| `GET /api/poste/`, `/api/poste/:id`, poste anidado en evento, en reportes y en el inicio | `id_tramo` y `tramo: Tramo`. Ya no hay `id_ciudadA`, `id_ciudadB`, `ciudadA`, `ciudadB` |
| `POST` / `PUT /api/poste` | devuelven el poste pelado, con `id_tramo` y **sin** `tramo` |
| `GET /api/poste/?tramo=<id>` · `?ciudadId=<id>` | sustituyen a `ciudadA`+`ciudadB`, que ahora responden 400 |
| `GET /api/poste/options` | `{ adss, material, propietario, ciudad, tramos: Tramo[], departamento: {id,name}[] }` |
| `GET /api/reporte/options` | `{ ciudad, adss, material, propietario, obs, tramos: Tramo[] }` |
| `GET /api/tramo/` | sobre de lista; filas `Tramo & { postes?: number }` (`postes` ausente sin `postes.ver`). Parámetros: `archived=true`, `departamento=<id>\|ninguno`, paginación |
| `GET /api/tramo/options` | `{ ciudad: {id,name}[], departamento: {id,name}[] }` (sin coordenadas) |
| `POST /api/tramo` | cuerpo `{ ciudades: [id, id], id_departamento? }` → 201 `Tramo`. 409 `{ message, tramo }` si el par existe (vivo, o archivado y no se tiene `tramos.archivar`) |
| `PUT /api/tramo/:id` | cuerpo `{ id_departamento? , ciudades? }` → 200 `Tramo`; 409 si tiene postes y se cambian las ciudades |
| `DELETE /api/tramo/:id` · `PATCH /api/tramo/:id/restore` | 204; el primero 409 con postes vivos |
| Los seis reportes | parámetro `tramo=<id>` (opcional; obligatorio en Recorrido). `TramoInicial`/`TramoFinal` responden 400 |
| `estado-red` | filas `{ tramo: Tramo, totalPostes, conPendientes, totalPendientes, totalEventos, pctSalud }` |
| `resumen-tiempos` | `{ tramos: { tramo: Tramo, count, avgVisitas, avgDias, minDias, maxDias }[], descartados }` |

## Foco de revisión

1. **Un poste cuyo tramo tiene una ciudad sin coordenadas** (las hay con posición de
   relleno, y `lat`/`lng` pueden ser `null`). Ningún mapa ni `ordenarTramo` puede romper;
   esta aplicación no tiene barrera de errores. → Tareas 1 y 5.
2. **Crear desde el poste un tramo que ya existe.** El 409 trae el tramo: se selecciona y
   se avisa, no se muestra un error. Si llega archivado, se dice que hay que
   desarchivarlo y **no** se selecciona. → Tarea 4.
3. **Un reporte con el selector de tramo en «Todos».** No debe viajar `tramo` en blanco
   (400): se omite. → Tarea 6.
4. **Un rol con `postes.editar` y sin `tramos.crear`.** No ve «Crear tramo nuevo»; el
   formulario sigue funcionando con los tramos que existen. → Tarea 4.
5. **Una pestaña abierta desde antes del corte** que guarda un poste con dos ciudades
   recibe un 400 con una frase; se muestra esa frase, no un fallo genérico. → Tarea 4.

---

## Mapa de ficheros

| Fichero | Qué es |
|---|---|
| `src/lib/tramo.ts` (nuevo) | Leer el nombre y los extremos dibujables de un tramo |
| `src/api/Tramo.api.ts` (nuevo) | Cliente de `/api/tramo` |
| `src/components/dialogs/upsert/TramoSheet.tsx` (nuevo) | Crear y editar un tramo |
| `src/pages/menu/tramo/TramosPage.tsx` (nuevo) | La pantalla Tramos |
| `src/components/TramoCombobox.tsx` (nuevo) | El selector de tramo, compartido por el poste y los reportes |
| `src/interfaces/interfaces.ts`, `src/api/{opciones,Poste,reporte,dashboard}.api.ts` | Tipos y clientes con la forma nueva |
| `src/lib/permissions.ts`, `src/components/menuItems.ts`, `src/App.tsx`, `src/constants/bitacora.ts` | Dar de alta el módulo |
| Pantallas de poste, evento, ciudad, inicio y reportes; `lib/exports/*` | Dejan de leer dos ciudades |
| `src/hooks/useTramoNeighbors.ts` (+ prueba) | Se elimina |

---

### Tarea 1: tipos, cliente y lectura de un tramo (aditivo)

**Ficheros:**
- Crear: `src/lib/tramo.ts`, `src/lib/tramo.test.ts`, `src/api/Tramo.api.ts`,
  `src/api/Tramo.api.test.ts`
- Modificar: `src/interfaces/interfaces.ts`, `src/api/url.ts`, `src/api/opciones.api.ts`,
  `src/api/Poste.api.ts`, `src/api/reporte.api.ts`, `src/api/dashboard.api.ts`

**Interfaces:**
- Produce: tipos `Tramo`, `CiudadDeTramo`, `Departamento`, `TramoConCifras`;
  `nombreDelTramo(poste)`, `extremosDibujables(tramo)`, `puntoDe(ciudad)`;
  `getTramos`, `getTramosArchivados`, `getOpcionesTramo`, `createTramo`, `editTramo`,
  `deleteTramo`, `desarchivarTramo`, `tramoDelConflicto(error)`;
  `getPosteByTramo(idTramo)`; `PosteInterface.id_tramo` / `.tramo`;
  `OpcionesPoste.tramos` / `.departamento`; `OpcionesReporte.tramos: Tramo[]`;
  `ReporteInterface.tramo?`.
- Los campos viejos (`id_ciudadA`, `id_ciudadB`, `ciudadA`, `ciudadB`, `TramoInicial`,
  `TramoFinal`, `TramoPair`, `ciudadAId`…) **se quedan**, opcionales y con `@deprecated`,
  hasta la tarea 7.

- [ ] **Paso 1: prueba de `lib/tramo.ts`**

```ts
import { describe, it, expect } from "vitest";
import { extremosDibujables, nombreDelTramo, puntoDe } from "./tramo";
import type { Tramo } from "../interfaces/interfaces";

const tramo = (extra: Partial<Tramo> = {}): Tramo => ({
  id: 14,
  nombre: "Potosí – Sucre",
  ciudades: [
    { id: 7, name: "Potosí", lat: -19.58, lng: -65.75 },
    { id: 3, name: "Sucre", lat: -19.04, lng: -65.26 },
  ],
  id_departamento: null,
  departamento: null,
  archivado: false,
  ...extra,
});

describe("nombreDelTramo", () => {
  it("shows the name the server sent, untouched", () => {
    expect(nombreDelTramo({ tramo: tramo() })).toBe("Potosí – Sucre");
  });

  it("is empty for a pole that came without its tramo, rather than throwing", () => {
    expect(nombreDelTramo({ tramo: null })).toBe("");
    expect(nombreDelTramo({})).toBe("");
    expect(nombreDelTramo(null)).toBe("");
  });
});

describe("puntoDe", () => {
  it("is a point only when both coordinates are real numbers", () => {
    expect(puntoDe({ id: 1, name: "A", lat: -19, lng: -65 })).toEqual({ lat: -19, lng: -65 });
    expect(puntoDe({ id: 1, name: "A", lat: null, lng: -65 })).toBeNull();
    expect(puntoDe({ id: 1, name: "A", lat: Number.NaN, lng: -65 })).toBeNull();
    expect(puntoDe(null)).toBeNull();
  });
});

describe("extremosDibujables", () => {
  it("hands back the two ends in the order of the name", () => {
    expect(extremosDibujables(tramo())).toEqual([{ lat: -19.58, lng: -65.75 }, { lat: -19.04, lng: -65.26 }]);
  });

  it("keeps the slot of an end that cannot be drawn, as null", () => {
    const t = tramo({ ciudades: [{ id: 7, name: "Potosí", lat: null, lng: null }, { id: 3, name: "Sucre", lat: -19.04, lng: -65.26 }] });
    expect(extremosDibujables(t)).toEqual([null, { lat: -19.04, lng: -65.26 }]);
  });

  it("is two nulls with no tramo", () => {
    expect(extremosDibujables(null)).toEqual([null, null]);
    expect(extremosDibujables(undefined)).toEqual([null, null]);
  });
});
```

- [ ] **Paso 2: verla fallar** — `npx vitest run src/lib/tramo.test.ts`. Esperado: no
  resuelve `./tramo`.

- [ ] **Paso 3: tipos en `interfaces.ts`** — añadir antes de `PosteInterface`:

```ts
/** One end of a tramo. Coordinates can be missing: some cities were never placed. */
export interface CiudadDeTramo {
  id: number;
  name: string | null;
  lat: number | null;
  lng: number | null;
}

export interface Departamento {
  id: number;
  name: string;
}

/**
 * A stretch of line between two cities, as every response carries it.
 *
 * It has no direction. `nombre` and the order of `ciudades` are decided by the
 * server and are the same everywhere; the client shows them and never builds
 * either.
 */
export interface Tramo {
  id: number;
  nombre: string;
  ciudades: [CiudadDeTramo, CiudadDeTramo];
  id_departamento: number | null;
  departamento: Departamento | null;
  archivado: boolean;
}
```

  En `PosteInterface`: `id_tramo?: number;` y `tramo?: Tramo | null;`; `id_ciudadA`,
  `id_ciudadB` pasan a opcionales y, con `ciudadA`/`ciudadB`, llevan
  `/** @deprecated The server no longer sends this. Removed in the last task. */`.
  En `ReporteInterface`: `tramo?: number;`, y `TramoInicial`/`TramoFinal` opcionales y
  `@deprecated`.

- [ ] **Paso 4: `src/lib/tramo.ts`**

```ts
// Reading a tramo. The server names it and orders its two ends; this file is
// the one place the client takes that apart, so that no screen grows its own
// way of turning a pole into "City A <something> City B" again — there were
// five.

import type { CiudadDeTramo, Tramo } from "../interfaces/interfaces";

export interface Punto {
  lat: number;
  lng: number;
}

/** The name of a pole's tramo, or nothing for a pole that came without one. */
export const nombreDelTramo = (poste: { tramo?: Tramo | null } | null | undefined): string =>
  poste?.tramo?.nombre ?? "";

/** A city as a point, when it has one. Some were never placed on the map. */
export const puntoDe = (ciudad: CiudadDeTramo | null | undefined): Punto | null => {
  const lat = ciudad?.lat;
  const lng = ciudad?.lng;
  return typeof lat === "number" && typeof lng === "number" && Number.isFinite(lat) && Number.isFinite(lng)
    ? { lat, lng }
    : null;
};

/**
 * The two ends as points, in the order of the name.
 *
 * Always two slots: `ordenarTramo` takes one end and the other, and a missing
 * end has to stay missing in its own place rather than shift the other one.
 */
export const extremosDibujables = (tramo: Tramo | null | undefined): [Punto | null, Punto | null] =>
  [puntoDe(tramo?.ciudades[0]), puntoDe(tramo?.ciudades[1])];
```

- [ ] **Paso 5: verla pasar.**

- [ ] **Paso 6: `src/api/url.ts`** — `export const urlTramo = "tramo/";` tras `urlCiudad`.

- [ ] **Paso 7: prueba del cliente** — `src/api/Tramo.api.test.ts`, con `vi.mock("axios")`
  como hacen las pruebas vecinas (`opciones.api.test.ts` es el modelo). Casos:

```ts
it("creates with the two cities in the order they were picked, and no department key when none was chosen", async () => {
  // post called with (…/tramo/, { ciudades: [7, 3] })
});
it("sends a department only when one is set, and null to clear it on edit", async () => {
  // create({ciudades:[7,3], id_departamento: 5}) → body has id_departamento: 5
  // editTramo(14, { id_departamento: null }) → put body { id_departamento: null }
});
it("asks for no-department with the word the server expects", async () => {
  // getTramos({ departamento: "ninguno" }) → params.departamento === "ninguno"
});
it("omits the department filter instead of sending it empty", async () => {
  // getTramos({}) → params has no `departamento` key
});
it("reads the tramo out of a 409, and nothing out of any other failure", () => {
  // tramoDelConflicto({ response: { status: 409, data: { message: "…", tramo } } }) → tramo
  // status 400 / no response / 409 without tramo → null
});
```

  Cada cuerpo se escribe entero y afirma lo que dice su comentario.

- [ ] **Paso 8: `src/api/Tramo.api.ts`**

```ts
import axios from "axios";
import { urlApi, urlTramo } from "./url";
import { todasLasFilas } from "./listado";
import type { Departamento, Tramo } from "../interfaces/interfaces";
import type { OpcionSimple } from "./opciones.api";

/** A row of the Tramos screen. `postes` is absent, not zero, without `postes.ver`. */
export interface TramoConCifras extends Tramo {
  postes?: number;
}

export interface OpcionesTramo {
  ciudad: OpcionSimple[];
  departamento: Departamento[];
}

/** `"ninguno"` is the server's word for "has no department"; a number is its id. */
export type FiltroDepartamento = number | "ninguno";

export const getTramos = (filtro: { departamento?: FiltroDepartamento } = {}): Promise<TramoConCifras[]> =>
  todasLasFilas<TramoConCifras>(
    urlApi + urlTramo,
    // Omitted when there is none: an empty value is a 400, not "all of them".
    filtro.departamento === undefined ? {} : { departamento: filtro.departamento },
  );

export const getTramosArchivados = (): Promise<TramoConCifras[]> =>
  todasLasFilas<TramoConCifras>(urlApi + urlTramo, { archived: true });

export const getOpcionesTramo = (): Promise<OpcionesTramo> =>
  axios.get(urlApi + urlTramo + "options").then((r) => r.data as OpcionesTramo);

export interface NuevoTramo {
  /** The two cities, in whatever order they were picked: a tramo has none. */
  ciudades: [number, number];
  id_departamento?: number | null;
}

export const createTramo = (data: NuevoTramo): Promise<Tramo> =>
  axios.post<Tramo>(urlApi + urlTramo, data).then((r) => r.data);

export const editTramo = (
  id: number,
  cambios: { id_departamento?: number | null; ciudades?: [number, number] },
): Promise<Tramo> => axios.put<Tramo>(urlApi + urlTramo + id, cambios).then((r) => r.data);

export const deleteTramo = (id: number): Promise<void> =>
  axios.delete(urlApi + urlTramo + id).then(() => undefined);

export const desarchivarTramo = (id: number): Promise<void> =>
  axios.patch(urlApi + urlTramo + id + "/restore", {}).then(() => undefined);

/**
 * The tramo a 409 came back with: the pair already exists.
 *
 * Creating a tramo that is already there is not a failure for whoever is
 * filling a pole form — it is the answer to what they were looking for. The
 * caller reads `archivado` to tell "use this one" from "somebody has to
 * unarchive this one".
 */
export const tramoDelConflicto = (error: unknown): Tramo | null => {
  const respuesta = (error as { response?: { status?: number; data?: { tramo?: Tramo } } })?.response;
  return respuesta?.status === 409 && respuesta.data?.tramo ? respuesta.data.tramo : null;
};
```

  Comprobar la firma real de `todasLasFilas` en `src/api/listado.ts` antes de escribir las
  dos llamadas (segundo argumento: objeto de parámetros).

- [ ] **Paso 9: los demás clientes.**
  - `opciones.api.ts`: `OpcionesPoste` gana `tramos: Tramo[]; departamento: Departamento[];`.
    `OpcionesReporte.tramos` pasa a `Tramo[]`. `TramoPair` se conserva con `@deprecated`
    solo si algún fichero aún lo importa tras este paso; si no, se borra ya. Actualizar
    los comentarios de cabecera que describen los pares.
  - `Poste.api.ts`: `getPosteByTramo = (idTramo: number) => todasLasFilas(urlApi + urlPoste, { tramo: idTramo })`.
    Sus llamadores se arreglan en las tareas 4 y 6; hasta entonces `typecheck` los marca,
    así que este cambio de firma se hace **junto con** su primer llamador (tarea 4). En
    esta tarea se añade `getPostesDelTramo` con la firma nueva y `getPosteByTramo` queda
    `@deprecated`.
  - `reporte.api.ts`: `EstadoRedRow` y `TiempoTramoRow` ganan `tramo: Tramo`; los cuatro
    campos de ciudad pasan a opcionales `@deprecated`. Los tres `getXxx` de resumen
    aceptan `tramo?: number` en su filtro.
  - `dashboard.api.ts`: `DashboardPoste` gana `tramo?: Tramo | null`; `ciudadA`/`ciudadB`
    `@deprecated`.

- [ ] **Paso 10:** `npm run typecheck`, `npx vitest run src/lib/tramo.test.ts src/api`.
  Las pruebas de `opciones.api.test.ts` (66, 161-162) que fijan pares se actualizan a la
  forma nueva aquí.

---

### Tarea 2: dar de alta el módulo

**Ficheros:** `src/lib/permissions.ts`, `src/components/menuItems.ts`, `src/App.tsx`,
`src/constants/bitacora.ts`, y las pruebas que fijen el vocabulario
(`grep -rln "ciudades" src --include=*.test.*`).

- [ ] **Paso 1: prueba.** En la prueba de permisos existente (o `permissions.test.ts`):

```ts
it("mirrors the server's tramos module, right under ciudades", () => {
  expect(PERMISOS.tramos).toEqual(["ver", "crear", "editar", "archivar"]);
  expect(MODULOS.indexOf("tramos")).toBe(MODULOS.indexOf("ciudades") + 1);
});
```

  y en la de menú: «Tramos» aparece tras «Ciudades», en «Operación», con `modulo: "tramos"`;
  `destinoDeEntidad("Tramo", 14)` devuelve `{ modulo: "tramos", path: "/app/tramos" }` (un
  tramo no tiene ficha: el destino es la lista).

- [ ] **Paso 2: implementar.**
  - `permissions.ts`: `tramos: ["ver", "crear", "editar", "archivar"],` tras `ciudades`.
    Si hay un mapa de etiquetas de módulo, `tramos: "Tramos"`.
  - `menuItems.ts`: `{ text: "Tramos", path: "/app/tramos", icon: Route, modulo: "tramos", seccion: "Operación" },`
    tras Ciudades (`Route` de `lucide-react`; comprobar que no choca con otro import).
  - `App.tsx`: un `<Route element={<ModuleRoute modulo="tramos" />}>` con
    `<Route path="tramos" element={<TramosPage />} />`, tras el bloque de ciudades. La
    página se crea en la tarea 3; en esta tarea el import apunta a un componente mínimo
    que la tarea 3 sustituye — o las tareas 2 y 3 se despachan juntas.
  - `constants/bitacora.ts`: `case "Tramo": return { modulo: "tramos", path: "/app/tramos" };`
    y sus cuatro acciones (`CREATE_TRAMO`, `UPDATE_TRAMO`, `DELETE_TRAMO`,
    `RESTORE_TRAMO`) donde el fichero liste etiquetas de acción, con las mismas palabras
    que el servidor: «Nuevo tramo», «Editó tramo», «Archivó tramo», «Desarchivó tramo».

- [ ] **Paso 3:** `npx vitest run src/lib src/components src/constants`, `npm run typecheck`.

---

### Tarea 3: el diálogo y la pantalla de Tramos

**Ficheros:**
- Crear: `src/components/dialogs/upsert/TramoSheet.tsx` (+ `.test.tsx`),
  `src/pages/menu/tramo/TramosPage.tsx` (+ `.test.tsx`)

**Interfaces:**
- Consume: `Tramo.api.ts`, `FormDialog`, `Combobox`, `DataTable`, `PermissionGuard`.
- Produce:

```ts
interface TramoSheetProps {
  tramo?: Tramo | null;              // presente: editar
  open: boolean;
  setOpen: (v: boolean) => void;
  /** Called with the tramo that now exists: created, edited, or the one a 409 pointed at. */
  onSuccess: (tramo: Tramo) => void;
  /** Lists handed in by a form that already has them; without them the sheet asks `/api/tramo/options`. */
  ciudades?: { id: number; name: string }[];
  departamentos?: Departamento[];
  /** Whether the two cities can be changed. False for a tramo that has poles. */
  ciudadesEditables?: boolean;
}
```

**Modelo a seguir, sin inventar lenguaje visual nuevo:** `CiudadSheet.tsx` para el diálogo
(mismo `FormDialog`, mismos errores bajo el campo, mismo `toast`) y `CiudadesPage.tsx`
para la página (mismas pestañas Activos / Archivados, misma `DataTable`, mismo menú de
fila, mismos `AlertDialog` de archivar y desarchivar). Leerlos enteros antes de empezar.

- [ ] **Paso 1: pruebas del diálogo.** Con `vi.mock("../../../api/Tramo.api")`:

```ts
it("asks for two different cities before it sends anything", async () => { /* same city twice → error under the field, createTramo not called */ });
it("creates with the two cities and the department, and hands the new tramo to onSuccess", async () => {});
it("creates with no department key when none was chosen", async () => {});
it("on a 409 with a live tramo, hands THAT tramo to onSuccess and says it already existed", async () => {
  // createTramo rejects with { response: { status: 409, data: { message, tramo: {…archivado:false} } } }
  // → onSuccess called with it, toast.info mentions it existed, dialog closes
});
it("on a 409 with an archived tramo, selects nothing and shows the server's sentence", async () => {
  // onSuccess NOT called; the message from the server is shown; dialog stays open
});
it("when editing a tramo with poles, shows the cities and does not let them change", async () => {
  // ciudadesEditables={false} → both comboboxes disabled; editTramo called with { id_departamento } only
});
it("uses the lists it was handed and does not ask for options", async () => { /* getOpcionesTramo not called */ });
it("asks for options when it was handed none, and says so when they cannot be read", async () => {});
it("clears the department with null, not by leaving the key out", async () => {});
```

- [ ] **Paso 2: verlas fallar; implementar `TramoSheet`.** Tres campos: «Ciudad» y
  «Ciudad» (dos `Combobox` con la misma etiqueta — no «inicio» ni «fin», no «A» ni «B»;
  cada uno excluye la elegida en el otro) y «Departamento» (`Combobox` con una primera
  opción «Sin departamento»). Título «Nuevo tramo» / «Editar tramo». Bajo los dos
  selectores, cuando hay dos ciudades elegidas, una línea de vista previa con el nombre
  **tal como lo dará el servidor** solo si se puede conocer sin componerlo: al editar se
  muestra `tramo.nombre`; al crear no se muestra nada (la web no compone nombres).

- [ ] **Paso 3: pruebas de la página.**

```ts
it("lists each tramo by the name the server sent, with its department and its pole count", async () => {});
it("shows no pole column for a role that cannot read poles", async () => { /* rows without `postes` → column absent */ });
it("filters by department on the server, and offers 'Sin departamento'", async () => {
  // choosing it → getTramos called with { departamento: "ninguno" }; choosing "Todos" → called with {}
});
it("changes a department from the row and keeps the row in place", async () => {
  // editTramo(id, { id_departamento: 5 }) and the row shows the new name without a full reload
});
it("offers Editar, Archivar only to roles that hold each permission", async () => {});
it("says why when the server refuses to archive a tramo that has poles", async () => { /* 409 → the server's sentence in the toast */ });
it("loads archived tramos only when that tab is opened, and unarchives from there", async () => {});
it("opens the dialog with the cities locked for a tramo that has poles", async () => {
  // row.postes > 0 → TramoSheet gets ciudadesEditables={false}; row without `postes` (no postes.ver) → also locked
});
```

- [ ] **Paso 4: implementar `TramosPage`.** Columnas: nº, Tramo (`nombre`), Departamento
  (editable en la fila con el mismo control que usan las celdas editables de
  `pages/menu/poste/index.tsx` — leer cómo lo hace; es un campo simple con FK directa),
  Postes (solo si la fila trae `postes`), acciones. Sobre la tabla, un selector
  «Departamento: Todos / Sin departamento / los nueve». Sin ficha de detalle: la fila no
  navega. Sin `postes.ver` no se sabe si el tramo tiene postes: las ciudades se bloquean
  en el diálogo y el servidor es quien decide.

- [ ] **Paso 5:** `npx vitest run src/components/dialogs/upsert/TramoSheet.test.tsx src/pages/menu/tramo`,
  `npm run typecheck`, `npm run lint`.

---

### Tarea 4: el selector de tramo y el formulario de poste

**Ficheros:**
- Crear: `src/components/TramoCombobox.tsx` (+ `.test.tsx`)
- Modificar: `src/components/dialogs/upsert/PosteSheet.tsx`, `PosteSheet.test.tsx`,
  `src/api/Poste.api.ts` (retirar `getPosteByTramo` viejo), `src/data/example.ts`

**Interfaces:**

```ts
interface TramoComboboxProps {
  tramos: Tramo[];
  value: number | null;
  onChange: (id: number | null) => void;
  /** Adds a first "Todos los tramos" entry that maps to null. For report filters. */
  permitirTodos?: boolean;
  /** Adds a last "Crear tramo nuevo" entry. Only pass it when the role may create. */
  onCrear?: () => void;
  placeholder?: string;
  disabled?: boolean;
}
```

  Cada opción muestra `nombre` y, **a la derecha en la misma línea y en tono secundario**
  (variante A, elegida por Isaias sobre maqueta el 12 de octubre), el departamento (o «Sin
  departamento»): es lo que distingue dos tramos si algún día
  comparten nombre. El buscador filtra por `nombre`. Las opciones se muestran **en el
  orden en que llegan**.

- [ ] **Paso 1: pruebas del selector** — muestra nombre y departamento; `permitirTodos`
  devuelve `null`; «Crear tramo nuevo» solo existe con `onCrear` y lo llama sin cambiar el
  valor; no reordena la lista recibida.

- [ ] **Paso 2: implementar** sobre `components/ui/combobox.tsx` (leer su API; si no
  admite una acción al pie ni una segunda línea por opción, se añade ahí con su prueba en
  `combobox.test.tsx`, sin cambiar el aspecto de los usos existentes).

- [ ] **Paso 3: pruebas del formulario de poste.** En `PosteSheet.test.tsx`, sustituir lo
  que fija dos ciudades (línea ~99) y añadir:

```ts
it("offers one tramo field, fed by the options, and saves its id", async () => {
  // createPoste called with an object that has id_tramo and has neither id_ciudadA nor id_ciudadB
});
it("refuses to save without a tramo, with one sentence under the field", async () => {});
it("shows 'Crear tramo nuevo' only to a role that may create tramos", async () => {});
it("selects the tramo that was just created and adds it to the list", async () => {});
it("selects the existing tramo when the dialog reports the pair already existed", async () => {});
it("hands the tramo dialog the cities and departments it already has, so it asks for no options of its own", async () => {});
it("draws the two ends of the chosen tramo, and nothing for an end with no coordinates", async () => {});
it("loads the other poles of the tramo by its id when editing", async () => { /* getPostesDelTramo(14) */ });
it("shows the server's sentence when the save is refused", async () => { /* 400 with message → that message */ });
it("counts a changed tramo as a change, for the unsaved-changes guard", async () => {});
```

- [ ] **Paso 4: implementar en `PosteSheet.tsx`.** Con la lista de la auditoría como guía
  (líneas de antes del cambio: 171-189, 207-208, 257-262, 276-277, 287, 293-294, 414-426,
  528-545):
  - Estado: `listTramos` y `listDepartamentos` desde `getOpcionesPoste()`; `listCiudad`
    se conserva (la necesita el diálogo de tramo).
  - Los dos `Combobox` de ciudad → un `TramoCombobox` con etiqueta «Tramo»;
    `onCrear` solo si `can(rol, "tramos", "crear")`.
  - Validación: `if (!data.id_tramo) newErrors.tramo = "Selecciona el tramo";`.
  - El tramo elegido: `const tramo = listTramos.find((t) => t.id === data.id_tramo) ?? poste?.tramo ?? null;`
    (el segundo término cubre un poste cuyo tramo está archivado y no viene en la lista:
    se muestra, deshabilitado para elegirlo de nuevo).
  - Mapa: `const [extremoUno, extremoDos] = extremosDibujables(tramo);` y
    `extremosCreibles(tramoPostes, extremoUno, extremoDos)`; los dos marcadores de ciudad
    se pintan solo si su extremo no es `null`.
  - Postes del tramo: `getPostesDelTramo(poste.id_tramo)`.
  - Al guardar se envía `id_tramo`; no se envían ni se copian al estado campos de ciudad.
  - `data/example.ts`: `posteExample` pierde las dos ciudades y gana `id_tramo: 0`.
  - `<TramoSheet open={crearTramo} … ciudades={listCiudad} departamentos={listDepartamentos}
    onSuccess={(t) => { setListTramos((l) => l.some((x) => x.id === t.id) ? l : [...l, t]); setData((d) => ({ ...d, id_tramo: t.id })); }} />`.
    Es un diálogo sobre otro: comprobar que el foco vuelve al formulario al cerrarlo.

- [ ] **Paso 5:** quitar `getPosteByTramo` de `Poste.api.ts` si ya no tiene llamadores
  (`grep -rn getPosteByTramo src`); si `ReportRecorrido` aún lo usa, se queda hasta la
  tarea 6.

- [ ] **Paso 6:** `npx vitest run src/components`, `npm run typecheck`, `npm run lint`.

---

### Tarea 5: postes, eventos, ciudad e inicio

Una sola tarea porque es el mismo cambio repetido: donde se leían dos ciudades, se lee
`poste.tramo`. Los números de línea son de antes del cambio y sirven para encontrar el
sitio, no como verdad.

**Ficheros y qué le pasa a cada uno:**

| Fichero | Cambio |
|---|---|
| `pages/menu/poste/index.tsx` (381-382, 620-621) | Celda «Tramo»: `nombreDelTramo(poste)`. Si la edición en línea ofrecía las dos ciudades, pasa a un `TramoCombobox` con las opciones de `/poste/options` y guarda `id_tramo`. Filtro por tramo, si existe: `tramo=<id>` |
| `pages/menu/poste/PosteDetalle/index.tsx` (49, 57-64) | `tramoKey` → `poste.id_tramo`; los vecinos se piden con `getPostesDelTramo(poste.id_tramo)` |
| `PosteDetalle/PosteDetalleHeader.tsx` (52-54) | Los dos nombres con icono de flecha → `nombreDelTramo(poste)`, y el departamento al lado si lo hay |
| `PosteDetalle/PosteDetalleMap.tsx` (108-144, 291-293) | Extremos desde `extremosDibujables(poste.tramo)`. «Editar ciudad» recibía la ciudad entera (`onEditarCiudad(poste.ciudadA!)`) y ahora el poste solo trae `id`, `name`, `lat`, `lng`. **Sigue abriendo el diálogo ahí mismo** (decidido por Isaias el 12 de octubre): al pulsar se pide la ciudad completa con `searchCiudad(id)` y se abre `CiudadSheet` con ella; mientras llega, el botón muestra carga; si el servidor responde 403 (rol sin `ciudades.ver`) o falla, se muestra su frase en un aviso y no se abre nada. Prueba para los tres casos |
| `pages/menu/evento/index.tsx` (331-332, 569-570) | Celda y filtro como en postes, sobre `evento.poste` |
| `pages/menu/evento/EventoDetallePage.tsx` (85-89, 259-261, 352-387, 407-408, 433-434, 912-948) | Nombre del tramo, extremos del mapa, y los dos textos con ` → ` |
| `components/dialogs/upsert/EventoSheet.tsx` (268-269, 442) | Etiqueta del poste elegido: `nombreDelTramo(poste)` |
| `pages/menu/ciudad/useCiudadDetalleData.ts` (9-10, 53-56) | Agrupar los postes de la ciudad por `poste.id_tramo` en vez de por `[a,b].sort().join()` |
| `pages/menu/ciudad/CiudadDetallePage.tsx` (316-318, 525-527, 569-570) | Título de cada grupo: `tramo.nombre`; «la otra ciudad» del tramo es `tramo.ciudades.find((c) => c.id !== ciudad.id)` |
| `pages/menu/ciudad/CiudadesPage.tsx` | Sin cambios de comportamiento: `vecinas` y `postes` siguen llegando igual. Solo comprobar |
| `pages/menu/inicio/OperationsMap.tsx` (56-58), `useInicioData.ts` | `nombreDelTramo(poste)` sobre `DashboardPoste.tramo` |
| `lib/tramoOrden.ts` | **La firma no cambia** (`ordenarTramo(postes, uno, otro)` con dos puntos opcionales). Renombrar los parámetros `ciudadA`/`ciudadB` a `extremoUno`/`extremoDos` y corregir los comentarios que hablan de «la recta entre la ciudad A y la B»: ya no hay A ni B, hay dos extremos y se empieza por el primero del nombre |

- [ ] **Paso 1: pruebas primero**, una por fichero donde ya exista prueba
  (`poste/index.test.tsx:83`, `EventoSheet.test.tsx:75`, `tramoOrden.test.ts`,
  `components/map/hasCoords.test.ts:76-89`, `useInicioData.test.tsx`) y nuevas donde el
  fichero no tenga y el cambio no sea trivial (`useCiudadDetalleData`: dos postes del
  mismo `id_tramo` caen en un grupo; un poste sin `tramo` no rompe el agrupado). Cada
  prueba cambiada: el doble del poste lleva `id_tramo` y `tramo`, y la aserción es el
  texto `Potosí – Sucre` tal cual, más la ausencia de ` > `, ` → ` y ` — ` entre nombres.

- [ ] **Paso 2: verlas fallar por el motivo correcto** (el texto esperado no aparece
  porque se sigue componiendo de dos ciudades), implementar fichero a fichero.

- [ ] **Paso 3: barrido.**

```bash
grep -rnE "ciudadA|ciudadB" src --include=*.ts --include=*.tsx | grep -v "\.test\." | grep -vE "pages/landing|LandingPage|pages/menu/reportes|lib/exports|interfaces\.ts|api/"
```

  Esperado: nada. (Los reportes y exportadores son la tarea 6; la página pública usa datos
  inventados y queda fuera.)

- [ ] **Paso 4:** `npx vitest run src/pages/menu/poste src/pages/menu/evento src/pages/menu/ciudad src/pages/menu/inicio src/components src/lib`,
  `npm run typecheck`, `npm run lint`.

---

### Tarea 6: reportes y exportadores

**Ficheros:** `pages/menu/reportes/Report{General,Tramo,EstadoRed,Tiempos,ObsFrecuencia}Sec.tsx`,
`ReportRecorrido.tsx`, sus `.test.tsx`, `fallos.test.ts`, `lib/exports/reportGeneral.ts`,
`lib/exports/reportTramo.ts` y sus pruebas, `lib/reportConfig.test.ts`,
`api/reporte.api.test.ts`; eliminar `hooks/useTramoNeighbors.ts` y su prueba.

**Reglas para las seis pantallas:**
- Un `TramoCombobox` con las opciones de `/api/reporte/options` (`opciones.tramos`).
  Con `permitirTodos` en General, Por tramo, Estado de red, Observaciones y Tiempos; sin
  él en Recorrido, donde el tramo es obligatorio.
- **El filtro lo aplica el servidor.** Hoy General y Por tramo envían `TramoInicial: null`
  y filtran en el navegador por las dos ciudades del poste
  (`ReportGeneralSec.tsx:121-122`, `ReportTramoSec.tsx:136-137`): eso se elimina; se envía
  `tramo` cuando hay uno elegido y **se omite la clave** cuando no.
- Estado de red, Observaciones y Tiempos ganan el selector (la API ya filtra los tres).
- Recorrido: desaparecen «Tramo desde» y «Tramo hasta» (336-351); queda «Tramo». La línea
  y la lista empiezan por `tramo.ciudades[0]`: `ordenarTramo(postes, ...extremosDibujables(tramo))`.
  El título y el nombre del fichero descargado usan `tramo.nombre`.
- Estado de red y Tiempos: la celda del tramo es `row.tramo.nombre`; la clave de fila,
  `row.tramo.id`. Se puede añadir una columna «Departamento»
  (`row.tramo.departamento?.name ?? "—"`) — **no** se añade en esta tarea: la
  especificación deja el departamento en reportes fijos fuera de alcance.
- Exportadores (`reportGeneral.ts:326, 406`, `reportTramo.ts:83-84, 152-157, 410-424, 528`):
  reciben el `Tramo` elegido (o `null`) en lugar de dos nombres; el subtítulo es
  `tramo.nombre`; la celda de cada fila, `nombreDelTramo(evento.poste)`.

- [ ] **Paso 1: pruebas primero.** Por cada pantalla, en su `.test.tsx`:

```ts
it("asks the server for the chosen tramo by its id", async () => { /* getReporteX called with an object whose `tramo` is 14 */ });
it("leaves the key out when no tramo is chosen, rather than sending it empty", async () => {
  // expect(Object.hasOwn(arg, "tramo")).toBe(false); and no TramoInicial / TramoFinal either
});
it("shows the rows it was given without filtering them again in the browser", async () => {
  // rows of two different tramos come back → both are shown (the old client-side filter would hide one)
});
it("names each row's tramo with the server's name", async () => {});
```

  En `ReportRecorrido.test.tsx`: no existen «Tramo desde» ni «Tramo hasta»; no se puede
  generar sin tramo; la línea empieza por el primer extremo del nombre. En
  `reporte.api.test.ts`: los tres resúmenes pasan `tramo` cuando se les da y no lo
  incluyen cuando no. En `fallos.test.ts:26-30` las cadenas fuente fijadas
  (`setTramos([])`) se actualizan a lo que el código hace ahora, comprobando que la prueba
  sigue mordiendo (romper el manejo de fallo un momento y verla fallar).

- [ ] **Paso 2: verlas fallar por el motivo correcto; implementar.** `ReporteInterface`
  queda `{ fechaInicial; fechaFinal; excludeOld?; tramo? }` en los llamadores; el tipo
  conserva los dos campos viejos hasta la tarea 7.

- [ ] **Paso 3:** borrar `useTramoNeighbors.ts` y su prueba (con `rm`; comprobar antes con
  `git status` que no llevan cambios ajenos) y `getPosteByTramo`.

- [ ] **Paso 4:** `npx vitest run src/pages/menu/reportes src/lib/exports src/api src/lib/reportConfig.test.ts`,
  `npm run typecheck`, `npm run lint`.

---

### Tarea 7: retirar lo viejo y verificar

- [ ] **Paso 1:** quitar de `interfaces.ts` `id_ciudadA`, `id_ciudadB`, `ciudadA`,
  `ciudadB` de `PosteInterface` y `TramoInicial`, `TramoFinal` de `ReporteInterface`;
  hacer `id_tramo` obligatorio en `PosteInterface`; quitar `TramoPair` de
  `opciones.api.ts`; quitar los cuatro campos de ciudad de `EstadoRedRow`,
  `TiempoTramoRow` y `DashboardPoste`.

- [ ] **Paso 2:** `npm run typecheck`. Cada error es un consumidor que quedó atrás: se
  arregla en su sitio con su prueba, no con un `as`.

- [ ] **Paso 3: barrido de texto.**

```bash
grep -rnE "id_ciudadA|id_ciudadB|ciudadA|ciudadB|TramoInicial|TramoFinal|TramoPair|useTramoNeighbors|getPosteByTramo" src | grep -vE "pages/landing|LandingPage"
grep -rnE "\\$\\{[^}]*name[^}]*\\} (>|-|—|→) \\$\\{[^}]*name" src | grep -vE "pages/landing|LandingPage"
```

  Esperado en el primero: solo pruebas que afirman la ausencia. En el segundo: nada que
  una dos nombres de ciudad.

- [ ] **Paso 4: comentarios vecinos.** Releer los comentarios de los ficheros tocados que
  hablen de pares, de `/api/poste/tramos`, de «inicio y fin» o de `useTramoNeighbors`, y
  corregir los que ya no sean ciertos.

- [ ] **Paso 5:** `npm run typecheck && npm run lint && npx vitest run && npm run build`.

- [ ] **Paso 6: en navegador, con Isaias.** API y web en local contra `osefi_local` ya
  migrada. Recorrido mínimo, anotando lo visto en cada punto:
  1. Menú: «Tramos» bajo «Ciudades».
  2. Tramos: 84 filas; filtrar «Sin departamento» (84 al principio); asignar un
     departamento en la fila; crear un tramo nuevo; intentar crear uno que existe;
     archivar el nuevo; desarchivarlo.
  3. Postes: la columna Tramo dice «X – Y»; abrir un poste, su cabecera y su mapa.
  4. Nuevo poste: elegir tramo; «Crear tramo nuevo» desde ahí; guardar.
  5. Eventos: lista, ficha y mapa.
  6. Ciudad: ficha de una ciudad con varios tramos.
  7. Inicio: mapa de operaciones.
  8. Reportes: los seis, con y sin tramo; Recorrido con un tramo; descargar uno.
  9. Generador: «Tramo» y «Departamento del tramo» bajo Poste.
  10. Bitácora: las entradas de tramo enlazan a la lista de tramos.
  11. Con un rol sin `tramos.ver`: no hay menú ni ruta; el formulario de poste sigue
      ofreciendo tramos.

  No se da por visto sin esto.

- [ ] **Paso 7: auditoría posterior**, con un agente auditor sobre el diff de la web.

---

## Fuera de alcance

Filtro por departamento en los reportes fijos, en la lista de eventos y en el inicio;
ficha de detalle del tramo; el orden guardado de los postes; la página pública de
presentación.
