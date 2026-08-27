# Auditoría del rediseño de `/app/home`

Fecha: 2026-08-26. Tres agentes adversariales: datos/correctitud, UX/permisos, escala/infraestructura.
Alcance: el diseño propuesto (v2) y el código actual de `web/src/pages/menu/inicio/` + `api/src/controllers/dashboard.controller.ts`.

> **Aviso de método:** el árbol de trabajo estaba sucio y otra sesión lo editaba durante la auditoría
> (`api/src/middleware/authenticate.ts` cambió entre dos lecturas). Todo se reverificó al final contra
> el fichero en disco.

---

## Los números reales

De `api/docs/AUDITORIA-SEGURIDAD.md:287`:

| | Filas |
|---|---|
| Postes | 1.687 |
| Eventos | 1.514 |
| Revisiones | 7.741 |
| Soluciones | 1.071 |

Ratios de producción: **0,9 eventos/poste · 5,1 revisiones/evento · 0,7 soluciones/evento**.
Usuarios totales de la empresa: **20 a 60** (`api/docs/specs/2026-08-21-autenticacion-mfa-design.md:481`).
Concurrencia real: no determinable — la tabla `sesiones` nunca se ha escrito.

Payload actual de `GET /api/dashboard`: **1,6 MiB** sin comprimir (no hay `compression` en el
proyecto, no hay `ETag`, no hay `Cache-Control`, no hay `limit`).

| Postes | Eventos | JSON | Objetos JS | Filas SQL |
|---|---|---|---|---|
| 1.687 (hoy) | 1.518 | 1,6 MiB | 25k | 13,8k |
| 10.000 | 9.000 | 9,4 MiB | 149k | 82k |
| 10.000 | 30.000 | 25,6 MiB | 380k | 250k |
| 50.000 | 150.000 | 127,8 MiB | 1,9M | 1,25M |

El servidor son **4 GB compartidos con Postgres** (`api/src/reportBuilder/export/queue.ts:1-5`).

---

## Veredicto: el rediseño NO puede salir contra el endpoint actual

No por rendimiento — 1.500 filas no son nada. Por dos cosas que son **estructuralmente
imposibles** sobre este payload:

1. **Agrupar por tramo (`ciudadA`–`ciudadB`).** Las ciudades no vienen en el payload del evento
   (`dashboard.controller.ts:19-22`), solo en el del poste (`:36-37`). Hace falta un join en
   cliente por `id_poste`, y ese join **es incorrecto** para los eventos cuyo poste está
   archivado — que el endpoint sigue devolviendo (ver bug 4).
2. **Un mapa con todos los pendientes.** Sin clustering, sin renderizador de canvas: un `<path>`
   SVG por marcador más un objeto `Popup` de Leaflet más 2 escuchadores a nivel de mapa por
   marcador. Los navegadores se atascan en los pocos miles de capas vectoriales SVG.

**La maquinaria para hacerlo bien ya existe en el repo.** `api/src/reportBuilder/` hace exactamente
este trabajo en servidor: agregación SQL (`constraints.ts:19-25`), `SET LOCAL statement_timeout`
por consulta (`execute.ts:31,76`), límites y offsets con binds (`execute.ts:102-110`) y control de
admisión (`export/queue.ts`). Un `GET /api/dashboard/summary` que devuelva ~2 KB de cifras,
cubetas y top-N es **un día de trabajo contra maquinaria ya construida y probada**.

### Cuándo deja de funcionar la versión sin backend

- **Hoy (1.687 postes):** todo bien. Cada cálculo es una pasada sobre ~1.500 elementos.
- **Primer dolor visible: ~8.000-10.000 eventos.** La vista por defecto ya cuesta ~32 pasadas del
  gráfico + ~10 de los KPIs + ~2,3M de asignaciones de `Date` por los escaneos de revisiones. A
  10k eventos son 400-800 ms de hilo principal bloqueado por cambio de período; con los seis
  cálculos nuevos, más de un segundo.
- **Deja de funcionar: ~25.000-30.000 eventos.** En este orden: (a) el mapa pasa de ~5.000
  marcadores SVG y la pestaña deja de responder; (b) el payload pasa de 25 MiB y el servidor de
  4 GB empieza a pelearse con Postgres en refrescos concurrentes; (c) la lista de urgentes sin
  tope renderiza miles de filas en cada cambio de pestaña.
- **Fallo duro: >125.000 eventos.** `Math.min(...allMs)` en `useInicioData.ts:251-252` lanza
  `RangeError: Maximum call stack size exceeded` (medido: 125.000 pasa, 150.000 rompe). Sin
  error boundary en la página, la home se queda en blanco.

---

## Bugs vivos hoy, independientes del rediseño

### 1. `GET /api/dashboard` no comprueba permisos — CONFIRMADO

`api/src/routes/dashboard.routes.ts:6` es un `router.get("/", getDashboard)` desnudo.
`api/src/app.ts:117` lo monta solo tras `authenticate`. Sin `requirePermission`.

Cualquier cuenta con sesión válida —o cualquiera con un token robado— recibe con una sola
petición todos los postes (nombre, lat/lng exactas, propietario, material, ambas ciudades) y
todos los eventos con su historial completo de revisiones y soluciones.

Agravantes, todos confirmados:

- **No es un despiste aislado:** ningún GET de postes, eventos, ciudades ni parámetros está
  gateado. `routeGuards.test.ts:161-176` filtra por `["POST","PUT","PATCH","DELETE"]`, así que los
  GET nunca se comprueban. **El test que debería cazarlo está escrito para no verlo.**
- Pero el dashboard es distinto de los otros GET abiertos: **todos los demás están topados a 100
  filas por página** (`bitacora.controller.ts:8`). Este no tiene `where`, ni `limit`, ni `offset`.
- El token vive 7 días (`login.controller.ts:198`) y **no se puede revocar** — lo dice el propio
  comentario del código en `authenticate.ts:104-107`: *"Every request through here is the old hole,
  still open."*
- No hay limitador de tasa en esta ruta. `express-rate-limit` solo está en `/api/login`
  (`app.ts:112`) y dentro de `generador.routes.ts:27-96`.

### 2. Se pierde trabajo de campo en silencio — CONFIRMADO

Cuatro piezas desalineadas:

| Pieza | Qué exige |
|---|---|
| UI (`OperationsMap.tsx:232`, `:257`) | `eventos.editar` |
| Servidor (`revision.routes.ts:13`) | `eventos.crear` |
| Cliente (`web/src/api/Revision.api.ts`) | `.catch(() => 400)` — nunca lanza |
| Diálogo (`AddRevisionSheet.tsx`) | ignora el valor devuelto y canta `toast.success` |

Un rol con `eventos.ver` + `eventos.editar` y `crear` sin marcar (construible en dos clics desde
Seguridad) ve el botón, escribe la inspección, lee "Revisión agregada" y **no se guarda nada**. El
servidor devolvió 403. Sin rastro, sin aviso.

