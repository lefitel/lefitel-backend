# Backend — Arquitectura y Optimizaciones

## Stack
- Node.js + Express 5 + TypeScript
- Sequelize ORM + PostgreSQL
- Vitest para las pruebas
- Desplegado en VPS propio, gestionado con Coolify (api.osefi.net)

---

## Endpoints principales

**Esto no es la referencia de la API.** Es una muestra, para situar lo que
explican los apartados de abajo. La superficie completa y hacia dónde va la
lleva [`specs/2026-08-25-estandar-api-design.md`](specs/2026-08-25-estandar-api-design.md).

| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/api/dashboard` | Página de inicio. **No es ligero** — ver abajo |
| GET | `/api/poste` | Lista paginada de postes |
| GET | `/api/poste/:id/eventos` | Las incidencias de un poste |
| GET | `/api/evento` | Lista paginada de incidencias |
| GET | `/api/evento/:id/obs` | Las observaciones de una incidencia |
| PATCH | `/api/poste/:id/restore` | Desarchivar. Contesta `204` |

Los montajes de negocio son **singulares** — `/api/poste`, `/api/evento`,
`/api/permiso` — y este documento los escribió en plural durante meses,
describiendo direcciones que no existen y nunca han existido. «Singular» no es la
regla entera, y decirlo así choca con `/api/files` dos líneas más abajo: §3.4 del
estándar lo dice bien, **el número lo decide el idioma**. Un sustantivo del
negocio conserva el número con el que lo dice el cliente; una colección inglesa
va en plural, que es lo correcto en inglés; una operación va en singular.

**D1 dejó tres reglas de nombres, y este párrafo decía lo contrario de una de
ellas.** Los sustantivos del negocio van en español y los verbos y operaciones
en inglés (`/restore`, `/reopen`, `/query`); un listado que sólo existe respecto
a una fila cuelga de esa fila; y los segmentos se escriben en minúsculas con
guion (`/api/tipo-obs`). `/api/dashboard` **se queda como está** — es vocabulario
de la API y no de la red eléctrica, igual que `/files` — y la versión anterior de
este documento anunciaba que D1 lo pasaría a `/api/inicio`, que es justo la
decisión que el estándar retiró. `naming.test.ts` es lo que fija las tres reglas
sobre la tabla montada, no sobre los ficheros fuente.

Falta a propósito `/api/bitacora`, que pagina con las mismas reglas que el resto
desde C3: sobre `{data, total, page, limit}` y un solo lector de `limit`. Lo
que este documento decía —«sin mínimo, `limit=1` devuelve una fila, no
quince»— se resolvió al revés de lo que sugería: C3 quitó el suelo de quince a
**todos**, no se lo puso a la bitácora, así que `?limit=1` devuelve una fila en
los diecisiete listados. La bitácora
de **una persona** ya no está aquí: es `GET /api/usuario/:id/bitacora`, porque en
un registro sobre personas el identificador no nombra el registro.

`?export=true` ya no existe: C3 lo sustituyó por `POST /api/{poste,evento,usuario}/export`,
que construye el fichero en el servidor.

---

## Paginación server-side

`/api/poste` y `/api/evento` aceptan:

| Param | Default | Descripción |
|-------|---------|-------------|
| `page` | 1 | Número de página |
| `limit` | 50 (**mín 1**, máx 100) | Registros por página |
| `filterColumn` | — | Columna a filtrar |
| `filterValue` | — | Valor del filtro. **ILIKE sólo en algunas columnas** — ver debajo |
| `archived` | false | Registros archivados (paranoid) |
| `limit=all` | — | Sin paginar, con techo de 5.000 filas y `422` si se pasa |

El `?export=true` que esta tabla listaba se retiró en C3, junto con el resto
del camino: el fichero lo construye el servidor en
`POST /api/{poste,evento,usuario}/export`.

**`filterColumn` no acepta cualquier columna, y lo que no acepta lo ignora en
silencio.** En `/api/evento` sólo `description` y `poste` son ILIKE; `state`,
`priority` y `criticality` son coincidencia exacta o por tramos, así que
`filterColumn=state&filterValue=pend` no encuentra nada. En `/api/poste` sólo se
honra `name`: cualquier otra columna devuelve la primera página **sin filtrar y
sin error**, que es peor que un fallo porque parece que funcionó.

**El mínimo es 1, y este párrafo decía 15 citando código que ya no existe.** La
expresión `Math.min(100, Math.max(15, Number(limit) || 50))` estaba en
`poste.controller.ts` y en `evento.controller.ts`, cada uno con su copia; C3 dejó
un solo lector, `leerPaginacion` (`utils/paginacion.ts`), y su suelo es
`Math.max(1, n)` — `?limit=1` devuelve una fila, en los diecisiete listados.
`paginacion.test.ts` lo fija.

Lo que sí sobrevive del párrafo viejo es el motivo por el que el estándar
descartó `limit=0` como centinela de «sin paginar»: el cero es *falsy*, así que
caía en el valor por defecto y devolvía cincuenta filas en silencio. El centinela
es `limit=all`.

Respuesta paginada, con cifras de ejemplo:

```json
{
  "data": [...],
  "total": 1470,
  "page": 1,
  "limit": 50
}
```

Cuatro claves, y `totalPages` **no** es una de ellas — este documento la
incluía. C3 unificó el sobre de los diecisiete listados y lo dejó en estas
cuatro exactas; `listShape.test.ts` las compara en las dos direcciones, así que
una de más es tan roja como una de menos. El número de páginas se calcula en el
cliente, que es donde se usa.

---

## Optimizaciones de queries

### `separate: true` en hasMany (getEvento)

`RevisionModel`, `SolucionModel` y `EventoObsModel` usan `separate: true`. Sin
esto, Sequelize genera un JOIN que produce un producto cartesiano
(evento × revisiones × soluciones × observaciones). Con `separate: true` ejecuta
consultas aparte, `WHERE id_evento IN (...)`.

```typescript
{ model: RevisionModel,  separate: true, attributes: ["id", "date", "id_evento"] }
{ model: SolucionModel,  separate: true, attributes: ["id", "date", "id_evento"] }
{ model: EventoObsModel, separate: true, attributes: ["id", "id_obs", "id_evento"],
  include: [{ model: ObsModel, attributes: ["id", "name", "criticality"] }] }
