# Editor de red — plan de implementación

> **Para quien lo ejecute:** se ejecuta con superpowers:subagent-driven-development, tarea a
> tarea, con revisión tras cada una. Sin commits por tarea.

**Objetivo:** que Tramos abra en un mapa de toda la red que sirve de detalle y de edición —
seleccionar tramos y ciudades, crear tramos y ciudades, renombrar y mover ciudades — y que
la lista actual quede como segundo modo de vista.

**Arquitectura:** una página nueva (`RedPage`) que compone tres piezas: el estado de las
herramientas, que es un reductor puro; el mapa (`RedMap`), que solo dibuja y avisa de lo que
se pulsa; y la tarjeta (`RedPanel`), que muestra y guarda. La selección vive en la dirección
(`?tramo=` / `?ciudad=`). Todo guarda por las rutas de la API que ya existen.

**Tecnología:** React, TypeScript, MapLibre vía `@vis.gl/react-maplibre`, Vitest + Testing
Library. En la API, Express + Sequelize.

**Especificación:** `api/docs/specs/2026-10-10-tramo-como-entidad-design.md`, sección 11.
Maqueta aprobada: https://claude.ai/artifact/85gSZoF8Te9CgQ9tRtQy6m (fuente en
`…/scratchpad/maqueta-editor-red.html`).

## Restricciones globales

- **Sin commits, sin `git add`, sin stash.** Un commit al final, que hace el dueño.
- Otra sesión commitea en `web` bajo `src/pages/menu/inicio`. No se toca nada de esa carpeta.
- Comprobación: `npm run typecheck` (nunca `npx tsc`), `npm run lint`, `npx vitest run <ruta>`.
- **La web no compone el nombre de un tramo**: muestra `tramo.nombre`. La única excepción es
  el título provisional de un tramo que aún no existe (tarea 4), que no se guarda.
- **No se ordena con `localeCompare`.** Los tramos se muestran en el orden en que llegan; las
  ciudades se ordenan con `<` / `>` sobre el nombre.
- **Un tramo no tiene sentido de marcha.** Ningún texto dice inicio, fin, origen, destino, A
  ni B. Los dos campos de ciudad se llaman «Ciudad».
- La aplicación no tiene barrera de errores: una lectura sin guarda de un campo ausente deja
  la pantalla en blanco. `lat`/`lng` de una ciudad se comprueban con `hasCoords` antes de
  dibujar.
- Textos de interfaz en español; código y comentarios en inglés, con las palabras del dominio
  en español como en el resto. Componentes y estilos, los existentes (`components/ui/*`,
  `components/map/*`, `Combobox`, `PermissionGuard`, `can(...)`). Sin dependencias nuevas.
- Colores y tamaños de los puntos y de la línea: `MAP_DOT`, `MAP_RADIUS`, `ROUTE_PAINT`,
  `SUBJECT_PAINT` de `components/map/mapConstants.ts`. Ningún color literal nuevo fuera de
  ese fichero.
- Permisos: `tramos.crear`, `tramos.editar`, `tramos.archivar`, `ciudades.crear`,
  `ciudades.editar`, `ciudades.ver`, `postes.ver`. Lo que el rol no puede hacer no se pinta.

## Lo que debe vigilar la revisión

1. **Respuestas que llegan tarde.** Cambiar de tramo deprisa no puede pintar los postes del
   anterior sobre el nuevo.
2. **Clic que crea sin querer.** En «Seleccionar», un clic en un hueco del mapa no crea nada
   ni abre ningún borrador.
3. **Ciudad sin coordenadas** (`lat`/`lng` nulos o no finitos): no se dibuja, sus tramos no
   trazan línea, y sigue apareciendo en la lista de la tarjeta.
4. **Id de la dirección que no existe** (`?tramo=999999`, `?tramo=abc`): la pantalla abre sin
   selección y limpia el parámetro; no queda en blanco ni en carga eterna.