Arreglo: alinear la puerta del servidor a `eventos.editar` (una revisión es trabajo sobre un
evento existente, no una entidad nueva) y que `createRevision` propague el status y el diálogo lo
compruebe, como ya hace `ResolverEventoSheet`.

### 3. Un fallo de red se pinta como salud perfecta — CONFIRMADO

`useInicioData.ts:63-74`: el `catch` lanza un toast y pone `loading=false`; los datos se quedan en
`null`. Todos los consumidores traducen null a cero: `KpiCards.tsx:80-85`, `TopPostesCard.tsx:62-66`
("No hay incidencias pendientes"), `UrgentEventsCard.tsx:138-146` ("No hay eventos urgentes"),
mapa sin marcadores.

El toast de sonner se va en 4 segundos. Queda una pantalla que afirma **"0 pendientes, todo al
día"**. El estado de fallo es visualmente idéntico al estado más sano posible.

Arreglo: un estado `error` distinto de `loading`, y que la página renderice un bloque de reintento
cuando `listEventos === null && !loading`.

### 4. Un solo poste archivado rompe los porcentajes — CONFIRMADO (con el SQL generado)

`deletePoste` (`poste.controller.ts:279`) es un borrado suave **sin cascada**. Sus eventos
conservan `deletedAt = NULL`. Y el SQL que genera Sequelize 6.36 pone la cláusula paranoid en el
**ON**, no en el WHERE:

```sql
FROM "eventos" AS "evento"
LEFT OUTER JOIN "postes" AS "poste"
  ON "evento"."id_poste" = "poste"."id" AND ("poste"."deletedAt" IS NULL)
WHERE ("evento"."deletedAt" IS NULL);
```

Así que el evento **sobrevive con `poste: null`**. Entonces:

- `useInicioData.ts:99` — `postesConPendientes` se construye con `e.id_poste` sin filtrar nulos:
  cuenta postes que **no están** en `listPostes`.
- `useInicioData.ts:97` — `postesTotal = listPostes.length`, que sí los excluye.
- `KpiCards.tsx:82` — `pctConIncidencias` **sin clamp** (a diferencia de las líneas 217-219, 274-279,
  332-337, que todas usan `Math.min(...,100)`).
- `KpiCards.tsx:116` — renderiza `postesTotal - postesConInc`, que sale **negativo**.
- `KpiCards.tsx:110-111` — la barra no tiene `overflow-hidden` (las otras sí), así que un ancho
  >100% se desborda visiblemente de la tarjeta.

Con un poste archivado que tenga 3 pendientes sobre una base de 1.687: *"1.686 postes · 100% con
incidencias"* y *"1.687 con incidencias · −1 sin incidencias"*.

Nota de incoherencia: la línea 101 **sí** filtra `id_poste != null`; la 99, dos líneas antes, no.

### 5. Reabrir un evento reescribe el histórico — CONFIRMADO

`evento.controller.ts:321-344` — `reabrirEvento` hace `solucion.destroy()`, y `SolucionModel` es
`paranoid` (`solucion.model.ts:31`), así que el include del dashboard deja de verla.

Cierras julio con "47 cerrados". Alguien reabre un evento de julio en agosto. El mismo dashboard,
el mismo período, dice ahora 46. La Bitácora sí lo registra como `REABRIR_EVENTO`, pero nada lo
enlaza desde aquí.

### 6. Lógica de criticidad triplicada, y dos copias no coinciden — CONFIRMADO

| Sitio | Qué es |
|---|---|
| `web/src/lib/criticality.ts:16-26` | Canónico: `CRITICALITY_LEVELS` con etiquetas y clases |
| `useInicioData.ts:288-289` | Reimplementa `getEventCriticality` a mano |
| `UrgentEventsCard.tsx:21-31` | **Tercera copia, con colores distintos** |

Nivel 5: `yellow-500` en el dashboard vs `lime-700` en la librería. Nivel 9: `yellow-300` vs
`blue-700`. El mismo nivel de criticidad se ve de otro color en la home que en el resto de la app.
Y el dashboard muestra el número desnudo en vez de la etiqueta ("Catastrófico").

### 7. Cero tests, y documentación que dice lo contrario de la realidad

`find web/src -name "*.test.*" -path "*inicio*"` → nada. **2.255 líneas** en 11 ficheros con toda
la lógica de agregación de la pantalla principal de la empresa, sin un solo test. Cualquiera de
los hallazgos de datos de esta auditoría lo habría cazado un test unitario.

Y `api/docs/ARCHITECTURE.md:14` describe el endpoint como *"Datos ligeros para la página de
inicio"*, y las líneas 71-72 como *"campos mínimos, evitando los JOINs pesados de los endpoints
completos"*. Devuelve las dos tablas completas con seis modelos incluidos. Quien dimensione trabajo
leyendo ese documento lo dimensionará mal. (El spec más nuevo del propio repo,
`api/docs/specs/2026-08-22-alertas-en-el-header-design.md:105-107`, dice la verdad y lo contradice.)

### 8. Controles que no hacen nada — CONFIRMADO

`ModuleRoute` (`web/src/App.tsx:60-70`) redirige a quien no tiene el `ver` del módulo hacia
`visibleMenuItems(rol)[0]?.path ?? "/app/home"`. Como "Inicio" es siempre el primero y no tiene
módulo (`menuItems.ts:32`), **siempre vuelve al dashboard**. Los botones sin gatear se convierten
en botones que parpadean y no llevan a ningún sitio:

- `[Ver Reportes]` en la cabecera — `inicio/index.tsx:35-39`, sin `can(rol,"reportes","ver")`.
- "Ver detalle" del popup de poste — `OperationsMap.tsx:163-168`.
- "Ver detalle" del popup de evento — `OperationsMap.tsx:217-222`.
- "Ver todos" de Top Postes — `TopPostesCard.tsx:42-49`.

El patrón correcto ya existe dos líneas más arriba, en la línea 40, para `eventos.crear`.

### 9. Otros, menores

- **`UrgentEventsCard.tsx:147` no tiene tope.** Es un `events.map(...)` crudo sin `slice`, y
  `urgentEvents` (`useInicioData.ts:281-283`) es *todo* evento prioritario sin resolver, sin filtro
  de período. `AlertBanner.tsx:26` lo hace bien con `.slice(0, 5)`.
- **`key={i}` en los marcadores del mapa** (`OperationsMap.tsx:121`). Al reordenarse el array
  (cambio de período, de pestaña, refresco) React reutiliza instancias por posición: un popup
  abierto puede acabar apuntando a otro evento.
- **Doble cast que anula el tipado:** `OperationsMap.tsx:251` hace
  `evento={resolverEvento as unknown as EventoInterface}`. Funciona hoy por coincidencia —
  `ResolverEventoSheet` solo lee campos que `DashboardEvento` tiene. El día que ese diálogo lea un
  campo más, rompe en ejecución sin error de compilación.