```

El modelo se llama `RevisionModel`; la **tabla** se llama `revicions`, con la
errata dentro. No es lo mismo y este documento las confundía.

Y son **dos erratas distintas**, que es lo que decía mal la versión anterior de
este párrafo: la tabla es `revic**ions**` y el índice es
`idx_revic**iones**_id_evento`. O sea que el índice **no** nombra a su tabla, y
la regla que aquí se enunciaba —«llevan la errata a propósito, porque nombran la
tabla»— no describe el nombre que hay. Importa porque quien la crea se ve
tentado de «corregirlo» a `idx_revicions_id_evento`, que es la convención que sí
sigue la migración de autoría, y eso no renombra nada: **crea un segundo índice
idéntico**. El nombre se conserva tal cual; renombrarlo, si algún día se quiere,
es un `ALTER INDEX` en su propia migración.

`criticality` viaja en el include de observaciones desde que se descubrió que la
lista de incidencias podía nombrar la observación sin decir su gravedad — que es
justo lo que se va a mirar cuando una alerta te manda a esa pantalla.

### Subquery `pendingEvents` en getPoste

Cuenta eventos pendientes por poste directamente en SQL, evitando cargar todos
los eventos en el frontend.

```sql
(SELECT COUNT(*) FROM "eventos"
 WHERE "eventos"."id_poste" = "poste"."id"
 AND "eventos"."state" = false
 AND "eventos"."deletedAt" IS NULL)