5. **Rol de solo lectura** (`tramos.ver` y nada más): ve la red, selecciona, y no encuentra
   ni un control de escritura.

---

### Tarea 1: Las ciudades de las opciones de tramo, con coordenadas

**Ficheros:**
- Modificar (api): `src/controllers/opciones.controller.ts` (`getOpcionesTramo`) y la prueba
  que fija la forma de `/api/tramo/options`.
- Modificar (web): `src/api/Tramo.api.ts` (`OpcionesTramo`), `src/api/Ciudad.api.ts` y su
  prueba.

**Interfaces que produce:**

```ts
// web/src/api/Tramo.api.ts
export interface CiudadDeRed { id: number; name: string; lat: number | null; lng: number | null }
export interface OpcionesTramo { ciudad: CiudadDeRed[]; departamento: Departamento[] }

// web/src/api/Ciudad.api.ts
/** Changes only what it is given; the server accepts a partial body. */
export const cambiarCiudad = (id: number, cambios: { name?: string; lat?: number; lng?: number }): Promise<CiudadInterface>
```

**Pasos:**
- [ ] En la API, `getOpcionesTramo` lista las ciudades con la proyección `CIUDAD_DIBUJABLE`
  que ya usa `/api/poste/options`, en lugar de `NOMBRE`. Se actualiza el comentario de
  cabecera de `getOpcionesTramo` si decía que no llevaba coordenadas, y la prueba de forma.
  Prueba primero: `GET /api/tramo/options` responde cada ciudad con `id`, `name`, `lat`, `lng`
  y nada más.
- [ ] En la web, `OpcionesTramo.ciudad` pasa a `CiudadDeRed[]`. `TramoSheet` y `TramosPage`,
  que la consumen, siguen compilando sin cambios de comportamiento.
- [ ] `cambiarCiudad` hace `PUT /api/ciudad/:id` con **solo** las claves recibidas. Pruebas:
  envía `{ name }` sin `lat`/`lng`/`image`; envía `{ lat, lng }` sin `name`; propaga el fallo.
- [ ] `npm run typecheck` y las suites tocadas, en los dos repos.

### Tarea 2: Estado de las herramientas y carga de datos

**Ficheros:**
- Crear: `src/pages/menu/tramo/red/redEstado.ts` y `redEstado.test.ts`
- Crear: `src/pages/menu/tramo/red/useRedData.ts` y `useRedData.test.tsx`

**Interfaces que produce:**

```ts
// redEstado.ts — pure, no React
import type { LatLng } from "../../../../components/map/mapGeo";
import type { TramoConCifras } from "../../../../api/Tramo.api";

export type Modo = "seleccionar" | "tramoNuevo" | "ciudadNueva";
export interface EstadoRed {
  modo: Modo;
  /** Cities picked for a new tramo: none, one or two ids, never the same twice. */
  elegidas: number[];
  /** Where the new city would go. */
  borrador: LatLng | null;
  /** A city being repositioned, with the position it is at now; `movida` once dragged. */
  moviendo: { id: number; lat: number; lng: number; movida: boolean } | null;
}
export const ESTADO_INICIAL: EstadoRed;
export type Accion =
  | { tipo: "modo"; modo: Modo; desde?: number }   // `desde`: start a new tramo from this city
  | { tipo: "elegir"; id: number }                 // map click on a city in tramoNuevo
  | { tipo: "fijar"; hueco: 0 | 1; id: number | null } // the card's two selectors
  | { tipo: "borrador"; punto: LatLng }
  | { tipo: "mover"; id: number; lat: number; lng: number }
  | { tipo: "arrastrar"; punto: LatLng }
  | { tipo: "terminar" };                          // back to "seleccionar", everything cleared
export function reducir(estado: EstadoRed, accion: Accion): EstadoRed;

/** The live tramo between two cities, whichever way round. */
export function tramoEntre(tramos: TramoConCifras[], a: number, b: number): TramoConCifras | undefined;
export function tramosDeCiudad(tramos: TramoConCifras[], idCiudad: number): TramoConCifras[];

// useRedData.ts
export type EstadoCarga = "cargando" | "lista" | "fallo";
export function useRedData(): {
  estado: EstadoCarga;
  tramos: TramoConCifras[];
  ciudades: CiudadDeRed[];
  departamentos: Departamento[];
  recargar: () => Promise<void>;
};
/** The poles of one tramo; empty while `idTramo` is null or `habilitado` is false. */
export function usePostesDelTramo(idTramo: number | null, habilitado: boolean): { postes: PosteInterface[]; cargando: boolean };
```