- **Índices no verificables:** los de `eventos`, `postes`, `revicions` y `eventoObs` que
  `ARCHITECTURE.md:98-105` lista **no están en ninguna migración**. El documento dice "Creados
  manualmente". Si existen en producción, no es determinable desde el repo.

---

## Correcciones al diseño propuesto

### Métricas mal definidas

**«Cerrados» y «Mediana» no son calculables como se especificaron.** Existen eventos con
`state = true` y **cero** soluciones, y el propio código lo reconoce en dos sitios:
`reporte.controller.ts:315` lleva un comentario explicando que usa la última revisión como fecha
de resolución, y `PosteDetalleHealthStrip.tsx:49` hace `sol?.date ?? e.updatedAt`. Ese código no
existiría si toda resolución tuviera solución. Y es alcanzable: `evento.controller.ts:270` hace
`set(bodyWithoutObs)` **sin lista blanca de campos**, y registra `RESOLVE_EVENTO` en ese camino —
un PUT con `{state:true}` resuelve sin crear solución.

> Con 10 eventos entrados y los 10 cerrados así: *"Entraron 10 · Cerrados 0 · Balance −10"*.
> La verdad es Balance 0.

**Arreglo:** cierre = `state === true`; fecha de cierre =
`min(solucions.date) ?? max(revisions.date) ?? updatedAt`.

**Hay CINCO definiciones distintas de "fecha de resolución" en la aplicación:**

| # | Sitio | Fecha de fin | Fecha de inicio |
|---|---|---|---|
| 1 | `useInicioData.ts:42` | `solucions[0].date` | `evento.date` |
| 2 | `reporte.controller.ts:356,374-377` | `max(revisions.date)` | **`createdAt`**, con `Math.max(0,d)` |
| 3 | `evento.controller.ts:43` | `SELECT date FROM solucions LIMIT 1` (**sin ORDER BY**) | — |
| 4 | `PosteDetalleHealthStrip.tsx:48-52` | `solucions[0].date ?? updatedAt` | `evento.date`, negativos fuera |
| 5 | La «Mediana» propuesta | sería una quinta | |

Un evento con `date` = 1 mar, `createdAt` = 5 mar, última revisión el 20 mar y solución el 25 mar:
Reportes dice **15 días**, el detalle del poste dice **24**, la Mediana diría **24**. El mismo
evento, tres pantallas, tres números.

Y hay **vocabulario que ya existe** y no se estaba reutilizando: `ReportGeneralSec.tsx:457-464` ya
distingue *«nuevas»* de *«arrastradas»* con un interruptor y su explicación. "Entraron / Cerrados /
Balance" sería un tercer vocabulario para lo mismo.

**`solucions[0]` es una elección arbitraria.** `dashboard.controller.ts:24` usa `separate: true`
**sin `order`**; el `_findSeparate` de Sequelize emite un `findAll` sin ORDER BY, y Postgres no
garantiza orden sin él (una fila reescrita por UPDATE se mueve en el heap). Con un ciclo
resolver→reabrir→resolver puede haber dos soluciones, y **«Cerrados» cambia entre dos refrescos sin
que cambien los datos**. El backend tiene el mismo bug latente en `evento.controller.ts:43`.

### Dos «Balance» que no pueden coincidir

La serie «pendientes» del gráfico **no** cuenta los eventos creados en cada tramo: cuenta *los
creados en ese tramo que siguen sin resolver hoy* (`useInicioData.ts:144-152`). Con 20 entrados
este mes y 15 ya resueltos:

- Fila de KPIs: Entraron 20, Cerrados 15 → **Balance −5**.
- Gráfico en modo balance, sumado: `solved 15 − pending 5` → **+10**.

Mismo período, mismos datos, treinta centímetros de distancia. Y la serie es **retroactivamente
mutable**: resolver hoy un evento de 2024 encoge la barra de marzo de 2024.

**Arreglo:** que la serie «pendientes» cuente por `e.date` sin mirar el estado.

### Las flechas de tendencia están mal de raíz

Dos fallos independientes, y el diseño pasaría de 3 badges a 7:

**a) Ventana en curso contra ventana completa.** `helpers.ts:16-21` (mes), `:23-29` (trimestre),
`:31-37` (año): el período actual acaba en `now`, el anterior es el calendario completo. El 3 de
agosto, 5 revisados este mes contra 45 en todo julio → **"−89% vs anterior"** en ámbar, con un
ritmo idéntico. *Arreglo:* `prevEnd = prevStart + (now − start)`.

**b) La fórmula se invierte con negativos.** `TrendBadge.tsx:21` —
`pct = prev === 0 ? 100 : Math.round(((current - prev) / prev) * 100)`.

| Caso | Resultado en pantalla | Realidad |
|---|---|---|
| Balance −10 → −5 | **"−50%"**, flecha abajo, ámbar | El backlog se ha reducido a la mitad |
| Balance −3 → +2 | **"−167%"**, ámbar | Déficit convertido en superávit |
| `prev = 0`, `current = 37` | **"+100%"** | Cifra inventada por la línea 21 |
| Mediana 30 → 12 días | −60% con flecha abajo, ámbar | Es la mejor noticia posible |

*Arreglo:* para métricas con signo, delta absoluto (`+5` / `−5`), nunca porcentaje. Y pasar
`invertTrend` en «Entraron» y «Mediana», donde más es peor.

### El orden de la cola tiene un bug de raíz

`Math.min()` sobre un array vacío es `Infinity`, e `Infinity - Infinity` es `NaN`. Hoy
`minCriticality` (`useInicioData.ts:288-289`) solo es seguro porque la lista está **pre-filtrada**
a eventos con al menos una criticidad (línea 291). La cola incluiría *todos* los pendientes, lo que
quita esa guarda.

Un comparador que devuelve `NaN` hace que `sort` sea inconsistente: **el desempate por antigüedad
nunca se aplica**. Si ningún evento tiene observación con criticidad, la cola sale en orden de base
de datos y el técnico atiende lo primero creyendo que es lo más urgente.

Y hay una **tercera convención** en la misma pantalla: `UrgentEventsCard.tsx:37` usa
`(a.criticality ?? 9) - (b.criticality ?? 9)` — nulo tratado como *menos malo*, lo contrario de lo
especificado. Además `ob` es `null` cuando la observación está archivada (`obs.model.ts:27` es
paranoid y `dashboard.controller.ts:29` no pasa `paranoid: false`, a diferencia de
`evento.controller.ts:163`).

**Arreglo:** centinela finito por encima del rango 1..9, precalculado antes de ordenar
(decorate-sort-undecorate). Sin precalcular, con 4.000 pendientes son ~96.000 evaluaciones de
`Math.min` con spread por render; el mismo patrón en `criticalObsEvents` construye ~570.000 arrays
para un solo sort con 20.000 elementos.