```

### Atributos limitados en includes

La mayoría de los includes especifican solo las columnas necesarias. **No todos:**
la auditoría del estándar contó unos veinticinco sin `attributes`, que mandan la
fila entera. **No los cierra ninguna tarea del arco**: están aplazados a
propósito en §3.9 del estándar, y este documento decía que los cerraba C5, que
es otra cosa — las dieciocho lecturas sin permiso. Lo que sí está cerrado es la autoría —
ningún include filtra ya quién creó una fila, y `responseShape.test.ts` lo
vigila.

### Endpoint `/api/dashboard` separado — y **no es ligero**

La página de inicio tiene endpoint propio para no arrastrar los JOINs de los
completos. Hasta ahí, cierto. Lo que este documento repitió durante meses, y una
revisión tumbó, es la palabra «ligero»: `dashboard.controller.ts` hace dos
`findAll` **sin `where` y sin `limit`**, así que devuelve todos los eventos y
todos los postes de la base de datos, con sus revisiones, soluciones y
observaciones. Una llamada es el registro entero de activos.

El comentario de `dashboard.routes.ts` ya lo decía, y este documento lo
contradecía a dos secciones de distancia: «*todas las demás lecturas abiertas
paginan al menos de cien en cien; ésta no tiene `where`, ni `limit`, ni
proyección*». **Ninguna de las catorce tareas del estándar lo acota** —la primera
versión de este párrafo decía «se cierra en el estándar», y una auditoría lo
desmintió—. Está gateado con `eventos.ver`, que tienen los tres roles sembrados,
así que la puerta no cierra nada en la práctica. Acotarlo es trabajo pendiente
con nombre; mientras tanto, no lo cites como ejemplo de nada.

### Un fallo no se cuenta al navegador

Setenta y cuatro manejadores respondían `500` con el texto crudo de la excepción
—nombres de columna, de restricción, a veces el SQL—. Ahora pasan por
`makeHandler` (`utils/handler.ts`), que registra el error bajo el logger de su
controlador con la ruta y responde un mensaje neutro. `errorShape.test.ts` impide
que el patrón vuelva.

**Quedan dieciséis sin convertir**, y conviene saber cuáles porque una de ellas es
`getEvento`, el manejador que este documento más disecciona: diez en
`evento.controller.ts`, cinco en `rol.controller.ts` y una en
`eventoObs.controller.ts`. Los tres están en la lista de excepciones del test
—eran de otras sesiones cuando se hizo el cambio— y hasta que se conviertan, un
fallo de Postgres en la lista de incidencias sigue llegando al navegador.

---

## Base de datos — Índices

> ✅ **Los nueve están ya en una migración**, `20260904000001-hand-made-indexes`
> (tarea E1 del estándar, 4 de septiembre de 2026). Antes de eso se habían
> creado a mano contra el servidor y este documento era el único sitio donde
> existían.
>
> **Lo que eso arregla, dicho sin inflarlo.** La versión anterior de este aviso
> decía que una base de datos nueva no tendría ni uno. Es cierto y es
> inalcanzable: **ninguna migración crea las tablas base** —la más antigua ya
> hace `addColumn("obs", …)` dando por hecho que existen— y el `sync({ alter:
> true })` que las creaba se retiró. Así que `npm run migrate` contra una base
> vacía muere mucho antes de llegar aquí, y las dos formas de montar un entorno
> nuevo son restaurar un `pg_dump` —que trae los índices dentro— o nada. Lo que
> E1 compra es **procedencia**: los nueve dejan de vivir sólo en prosa y pasan a
> estar declarados, versionados y comprobables.
>
> **Y comprobados de verdad.** La migración no se limita a crearlos con `IF NOT
> EXISTS`, que compara el nombre y nunca la definición: al final lee de
> `pg_index` las columnas reales de los nueve y falla si alguna no es la de aquí.
> Ese es el único caso que `IF NOT EXISTS` se traga —un índice hecho a mano con
> uno de estos nombres sobre otra columna— y es exactamente el que dejaría una
> consulta escaneando mientras este documento jura lo contrario.
>
> **Dos nombres de esta lista no son lo que parecen, y están así a propósito.**
> `idx_postes_ciudadA` se escribe aquí sin comillas, que es como se creó, y
> Postgres pasa a minúsculas todo identificador sin comillas: en la base se llama
> `idx_postes_ciudada`. Entrecomillarlo en una migración —que es lo que hace
> `queryInterface.addIndex` por su cuenta— busca un nombre que no existe y
> **crea un índice duplicado**. Lo mismo con `idx_reviciones_id_evento` y su
> errata. Los dos casos están escritos en la cabecera de la migración.
>
> Que la cuenta sea nueve y no ocho es corrección de una revisión anterior: decía
> «siete de ocho» y daba `idx_reviciones_id_evento` por migrado porque su nombre
> aparece en `20260822000002-add-authorship.ts` **dentro de un comentario**, en
> una línea que dice precisamente que está mal escrito. Un `grep` del nombre lo
> confundía con una migración.
>
> **Los índices que sí vienen de una migración no están en esta lista**, y no es
> descuido: la lista es la de los que faltarían en una base nueva. Los migrados
> son bastantes más —una veintena, repartidos por casi todas las migraciones:
> los de `reporte_vistas`, `sesiones`, las tablas de factores, los tokens de un
> solo uso, `codigo_correo`…— y no se enumeran aquí a propósito, porque una lista
> escrita a mano envejece igual de mal que la de arriba. **La forma de saberlo
> sin creerse a nadie es `grep -rn "addIndex\|CREATE INDEX" src/migrations/`.**
>
> Se dice porque un `grep` de un solo nombre ya confundió a un revisor una vez,
> en el sentido peligroso —dio por migrado uno que no lo está— y una primera
> versión de este párrafo nombraba cinco migrados como si fueran todos, que es el
> error contrario y lleva a concluir que la lista no vale.

```sql
-- eventos: subquery pendingEvents (crítico — se ejecuta 1 vez por poste)
CREATE INDEX idx_eventos_poste_state_deleted
ON public.eventos (id_poste, state, "deletedAt");