**Reglas del reductor:**
- `modo` limpia `elegidas`, `borrador` y `moviendo`; con `desde`, `elegidas` queda `[desde]`.
- `elegir`: si el id ya estaba, se quita; con menos de dos, se añade; con dos, sustituye al
  segundo. Fuera de `tramoNuevo` no hace nada.
- `fijar`: pone o quita la ciudad de ese hueco; si la misma ciudad ya ocupaba el otro hueco,
  no se duplica (el otro queda vacío). El resultado no contiene nulos ni repetidos.
- `borrador` solo actúa en `ciudadNueva`; `arrastrar` solo si hay `moviendo`, y marca
  `movida: true`.
- `mover` solo actúa en `seleccionar`. `terminar` devuelve `ESTADO_INICIAL`.

**Carga:**
- `useRedData` pide `getTramos()` y `getOpcionesTramo()` a la vez. `fallo` si cualquiera
  falla (un `toast.error` con `mensajeDeError`). `recargar` repite las dos sin volver a
  `cargando` (la pantalla no parpadea al guardar) y solo la última petición lanzada escribe.
- `usePostesDelTramo` usa `getPostesDelTramo`. Una respuesta de un tramo que ya no es el
  pedido se descarta. Al fallar deja la lista vacía y avisa con un toast.

**Pruebas (escritas enteras, una por regla):**
- [ ] una por cada regla del reductor de arriba, incluida «`elegir` fuera de `tramoNuevo` no
  cambia nada» y «`fijar` la misma ciudad en los dos huecos deja una sola»;
- [ ] `tramoEntre` encuentra el par en los dos sentidos y no confunde un tramo que comparte
  una sola ciudad;
- [ ] `useRedData`: pasa a `lista` con los datos; pasa a `fallo` si las opciones fallan;
  `recargar` no pasa por `cargando`;
- [ ] `usePostesDelTramo`: con dos peticiones en vuelo, si la primera resuelve la última, se
  quedan los postes del segundo tramo; con `habilitado: false` no pide nada.

### Tarea 3: El mapa de la red

**Ficheros:**
- Crear: `src/pages/menu/tramo/red/RedMap.tsx` y `RedMap.test.tsx`
- Crear: `src/pages/menu/tramo/red/redGeo.ts` y `redGeo.test.ts` (lo que se pueda probar sin
  mapa)

**Interfaces:**

```ts
// redGeo.ts — pure
/** One LineString per tramo whose two ends can be drawn; `properties.id` is the tramo id. */
export function lineasDeTramos(
  tramos: TramoConCifras[],
  ciudades: CiudadDeRed[],
  moviendo: EstadoRed["moviendo"],   // the dragged city is read from here, not from `ciudades`
): FeatureCollection<LineString, { id: number }>;
/** What the view should frame: the selection if there is one, otherwise every city. */
export function encuadre(args: {
  tramos: TramoConCifras[]; ciudades: CiudadDeRed[]; tramoSel: number | null; ciudadSel: number | null;
}): LatLng[];

// RedMap.tsx
interface RedMapProps {
  tramos: TramoConCifras[];
  ciudades: CiudadDeRed[];
  tramoSel: number | null;
  ciudadSel: number | null;
  postes: PosteInterface[];
  estado: EstadoRed;
  onTramo: (id: number) => void;
  onCiudad: (id: number) => void;
  /** Any click on the map itself, wherever it lands. The page decides what it means. */
  onMapa: (p: LatLng) => void;
  onArrastre: (p: LatLng) => void;
  onVerPoste: (id: number) => void;
}
```