### Las cubetas: por `evento.date`, no por última revisión

Razones **decisivas** contra la última revisión:

1. **No tiene cobertura del 100%.** `evento.controller.ts:178` crea la revisión inicial solo
   `if (revision?.description)`. Los eventos nunca tocados —justo los que la zona AHORA existe para
   sacar a la luz— **no tienen fecha de última revisión**. Haría falta una quinta cubeta "sin
   revisar", o sea que no se puede cubetear solo por ese campo.
2. **Es manipulable y esconde el fallo.** Una revisión es una *inspección*, no un arreglo. Pasar
   por delante cada semana mantiene el evento en la cubeta "0-7 días" durante tres años. El riesgo
   no bajó; la métrica dice que sí.
3. **Sería un reloj distinto** del que usa la regla de tier 1 (">90 días") y la columna "días
   abiertos".
4. **La fecha de revisión la escribe el usuario** con el mismo `DatePicker` (hasta +10 años), así
   que puede ser futura o anterior al propio evento.

**Y en su lugar:** «última revisión: N días» / «sin revisar» como **etiqueta** en la fila. Eso
distingue "nadie ha ido" (fallo de despacho) de "fuimos seis veces y sigue roto" (fallo técnico que
hay que escalar, y donde pulsar `[Revisar]` otra vez no arregla nada). `revisions` ya viene en el
payload: una pasada sobre lo que ya está en memoria.

**Disciplina de límites, obligatoria:** derivar la cubeta **y** la escalada a tier 1 del mismo
entero `d = daysOpen(e)`. Si las cubetas usan días redondeados (`d > 90`) y el tier usa una
comparación en milisegundos, discrepan para todo evento entre 90,0 y 91,0 días: se dibuja en la
cubeta "31-90" pero se ordena como si fuera ">90", y filtrar por ">90" esconde un elemento que la
cola trata como >90. Los límites exactos son `0≤d≤7 | 8≤d≤30 | 31≤d≤90 | d≥91`, con `d<0` e
`isNaN(d)` en una quinta cubeta explícita.

### `daysOpen` no tiene guardas

`helpers.ts:50-55` es `Math.floor((Date.now() - new Date(date).getTime()) / 86_400_000)`, sin
ninguna guarda. Y `evento.date` **no tiene `allowNull: false`** (`evento.model.ts:20-22`).

| Entrada | Qué pasa |
|---|---|
| `date` es NULL | `new Date(null)` es **la época, no NaN** → ~20.600 días. Se convierte en el elemento más urgente del sistema, etiquetado "20657 días" |
| `date` no parseable | `NaN` → no cae en ninguna cubeta, pero sigue dentro de `pendGlobal`. Las cubetas suman menos que la cabecera, sin explicación en pantalla |
| Fecha futura (el picker permite +10 años) | `days = -372`. Con `d <= 7` cae en "0-7" etiquetado "−372 días"; con `d >= 0 && d <= 7` no cae en ninguna |
| Creado ayer a las 23:00, visto hoy a las 09:00 | 10 horas → `days = 0` → renderiza **"Hoy"** para un incidente de ayer |

`daysOpen` lo importan cuatro páginas más (`EventoDetallePage.tsx:42`,
`PosteDetalleEventosAbiertos.tsx:9`, `PosteDetalleHealthStrip.tsx:7`, `AlertBanner.tsx:8`):
cualquier cambio de semántica se propaga.

### El mapa: un círculo por EVENTO, no por poste

`useInicioData.ts:328-334` emite un `MapMarker` por evento; `OperationsMap.tsx:113-118` deriva el
color de ese único evento. Un poste con tres pendientes (4, 45 y 200 días) son **tres círculos en
las mismas coordenadas**, y el color visible es el del último que renderiza — el orden del array de
la API. **Un poste con un pendiente de 200 días puede verse verde.** Colorear por antigüedad sin
agregar no mejora el mapa: lo empeora.

Y `hasCoords` (`useInicioData.ts:331`) descarta en silencio los eventos cuyo poste está archivado
(`poste === null`) y cualquier poste legítimamente en lat 0 o lng 0. El badge dirá "312 marcadores"
mientras la cabecera dice 340 pendientes, sin explicación.

**Arreglo:** agregar pendientes por `id_poste`, un marcador por poste coloreado por la **peor**
cubeta de sus eventos, badge "N postes · M eventos". Y `preferCanvas: true` como mínimo — hoy no
está en ningún sitio (`grep` de `preferCanvas`/`L.canvas`/`renderer` en `web/src` no devuelve nada),
así que Leaflet usa el renderizador **SVG**.

### Filtrar «pendientes» por período es incoherente

Las tres tarjetas de desglose estaban bajo el selector de período pero cuentan pendientes, y
"pendiente" es un estado de *ahora*. Con período "15 días", el tramo realmente peor —40 pendientes
arrastrados de 2024— sale **0** y desaparece; se corona como "peor tramo" uno con 2 pendientes
frescos, mientras tres centímetros arriba la cabecera dice "340 pendientes".

**Arreglo:** las tres tarjetas se van a la zona AHORA, sin filtro.

### El tramo hay que normalizarlo

`reporte.controller.ts:224-230` y `:358-364` ya normalizan la clave por `(min(id), max(id))`
precisamente para que `(A,B)` y `(B,A)` colapsen. Sin eso, media línea metida como
`(Oruro, Potosí)` y media como `(Potosí, Oruro)` sale como dos filas con la mitad de cuenta cada
una, y un tramo genuinamente peor las adelanta.

Y hace falta una cubeta **"Sin tramo"** explícita para los eventos cuyo poste está archivado, para
que la columna siempre cuadre con la cabecera. Igual para propietarios archivados
(`propietario.model.ts` es paranoid) — y ojo: `poste.propietario` llega **sin `id`**
(`dashboard.api.ts:16,31`), así que dos propietarios homónimos se fusionan.

Detalle de implementación: **el desglose por propietario NO necesita el join** —
`poste.propietario.name` ya viene en cada evento. Las dos agrupaciones parecen simétricas y no lo
son; confundirlas es exactamente cómo se escribe la versión O(N×M): un
`listPostes.find(p => p.id === e.id_poste)` dentro de una pasada sobre pendientes son
**2,25 × 10⁹ comparaciones** a 45.000 × 50.000, con la pestaña congelada decenas de segundos. Lo
correcto es un `Map<id, poste>` construido una vez.

### Los tipos mienten

`dashboard.api.ts:8,18,19,28` declaran `date: Date`. Pero `:40-43` es un `axios.get(...).then(r =>
r.data)` sin transformación ni reviver: JSON no tiene tipo Date, así que **en ejecución son
strings**. El código actual sobrevive solo porque envuelve cada acceso en `new Date(...)`.