-- eventos: la pestaña Archivados, que pide `deletedAt IS NOT NULL`.
-- NO las consultas paranoid: ésas piden `IS NULL`, que casa con casi toda la
-- tabla, y para eso un índice no sirve. El comentario anterior decía lo
-- contrario y mandaba a cualquiera que quisiera «mejorarlo» a un índice parcial
-- `WHERE "deletedAt" IS NULL`, que es justo el que NO puede servir a Archivados.
CREATE INDEX idx_eventos_deleted ON public.eventos ("deletedAt");

-- eventos: getEvento_usuario
CREATE INDEX idx_eventos_id_usuario ON public.eventos (id_usuario);

-- postes: la pestaña Archivados, igual que en eventos.
CREATE INDEX idx_postes_deleted ON public.postes ("deletedAt");

-- postes: `getPoste` filtrado por `ciudadId`, o por `ciudadA`+`ciudadB`. (Los
-- nombres `getPosteByTramo` y `getPosteByCiudad` que decía aquí antes no existen
-- ni han existido: son parámetros de consulta sobre el mismo manejador.)
-- Nombre SIN comillas a propósito: en la base está en minúsculas. Ver el aviso.
CREATE INDEX idx_postes_ciudadA ON public.postes ("id_ciudadA");
CREATE INDEX idx_postes_ciudadB ON public.postes ("id_ciudadB");

-- revicions: separate:true hace WHERE id_evento IN (...)
-- Tampoco está en ninguna migración: su nombre aparece en una, dentro de un
-- comentario que dice que está mal escrito. Ver el aviso de arriba.
CREATE INDEX idx_reviciones_id_evento ON public.revicions (id_evento);

-- eventoObs: idem
CREATE INDEX idx_evento_obs_id_evento ON public."eventoObs" (id_evento);

-- bitacoras: filtros por rango de fecha
CREATE INDEX idx_bitacora_created ON public.bitacoras ("createdAt");
```

**La tabla se llama `eventoObs`.** El modelo no declara `tableName`, así que lo
decide Sequelize, y este documento llegó a contradecirse — escribía
`public."eventoObs"` al crear el índice y `'evento_obs'` al verificarlo. No hacía
falta preguntárselo a la base de datos: `evento.controller.ts` ejecuta SQL crudo
`FROM "eventoObs" eo` para ordenar por gravedad, con un test que lo asevera, así
que si el nombre fuera otro esa consulta fallaría en cada uso.

Verificar qué índices existen:

```sql
SELECT tablename, indexname
FROM pg_indexes
WHERE schemaname = 'public'
ORDER BY tablename, indexname;
```

Eliminar un índice (reversible, no modifica datos):

```sql
DROP INDEX nombre_del_indice;
```

---

## Pruebas que vigilan la forma del código

**Cuatro** pruebas leen el **código fuente** de los controladores en vez de
ejecutarlo, y las cuatro existen por el mismo motivo: el defecto que persiguen no
es un valor equivocado sino una línea que falta, y reaparece cuando alguien
escribe el siguiente controlador copiando el anterior.

| Prueba | Qué prohíbe |
|---|---|
| `responseShape.test.ts` | Que una consulta mande columnas que la pantalla no lee — por ahí salía quién creó cada fila |
| `requestShape.test.ts` | Que una escritura acepte `req.body` sin filtrar — por ahí se podía archivar una fila con permiso de solo editar |
| `logShape.test.ts` | Que la bitácora describa el cuerpo recibido en vez de lo que se escribió — apuntaba cambios que el servidor había rechazado |
| `errorShape.test.ts` | Que un `500` responda con el texto de la excepción |

Las cuatro llevan un guardián contra el escaneo vacío: fallan si no encuentran
nada que leer, para que un renombrado de fichero o de carpeta no las deje pasando
sobre cero controladores.

**Dos de ellas llevan además un guardián de caducidad**, y son las dos que tienen
lista de excepciones: `logShape` y `errorShape` fallan cuando un fichero de su
lista deja de tener el defecto que justificaba la excepción. `requestShape` y
`responseShape` no lo llevan porque no tienen excepciones que caducar. Si se
escribe una quinta: el primero siempre, el segundo solo si necesita exceptuar
algo.

---

Recuento y comprobaciones de este documento hechos el 1 de septiembre de 2026
contra el árbol de trabajo. Las cifras de aquí sirven para entender el tamaño de
las cosas, no como criterio de nada: hay varias sesiones tocando este repositorio
y envejecen en días.