**Qué dibuja:**
- `BaseMap` con `MapSearch` dentro y `FitView` alimentado por `encuadre` (`duration` 600).
  El encuadre depende solo de la selección y de los datos, nunca de `estado`: elegir
  ciudades, colocar un borrador o arrastrar no mueven la vista.
- **Tramos**: una sola fuente GeoJSON (`red-tramos`) con tres capas: la línea de todos (color
  y opacidad de `ROUTE_PAINT` según el tema, atenuada, ancho 2.5), una capa ancha e invisible
  para acertar con el ratón (ancho 14) y la del seleccionado (filtro por `id`, ancho 5,
  opacidad plena). El clic se registra en el mapa y consulta la capa ancha, como hace
  `MapPointsLayer`; solo actúa en modo `seleccionar` y sin `moviendo`. El cursor pasa a
  puntero sobre una línea.
- **Línea provisional**: discontinua, entre las dos `elegidas`, cuando hay dos.
- **Ciudades**: un `Marker` por ciudad con coordenadas, cuyo contenido es un `<button>` con
  `aria-label` igual al nombre, el punto y la etiqueta. Tres aspectos: normal
  (`MAP_DOT.endpoint`, `MAP_RADIUS.endpoint`), seleccionada o extremo del tramo seleccionado
  (`MAP_DOT.subject`, `MAP_RADIUS.main`) y elegida para un tramo nuevo (igual, con borde más
  grueso). El clic detiene la propagación y llama a `onCiudad`. La etiqueta se ve siempre en
  las destacadas; en las demás, a partir de zoom 7 (se escucha el `zoom` del mapa).
- **Ciudad que se mueve**: su `Marker` es `draggable`; `onDrag` y `onDragEnd` llaman a
  `onArrastre`. Se dibuja en `estado.moviendo`, no en su posición guardada, y sus líneas la
  siguen.
- **Borrador de ciudad**: un `MapPoint` en `estado.borrador` con `MAP_DOT.subject`.
- **Postes**: `MapPointsLayer` (`red-postes`, radio `MAP_RADIUS.secondary`) con los postes
  que tengan coordenadas; la tarjeta del punto muestra el nombre y un botón «Ver poste».
  Si alguna de las pantallas que ya dibujan postes exporta su tarjeta, se reutiliza.

**Pruebas** (con el mismo simulacro de `@vis.gl/react-maplibre` que usan las demás pruebas
de mapas del repo; leer `PosteDetalleMap.test.tsx` antes de escribir):
- [ ] `lineasDeTramos` omite el tramo con un extremo sin coordenadas y usa la posición de
  `moviendo` para la ciudad arrastrada;
- [ ] `encuadre`: tramo seleccionado → sus dos extremos; ciudad seleccionada → ella y sus
  vecinas; nada → todas las ciudades con coordenadas;
- [ ] hay un botón por ciudad con coordenadas y ninguno por la que no las tiene;
- [ ] pulsar una ciudad llama a `onCiudad` con su id;
- [ ] la ciudad en `moviendo` es la única `draggable`;
- [ ] con dos `elegidas` existe la línea provisional y con una no;
- [ ] los postes sin coordenadas no llegan a la capa.

### Tarea 4: La tarjeta

**Ficheros:**
- Crear: `src/pages/menu/tramo/red/RedPanel.tsx` y `RedPanel.test.tsx`
- Crear, si `RedPanel.tsx` pasa de ~350 líneas: un fichero por vista en la misma carpeta
  (`PanelLista.tsx`, `PanelTramo.tsx`, `PanelCiudad.tsx`, `PanelTramoNuevo.tsx`,
  `PanelCiudadNueva.tsx`).

**Interfaz:**