La línea obvia y natural — `e.date >= bounds.start && e.date <= bounds.end` — **compila sin una
queja**: TypeScript ve `Date >= Date`. En ejecución el operador relacional coacciona ambos lados a
número, el string da `NaN`, y **las dos comparaciones son `false` para todas las filas**.
«Entraron: 0» para siempre, sin ningún error en ninguna parte.

**Arreglo:** declarar esos campos `string` y normalizar una vez en la frontera del hook.

### `getPeriodBounds("custom")` es una mina armada

`helpers.ts:39-41` devuelve `{start: now, end: now, prevStart: now, prevEnd: now}`. Hoy es
inalcanzable: `useInicioData.ts:78-86` intercepta `"custom"` antes de llamar, y `getPeriodBounds`
tiene exactamente un sitio de llamada.

Por qué es peligrosa: `useInicioData.ts:52` pone `useState<Period>("custom")` — **custom es el
valor por defecto**. La forma natural de partir el hook es extraer un
`usePeriodBounds(period, customRange)`; si quien lo haga llama `getPeriodBounds(period)` para todas
las ramas, entonces `inCurr = d => d >= now && d <= now` y **la primera carga de todos los usuarios
muestra ceros en toda la zona del período**. Sin error, y sin ningún test que lo cace.

**Arreglo:** borrar la rama, o que lance.

### Los rangos personalizados pierden el último día

`date-range-picker` devuelve `to` a **medianoche local**, `KpiCards.tsx:39-47` lo guarda tal cual, y
`useInicioData.ts:90` filtra con `d <= bounds.end`. Un evento del día 22 a las 09:30 queda **fuera**
de Entraron/Cerrados/revisados/solucionados/nuevos/top-postes/mapa, pero **dentro** del gráfico,
que sí construye el día completo (`:192-195`). Las barras suman 21 y la cifra dice 20.
*Arreglo:* `end: endOfDay(range.to)`.

### Dos relojes en la misma página

`bounds` congela `now` en un `useMemo` con deps `[period, customRange]`; `daysOpen` y
`criticalAlerts` llaman `Date.now()` fresco. Un dashboard de sala de control abierto toda la noche:
a las 09:00 las cubetas han envejecido correctamente, pero «Entraron» sigue acabando en la marca de
tiempo de ayer, así que los incidentes de hoy son invisibles en CÓMO VAMOS y visibles en AHORA. Con
`period === "month"` cruzando fin de mes, el gráfico sigue dibujando el número de días del mes
anterior.

El `eslint-disable` de `useInicioData.ts:265` tapa exactamente esa dependencia. Valoración: **no es
dañino hoy, pero es de carga** — `customRange` sí está cubierto transitivamente porque `bounds` se
reconstruye con identidad nueva; `now` es la staleness real, y es de severidad baja. Lo que importa
es que la regla dejaría de fallar el día que alguien añada una rama que lea `customRange` por un
camino del que `bounds` no dependa — que es justo lo que invita "añade cubetas y una mediana". El
arreglo no es añadir deps: es hacer `chartData` una función pura de argumentos explícitos.

### `period === "all"` no tiene período anterior

`helpers.ts:42-47` devuelve para `"all"` un `prevStart`/`prevEnd` **idéntico byte a byte** al actual,
y `useInicioData.ts:90-91` hace que `inCurr` e `inPrev` sean ambos `() => true`, así que
`postesRevisadosPrev === postesRevisadosCurr` exactamente. Lo único que lo esconde es el booleano
`showTrend` de la línea 277.

Con 7 badges nuevos, olvidar propagar `showTrend` a uno solo hace que muestre **"Sin cambio"**
(`TrendBadge.tsx:34`) — que parece una respuesta real, no un "no aplica".

Y en "Todo" el gráfico filtra desde el 1 de enero de 2020 (`:250-252`) mientras los KPIs pasan de
ese límite con `() => true`: cualquier evento anterior a 2020 —o con fecha nula, que se convierte en
1970— cuenta en las cifras pero **no tiene barra en el gráfico**, permanentemente.

### La mediana no tiene comportamiento definido en los bordes

`evento.controller.ts:378` — `date: date ?? new Date()`: la fecha de la solución viene **directa del
body, sin validar contra `evento.date`**, y el selector de `ResolverEventoSheet.tsx:103` permite
cualquier fecha. Las otras dos implementaciones sí se defienden (`reporte.controller.ts:377` con
`Math.max(0, dias)`, `PosteDetalleHealthStrip.tsx:51` descartando con `ms > 0`).

- Cero cerrados en el período → `sorted[Math.floor(0/2)]` es `undefined` → **"undefined días"**.
- Duraciones de 10 y −40 días → mediana **−15 días** en pantalla.
- Muestra par → `(a+b)/2` → **"12,5 días"**, sin redondeo especificado.
- Muestra de n=1 → una "mediana" que es un solo caso, con flecha de tendencia: ruido presentado
  como señal.

### Quitar el AlertBanner: subconjunto sí, posición no

El predicado del banner (`priority ∧ ¬state ∧ edad ≥ 7`) es un subconjunto estricto de la cola. Pero
el subconjunto es de conjuntos, no de posiciones: un prioritario de 300 días **sin observaciones**
tiene criticidad nula → ordena **al final del tier 1**, o sea posición ~40 de una cola que muestra
10. Antes era imposible no verlo, arriba de la página, sin filtrar (`index.tsx:60`).

**Arreglo:** anclar `priority ∧ edad ≥ 90` incondicionalmente en cabeza de tier 1, por delante del
orden por criticidad. Y el escalón de **7 días** para prioritarios se mantiene como nivel propio —
al matar el banner se perdía la única señal a 7 días de la aplicación.

**Y una corrección de operador:** la regla es `prioritario **O** más de 90 días`, no `Y`. Escrito con
"Y", un prioritario de 8 días cae del tier superior a la masa — exactamente el caso para el que
existía el banner.

### Permisos en la cola

| Rol | `[Revisar]` (servidor: `eventos.crear`) | `[Resolver]` (servidor: `eventos.editar`) | Resultado |
|---|---|---|---|
| VIEWER (rol 3) | oculto, o panel "Sin acceso" | ídem | ~20 trampas por carga si no se gatea |
| Custom `ver` sin `editar` | oculto | oculto | **columna "Acción" vacía en 10 filas** |
| Custom `ver+editar` sin `crear` | **visible y roto en silencio** | funciona | pérdida de trabajo |
| EDITOR (rol 2) | funciona | funciona | correcto |

Para VIEWER hace falta un fallback `[Ver]` — que es lo que hace hoy `UrgentEventsCard.tsx:156-165`,
sin gatear porque navegar no escribe.

### Persistir el período: dos regresiones

**a) Las siete flechas desaparecen para siempre.** `showTrend = period !== "all"`. Quien pruebe
"Todo" una vez guarda `"all"`, y en todas las visitas futuras las siete métricas salen sin flecha,
sin explicación.