```ts
interface RedPanelProps {
  tramos: TramoConCifras[];
  ciudades: CiudadDeRed[];
  departamentos: Departamento[];
  tramoSel: number | null;
  ciudadSel: number | null;
  estado: EstadoRed;
  despachar: (a: Accion) => void;
  /** null clears the selection and shows the list. */
  onSeleccionar: (s: { tramo: number } | { ciudad: number } | null) => void;
  recargar: () => Promise<void>;
}
```

Los permisos los lee la tarjeta de `SesionContext` con `can(...)`, como `TramosPage`.

**Qué vista se muestra**, por este orden: `tramoNuevo` → tramo nuevo; `ciudadNueva` → ciudad
nueva; hay `tramoSel` → tramo; hay `ciudadSel` → ciudad; si no → lista.

**Lista.** Título «N tramos · M ciudades». Pestañas «Tramos» y «Ciudades». Un buscador que
filtra por nombre sin distinguir mayúsculas. Cada tramo: `nombre` y, atenuado, el
departamento o «Sin departamento». Cada ciudad: nombre y «n tramos»; la que no tiene
coordenadas añade «sin posición». Sin resultados: «Nada con ese nombre.»

**Tramo.** «← Lista». Rótulo «Tramo» y `tramo.nombre` como título. Dos filas «Ciudad», cada
una un botón que selecciona esa ciudad. «Departamento»: con `tramos.editar`, un `Select` con
«Sin departamento» y los nueve, y un botón «Guardar» activo solo si cambió
(`editTramo(id, { id_departamento })`); sin el permiso, texto. «N postes en este tramo»
solo si la fila trae `postes`. Con `tramos.editar`, «Cambiar ciudades» abre `TramoSheet`
con `ciudadesEditables={tramo.postes === 0}`, igual que la lista. Con `tramos.archivar`,
«Archivar» pide confirmación en un `AlertDialog` y llama a `deleteTramo`; el fallo muestra
la frase del servidor (`mensajeDeError`). Tras archivar: sin selección y `recargar`.

**Ciudad.** «← Lista». Rótulo «Ciudad» y el nombre. Con `ciudades.editar`: campo «Nombre» y
«Guardar nombre», activo solo si cambió y no está en blanco (`cambiarCiudad(id, { name })`).
«Tramos que salen de aquí (n)», cada uno un botón que lo selecciona; sin ninguno, «Ninguno
todavía.» Acciones: con `ciudades.editar`, «Mover» (`{ tipo: "mover" }` con su posición);
con `tramos.crear`, «Tramo desde aquí» (`{ tipo: "modo", modo: "tramoNuevo", desde: id }`,
y la selección se limpia); con `ciudades.ver`, enlace «Abrir ficha de la ciudad» a
`/app/ciudades/:id`. **Mientras se mueve**: aviso «Arrastra la ciudad en el mapa. Cambia el
extremo de n tramos; los postes no se mueven.», «Confirmar posición» (inactivo hasta que
`movida`; `cambiarCiudad(id, { lat, lng })`, luego `terminar` y `recargar`) y «Deshacer»
(`terminar`).

**Tramo nuevo.** Rótulo «Tramo nuevo»; el título es «Elige dos ciudades» hasta tener las
dos, y después los dos nombres ordenados con `<` y unidos por « – » (provisional: no se
guarda). Dos `Combobox` rotulados «Ciudad» (el segundo no ofrece la ciudad del primero, y al
revés) que despachan `fijar`. «Departamento» opcional. Si `tramoEntre` encuentra el par:
aviso «Ese tramo ya existe.» con «Abrirlo», y «Guardar tramo» inactivo. «Guardar tramo»
llama a `createTramo({ ciudades, id_departamento })`; al acertar, `terminar`, `recargar` y
selecciona el nuevo. Ante un 409 (`tramoDelConflicto`): si no está archivado, lo selecciona;
si lo está, `toast.error("Ese tramo existe archivado. Recupéralo en Lista › Archivados.")`.
«Cancelar» → `terminar`. Pie: «No hay orden: da igual cuál elijas primero.»

**Ciudad nueva.** Rótulo «Ciudad nueva». Sin `borrador`: «Pincha en el mapa donde va la
ciudad.» y «Guardar ciudad» inactivo. Con él: campo «Nombre» (obligatorio, con foco al
aparecer), la posición en texto con cinco decimales, y «Foto (opcional)» con el
`ImageDropzone` que usa `CiudadSheet`. Si el nombre, recortado y sin distinguir mayúsculas,
coincide con el de una ciudad cargada: aviso «Ya existe una ciudad con ese nombre.» con
«Verla»; no bloquea. «Guardar ciudad»: sube la foto si la hay (`uploadImage`), llama a
`createCiudad({ name, image, lat, lng })` con `image: ""` sin foto; al acertar, `terminar`,
`recargar` y selecciona la ciudad nueva. «Cancelar» → `terminar`.

Todo botón que guarda se desactiva mientras su petición está en vuelo, y todo fallo sale por
`toast.error(mensajeDeError(error, "<frase propia>"))`.

**Pruebas** (escritas enteras):
- [ ] la lista filtra tramos por el buscador y cambia a ciudades con la pestaña;
- [ ] pulsar un tramo de la lista llama a `onSeleccionar({ tramo })`;
- [ ] tramo: «Guardar» inactivo sin cambio; al cambiar el departamento envía
  `{ id_departamento }` y recarga;
- [ ] tramo con postes: «Cambiar ciudades» abre el diálogo con las ciudades bloqueadas;
- [ ] tramo: archivar confirma, llama a `deleteTramo` y limpia la selección; el 409 muestra
  la frase del servidor y no limpia nada;
- [ ] ciudad: «Guardar nombre» inactivo con el nombre igual o en blanco; envía solo `name`;
- [ ] ciudad: «Confirmar posición» inactivo hasta `movida`; envía solo `lat` y `lng`;
- [ ] tramo nuevo: el par existente muestra el aviso y bloquea guardar; «Abrirlo» selecciona;
- [ ] tramo nuevo: guardar envía las dos ciudades y el departamento y selecciona el creado;
- [ ] tramo nuevo: 409 con tramo vivo lo selecciona; 409 con archivado avisa y no selecciona;
- [ ] ciudad nueva: sin borrador no se puede guardar; con nombre en blanco tampoco;
- [ ] ciudad nueva: guarda sin foto con `image: ""`; con foto, sube primero y envía la ruta;
- [ ] ciudad nueva: el nombre repetido avisa y aun así deja guardar;
- [ ] rol con solo `tramos.ver`: en las vistas de tramo y de ciudad no hay ningún botón de
  guardar, mover, archivar, cambiar ciudades ni tramo desde aquí.

### Tarea 5: La página, las direcciones y los dos modos

**Ficheros:**
- Crear: `src/pages/menu/tramo/red/RedPage.tsx` y `RedPage.test.tsx`
- Crear: `src/pages/menu/tramo/VistaTramos.tsx` (el conmutador) y su prueba
- Modificar: `src/App.tsx`, `src/pages/menu/tramo/TramosPage.tsx` y su prueba, y cualquier
  prueba que enumere rutas.

**Qué hace:**
- **Rutas**: `tramos` → `RedPage`; `tramos/lista` → `TramosPage`. Las dos bajo el
  `ModuleRoute` de `tramos` que ya existe. El menú no cambia: sigue apuntando a
  `/app/tramos`.
- **`VistaTramos`**: dos enlaces, «Mapa» y «Lista», con el aspecto de las pestañas de la
  aplicación; el activo lleva `aria-current="page"`. Va en la cabecera de las dos pantallas.