**b) Pantalla blanca al rehidratar.** El defecto es `period="custom"` con un `customRange` de
objetos `Date`, y `bounds` llama `.getTime()` (`useInicioData.ts:80`) más `.getDate()`/
`.getFullYear()` en `:192, :197, :221, :237-238, :274`. `JSON.stringify` de un `Date` da string; sin
revivir, la primera línea que se ejecuta lanza `TypeError: customRange.end.getTime is not a
function`. Pantalla blanca en la home, que es donde aterriza todo el mundo.

**Arreglo:** no persistir `"all"` ni `"custom"`; guardar ISO y validar al leer
(`PERIOD_LABELS[stored] ? stored : "month"`, y `new Date(iso)` con respaldo si `isNaN`).

### Responsive: los breakpoints mienten

El ancho del sidebar es **arrastrable entre 160 y 340 px y se guarda en localStorage**
(`web/src/components/ui/sidebar.tsx:32-34, 72-79`), pero todas las decisiones de layout son de
**viewport**: `sm:grid-cols-2` (`KpiCards.tsx:78`), `sm:grid-cols-3` (`:209`), `lg:grid-cols-2`
(`index.tsx:66`), `md:grid-cols-2` (`TopPostesCard.tsx:68`).

A 1280 px con el sidebar a 340: ancho real ≈ 860 px, pero Tailwind sigue viendo `lg`. Tres tarjetas
de desglose a `lg:grid-cols-3` salen a **287 px cada una**, con "Santa Cruz de la Sierra →
Cochabamba" dentro.

Y algo más embarazoso: `inicio/index.tsx:26` declara `@container/card` —igual que las otras once
páginas— y **no hay ni una sola variante `@` usada en todo `web/src`** (verificado por grep). La
infraestructura de container queries está declarada y muerta. Es exactamente la herramienta que
haría falta aquí.

En móvil de 375 px el ancho útil es 327 px (el sidebar pasa a offcanvas bajo 768 px,
`use-mobile.ts`):

- 4 cubetas en fila con `gap-3` → **73 px** por celda. "31-90 días" no cabe.
- Fila de 4 métricas: el precedente del repo ya va apurado con **tres** a partir de 640 px, con
  `whitespace-nowrap` en las etiquetas (`KpiCards.tsx:312-313`). Cuatro no entran.
- La cola: el patrón existente esconde columnas en móvil (`UrgentEventsCard.tsx:122-125`). Aplicado
  aquí desaparecería **"días abiertos" — que es la clave de ordenación y el fundamento del diseño**:
  una lista ordenada por un criterio invisible.

**Plan mínimo:** usar el `@container/card` que ya está declarado, en vez de breakpoints de viewport.
Cubetas `grid-cols-2 @lg:grid-cols-4` (2×2 en móvil). TRABAJO `grid-cols-2 @2xl:grid-cols-4`; nunca
4 en `sm`. Desglose `grid-cols-1 @lg:grid-cols-2 @4xl:grid-cols-3`, tramo en dos líneas. En móvil,
mantener días abiertos y el chip de criticidad; una acción primaria + `DropdownMenu` (patrón que ya
existe en `evento/index.tsx`). Mapa `h-64 @lg:h-96`. Y probar **a 640 px con el sidebar a 340**, que
es donde se rompe y donde nadie mira.

### El ámbito del período: la proximidad no basta

La afirmación "el selector dentro de la zona hace evidente qué gobierna" es falsa por construcción:
la zona CÓMO VAMOS mide, en escritorio, dos filas de tarjetas + un gráfico de 350 px
(`ActivityChart.tsx:149`) + tres tarjetas. Es **más de una pantalla**. Cuando alguien mira "Peor
tramo", el selector que lo gobierna está fuera del viewport.

Y el mapa es peor de lo que admitía la propuesta: un `SegmentedControl` de tres pestañas donde una
ignora el período y dos lo obedecen no es ambiguo, es **incorrecto** — un control segmentado
comunica "lo mismo visto de otra forma", así que invita a comparar "Pendientes 187" (histórico)
contra "Solucionados 43" (un mes). Y encima "Revisados" pinta **postes** mientras las otras dos
pintan **eventos** (`useInicioData.ts:322-341`): un control, tres significados.

**Mejor:** partir el mapa. Uno "Pendientes ahora" en la zona AHORA, sin selector. Otro "Actividad
del período" abajo con dos pestañas que sí lo obedecen. Más: una etiqueta permanente de ámbito en
cada tarjeta ("1–31 jul" o "ahora") — 12 px de texto que **sobreviven al scroll**, que es lo que la
proximidad no hace; `xAxisLabel` ya calcula ese string (`useInicioData.ts:268-275`). Y cabecera de
zona *sticky*: el `<main>` ya es el único scroller con altura definida.

### El mapa a ancho completo secuestra el scroll

`OperationsMap.tsx:111` tiene `scrollWheelZoom={true}`, y la app tiene **un único** contenedor de
scroll (`HomePage.tsx`: `<main className="flex flex-1 flex-col min-h-0 overflow-auto">` dentro de un
`h-svh overflow-hidden`). Hoy el mapa ocupa media fila, así que siempre queda un pasillo por donde
bajar. A ancho completo el pasillo desaparece: bajar de AHORA a CÓMO VAMOS pasa obligatoriamente el
cursor por encima del mapa, y la rueda hace zoom. En táctil, arrastrar panea.

Y el "scroll interno" de la cola es un segundo scroller dentro del único de la app: en móvil un dedo
sobre la cola no baja la página hasta que la cola llega a su fondo. *Arreglo:*
`scrollWheelZoom={false}` con activación por clic, y "mostrar 10 · ver más" en vez de scroll interno.

### El clic en las cubetas es un callejón sin salida

`web/src/pages/menu/evento/index.tsx:226-234` guarda `innerTab`, `activeFilters`, `page` y `sorting`
en `useState` local: no hay `useSearchParams` ni `location.state` en todo el directorio.

Pulsas ">90 días", ves 34 filas, pulsas "Ver todos →" para trabajarlas… y aterrizas en la página 1
de Eventos, 15 filas, sin filtrar, mezclando resueltos y pendientes. Y esa pantalla **no tiene
filtro de días abiertos**, así que no puedes reconstruirlo ni a mano. Sin `useSearchParams` en
Eventos, la zona AHORA no lleva a ningún sitio.

### La celda ">90" en rojo permanente