- **`RedPage`**: cabecera con el título «Tramos» y `VistaTramos`; debajo, la rejilla de la
  ficha de poste (leer `PosteDetalle/index.tsx`): mapa a la izquierda, ocupando el alto
  disponible, y la tarjeta a la derecha con ancho fijo; en pantalla estrecha, mapa arriba
  con alto fijo y tarjeta debajo.
  - Lee `?tramo` y `?ciudad` con `useSearchParams`; `tramo` gana si vienen los dos. Con los
    datos ya cargados, un id que no es un entero o no está en la lista se quita de la
    dirección con `replace`. Seleccionar escribe el parámetro (sin `replace`, para que
    «atrás» deshaga la selección) y borra el otro.
  - **Barra de herramientas** sobre el mapa, arriba a la izquierda sin tapar el buscador:
    «Seleccionar», «+ Tramo» (solo con `tramos.crear`), «+ Ciudad» (solo con
    `ciudades.crear`), cada uno con `aria-pressed`. Entrar en «+ Tramo» o «+ Ciudad» limpia
    la selección.
  - **Franja de ayuda** bajo el mapa o sobre su borde inferior, `aria-live="polite"`:
    «Pincha dos ciudades para trazar el tramo.» / «Pincha la otra ciudad.» / «Revisa el
    tramo en la tarjeta y guarda.» / «Pincha en el mapa donde va la ciudad nueva.» /
    «Arrastra la ciudad a su sitio.»; nada en «Seleccionar».
  - **Qué significa cada clic**: en `seleccionar`, ciudad → la selecciona, línea → la
    selecciona, hueco → nada. En `tramoNuevo`, ciudad → `elegir`; línea y hueco → nada. En
    `ciudadNueva`, cualquier clic del mapa → `borrador`; pulsar una ciudad existente → nada.
    Con `moviendo`, ningún clic selecciona.
  - `Esc` despacha `terminar` cuando el modo no es `seleccionar` o hay `moviendo`, salvo que
    haya un diálogo abierto.
  - Postes: `usePostesDelTramo(tramoSel, can(rol, "postes", "ver"))`; «Ver poste» navega a
    `/app/postes/:id`.
  - Estados: `cargando` → el esqueleto que usan las fichas; `fallo` → mensaje con
    «Reintentar».
- **`TramosPage`**: su cabecera incluye `VistaTramos`. En la pestaña de activos, el nombre
  del tramo es un enlace a `/app/tramos?tramo=<id>` con el estilo de enlace de
  `TramoEnlazado`; en archivados sigue siendo texto.

**Pruebas** (`RedMap` simulado en `RedPage.test.tsx`, capturando sus props):
- [ ] `/app/tramos?tramo=5` entrega `tramoSel: 5` al mapa y la tarjeta muestra ese tramo;
- [ ] `?tramo=999` y `?tramo=abc` terminan sin selección y sin el parámetro en la dirección;
- [ ] con `?tramo=5&ciudad=2` gana el tramo;
- [ ] en `seleccionar`, `onMapa` no cambia nada; en `ciudadNueva` deja el borrador;
- [ ] en `tramoNuevo`, `onCiudad` elige y no selecciona; `onTramo` no hace nada;
- [ ] entrar en «+ Tramo» con un tramo seleccionado limpia la dirección;
- [ ] `Esc` en `ciudadNueva` vuelve a `seleccionar`;
- [ ] sin `tramos.crear` no existe «+ Tramo»; sin `ciudades.crear` no existe «+ Ciudad»;
- [ ] sin `postes.ver` no se piden postes;
- [ ] `fallo` muestra «Reintentar» y al pulsarlo vuelve a cargar;
- [ ] `TramosPage`: el nombre de un tramo activo enlaza a `/app/tramos?tramo=<id>` y el de
  uno archivado no es enlace; `VistaTramos` marca «Lista» como actual;
- [ ] la ruta `/app/tramos/lista` monta la lista y `/app/tramos` el mapa.

Al terminar: `npm run typecheck`, `npm run lint`, `npx vitest run` entera y `npm run build`.