La app ya trata las "arrastradas" como algo normal y esperado (`ReportGeneralSec.tsx:485-489`). En
cualquier operación real, ">90" nunca es cero, así que una celda roja siempre es indistinguible de
un indicador averiado — y entrena a la gente a ignorar el rojo en la pantalla donde el rojo debería
significar algo. *Arreglo:* rojo por umbral acordado (por ejemplo, ">90 creciendo respecto al
período anterior").

---

## Lo que faltaba en el diseño

### 1. «Mi trabajo» — lo único que le habla al técnico

Todo el diseño es una vista de equipo. Nada dice qué le toca o qué ha hecho **esta** persona, que es
la única pregunta que un técnico trae al abrir la app. Y está todo listo, con los permisos ya
resueltos:

- `GET /api/bitacora/:id_usuario` está protegido por
  `requireSelfOrPermission("bitacora","ver","id_usuario")` (`api/src/routes/bitacora.routes.ts:19`):
  **cualquiera puede leer su propia actividad sin necesitar `bitacora.ver`**.
- `GET /api/evento/usuario/:id_usuario` existe (`api/src/routes/evento.routes.ts:25`).
- `logAction` ya registra `ADD_REVISION`, `RESOLVE_EVENTO` y `CREATE_EVENTO` con severidad, y la
  Bitácora ya tiene etiquetas y colores para todas (`web/src/constants/bitacora.ts`).

Con eso: *"Hoy: 4 revisiones, 2 resueltos · 6 eventos tuyos siguen pendientes"*. Cero endpoints
nuevos, cero cambios de permisos. Y es lo que hace **defendible** la decisión de una sola página
para todos: el técnico tiene algo suyo arriba, en vez de un backlog de equipo que no puede abarcar.

### 2. Partir la cola por «¿ya fuimos?»

`e.revisions` ya viene en el payload. Un pendiente **sin ninguna revisión** significa "nadie ha
ido": es un fallo de despacho. Uno con seis revisiones significa "fuimos y sigue roto": es un fallo
técnico que hay que escalar, y `[Revisar]` por séptima vez no lo arregla. Son dos problemas
distintos con dos acciones distintas, y el diseño les ponía los mismos dos botones. Coste: una
pasada sobre lo que ya está en memoria.

### 3. Cobertura negativa: qué NO se ha visitado

La fila COBERTURA cuenta revisados/solucionados/nuevos. La pregunta del supervisor es la inversa:
qué tramo lleva más tiempo sin que pase nadie. Ya se calcula media respuesta —
`useInicioData.ts:323` construye `revisedPosteIds`; el complemento contra `listPostes` son los
postes sin tocar. Y Reportes ya tiene el concepto de salud por tramo (`EstadoRedRow.pctSalud`), así
que el vocabulario existe.

### 4. Reaperturas

`reabrirEvento` existe, la Bitácora lo registra como `REABRIR_EVENTO` y tiene su propio estilo de
badge. Un evento cerrado que se reabre es un arreglo que falló: es **la única métrica de calidad**
disponible en todo el sistema — el resto son de volumen. Y haría visible el hallazgo de reescritura
del histórico en lugar de dejarlo corrompiendo tendencias en silencio.

**Prioridad: 1 > 2 > 3 > 4.** Si solo entra una, la 1.

---

## Cómo partir `useInicioData`

23 valores devueltos a 6 componentes, cuatro asuntos sin relación en 353 líneas. Consecuencia
concreta: `mapTab` está en el array de dependencias de `mapMarkers` (`:342`), así que **pulsar la
pestaña "Pendientes" del mapa vuelve a escanear todos los eventos**, aunque nada de los KPIs haya
cambiado. Y `setDataPoste` desde el popup re-renderiza la página entera, gráfico incluido.

| Unidad | Qué posee |
|---|---|
| `useDashboardData()` | `{eventos, postes, loading, error, load}`. Solo el fetch. **Es la costura donde entra el endpoint de agregados sin que ningún consumidor cambie** |
| `usePeriod()` | `{period, setPeriod, customRange, setCustomRange, bounds, xAxisLabel, showTrend}`. Posee la rama custom-vs-preset, así que la mina de `getPeriodBounds` tiene **un solo sitio** donde poder estar mal |
| `selectors.ts` | Funciones **puras** `(eventos, postes, bounds) => valor`: `selectKpis`, `selectChartSeries`, `selectAging`, `selectRiskQueue`, `selectByTramo`, `selectByPropietario`, `selectTopPostes`, `selectMapMarkers`. Puras ⇒ **testeables sin React**, que es justo lo que hoy no se puede |
| `useDashboardIndex(eventos, postes)` | El `Map<id, poste>` y un `Map<posteId, evento[]>`, memoizados una vez. Es lo que hace tratable el join y las pasadas |
| Estado local en `OperationsMap` | `mapTab`, `dataPoste`, `openEditPoste`. Pertenecen a la tarjeta del mapa, no a un hook de datos |

Conteo de pasadas actual sobre `listEventos`: **~16**, más el gráfico. Dos son **duplicados
literales** (la línea 121 recalcula la 108; la 122 recalcula la 114), y en `listPostes` la 116
duplica el predicado de la 98. El gráfico es un bucle anidado: en la vista por defecto (custom
≤90 días) hasta **91 pasadas**. A 150k eventos, solo el gráfico son 4,8M iteraciones asignando un
`new Date()` cada una.

---

## Tiempo real: los hechos

### Ya está decidido, hoy, y está documentado

`api/docs/specs/2026-08-22-alertas-en-el-header-design.md:73-83` **rechaza explícitamente
WebSocket/SSE** para la insignia de alertas. Sus razones: el criterio es "abierto más de 7 días", así
que nada que haga un compañero cambia el número de forma relevante en minutos; y el coste es
*"montar el transporte, autenticar la conexión, gestionar reconexiones y decidir el comportamiento
con la pestaña en segundo plano, en un backend que hoy es Express plano sin nada de sockets"*.
Línea 83: *"Si algún día hace falta, SSE encaja encima de este diseño sin rehacer nada."*

### El estado del terreno

| | |
|---|---|
| Backend | Express 4 sobre Node 20, TypeScript ESM. `app.listen` sobre un `http.Server` plano |
| Código de tiempo real existente | **Ninguno.** Sin `socket.io`, `ws`, `EventSource`, `text/event-stream`, `res.flushHeaders`. Sin Redis, MQTT, Pusher, Ably ni Centrifugo en ninguno de los dos `package.json` |
| Frontend | Vercel, y `vercel.json` es **solo** el fallback de SPA: **no hay proxy al API**. El navegador habla directo con `api.osefi.net`, así que los timeouts de Vercel son irrelevantes |
| API | VPS propio, Docker, gestionado con Coolify. Traefik termina el TLS delante (`app.ts:57`) |
| CI / orquestación | **No existe en el repo.** Ni `.github/`, ni compose, ni nixpacks. Solo el `Dockerfile` |
| Base de datos | PostgreSQL confirmado (`pg`, `pg-hstore`, `JSONB`, ENUM nativo, `Op.iLike`) |
| Usuarios | **20 a 60 en total** (la plantilla entera). Concurrencia: no determinable |

**Una sola instancia**, con tres pruebas independientes:

1. `reportBuilder/export/queue.ts:24-40` — `SingleSlot`, un mutex booleano **local al proceso**
   ("One slot for the whole process"). Con réplicas no garantizaría nada.
2. `middleware/loginLimiters.ts:49-51` — rate limiter con el store en memoria por defecto, y el
   comentario *"el día que llegue un store compartido — Redis, once there is more than one
   process"*.
3. `permissions/store.ts:14-24` — caché de permisos en proceso cuyo propósito declarado es cubrir
   *"a second server process"*, escrito como hipótesis.

O sea: **hoy no haría falta pub/sub**. Pero añadir una segunda réplica más adelante rompería los
sockets **y** el mutex de exportación **y** el limitador de login, los tres a la vez.

### El bloqueador real es de autenticación, y no es de gusto

El `WebSocket` y el `EventSource` del navegador **no pueden poner cabeceras HTTP**. Así que
`Authorization: Bearer` —que es como se autentica el **100%** del tráfico hoy— es imposible en una
conexión persistente. Solo hay dos salidas, y las dos están cerradas:

**La cookie no existe todavía.** El sistema entero está escrito: `api/src/auth/sessionStore.ts`
(`createSession`, `findLiveSession`, `touchSession`), `api/src/auth/sessionCookie.ts`,
`api/src/models/sesion.model.ts`, la migración `20260822000001-create-sesion.ts`, y
`authenticate.ts:40-44` **ya comprueba la cookie primero**. Pero `grep setSessionCookie|createSession(`
en `api/src` (sin tests) devuelve **solo las definiciones**: `loginUsuario` nunca llama a
`createSession`. **No se emite ninguna cookie, así que el 100% del tráfico va por el camino no
revocable.** Y aunque se emitiera: `cors()` (`app.ts:93-105`) **no** pone `credentials: true` y
ninguna llamada de axios usa `withCredentials`, así que no viajaría entre `www.osefi.net` y
`api.osefi.net`.

**El token en la URL acabaría en los logs en claro.** `middleware/httpLogger.ts:29,91` serializa
`req.url` desde `originalUrl`, que incluye la query string, y la lista de redacción de
`utils/logger.ts:88-101` cubre `req.headers.authorization`, `req.headers.cookie` y campos del body —
pero **no la URL**.

Y el token actual dura 7 días (`login.controller.ts:198`) y **no se puede revocar**: lo dice su
propio código en `authenticate.ts:104-107` — *"Every request through here is the old hole, still
open."* Además la renovación deslizante está muerta: `app.ts:103` expone `x-new-token` por CORS y
`SesionProvider.tsx:142-145` lo lee, pero **nada en `api/src` lo establece nunca**.

**Conclusión: el tiempo real está bloqueado detrás de cablear la sesión por cookie — que es un
arreglo de seguridad ya medio escrito y que hace falta igual.**

### Y dos cosas más que romperían antes

**No hay manejador de `SIGTERM`.** `grep process.on` en `api/src` solo encuentra
`unhandledRejection` y `uncaughtException` (`index.ts:57,62`). Coolify manda SIGTERM en cada
despliegue y el comportamiento por defecto de Node es salir inmediatamente: **todas las conexiones
abiertas se cortan de golpe en cada despliegue**, sin close frame y sin drenaje. Y
`lifecycle.ts:40-53` fuerza la salida a los **2.000 ms** — `server.close()` no termina mientras haya
un stream abierto, así que ese force-exit es lo que acabaría el proceso.

**No hay nada que emita cambios.** No hay ni un `CREATE TRIGGER` ni un `NOTIFY` en todo
`api/src/migrations` ni en los controladores. `LISTEN`/`NOTIFY` está disponible (es Postgres nativo)
pero: Sequelize no lo expone, hace falta un cliente `pg` dedicado **fuera del pool** (que es
`max: 15`) porque una conexión a la escucha no se puede devolver, el payload está topado a 8.000
bytes y **no es durable** — un oyente desconectado pierde eventos sin repetición.

**Y la bitácora no lo registra todo.** Controladores con mutaciones y **cero** `logAction`:
`eventoObs.controller.ts` (que es justo la tabla que enlaza evento con observación, o sea **la
criticidad de un incidente**: adjuntar o quitar una observación no se registra),
`adssPoste.controller.ts` y `reporte.controller.ts`. Además `logAction` **se come todos los errores
en silencio** (`logAction.ts:37-39`) y se llama **sin `await`** en la mayoría de sitios: es
best-effort, no transaccional con la mutación. Un feed construido encima perdería eventos sin
señal.

### La recomendación

**Ahora:** recargar al volver a la pestaña (`visibilitychange`) más un intervalo suave mientras está
visible, y un **"actualizado hace N min"** junto al botón de refrescar. Eso da el 95% de la
sensación de "está vivo" sin conexión persistente, sin estado de servidor y sin reconexión. Ojo al
orden: con el endpoint de agregados (~2 KB) el intervalo es barato; con el de hoy (**1,6 MiB**) no.

**Después, y solo cuando la sesión por cookie esté cableada:** **SSE** para avisar de eventos
prioritarios nuevos. Unidireccional, sobre HTTP normal, y reconecta solo por especificación. Un
WebSocket es el doble de infraestructura para una dirección que aquí no se usa.

Con 20-60 usuarios en total, montar transporte persistente, revocación, reconexión y pub/sub antes
de eso no se sostiene.

---

## Plan reordenado

### Fase 0 — lo que sangra (antes de tocar la home)

1. `requirePermission` en `GET /api/dashboard`. **Y arreglar `routeGuards.test.ts` para que
   compruebe los GET**, porque si no volverá a pasar.
2. El guardado silencioso de revisiones: alinear la puerta del servidor a `eventos.editar`, que
   `createRevision` propague el status, y que `AddRevisionSheet` lo compruebe.
3. Estado de error real en el dashboard, distinto de "todo a cero".
4. Intersectar los conjuntos de IDs de postes contra `listPostes`, y clamp en
   `pctConIncidencias` + `overflow-hidden` en la barra.

### Fase 1 — el endpoint de agregados

`GET /api/dashboard/summary` sobre `reportBuilder`: cifras, cubetas, top-N por tramo, propietario y
poste. Cola paginada aparte. Marcadores filtrados por bbox aparte.

Con **una sola definición** de "cerrado" y de "pertenece al período", compartida con Reportes, y
reutilizando su vocabulario (*nuevas* / *arrastradas*). Esto cierra de una vez: el endpoint abierto,
el payload de 1,6 MiB, el sesgo de los archivados y las cinco definiciones de fecha de resolución.
Un día de trabajo contra maquinaria ya construida y probada.

### Fase 2 — la home

Con datos ya agregados, y con todas las correcciones de arriba incorporadas. Sacar `selectors.ts`
puro **con tests** — es la primera vez que esta pantalla tendría alguno.

### Fase 3 — tiempo real, si acaso

Cablear la sesión por cookie primero (hay que hacerlo igual: hoy el token de 7 días no se puede
revocar). Manejador de `SIGTERM`. Y entonces SSE para notificaciones, no para el dashboard.
