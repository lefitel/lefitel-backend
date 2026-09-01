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
| GET | `/api/poste?export=true` | Todos los postes sin paginación (para exports) |
| GET | `/api/evento` | Lista paginada de eventos |
| GET | `/api/evento?export=true` | Todos los eventos sin paginación (para exports) |

Los montajes son **singulares**. Este documento los escribió en plural durante
meses, describiendo direcciones que no existen y nunca han existido. El
renombrado de rutas del estándar (tarea D1) va en la otra dirección:
`/api/dashboard` pasará a `/api/inicio`, no al revés.

Falta a propósito `/api/bitacora`, que también pagina — pero **con otras reglas**:
sin mínimo (`limit=1` devuelve una fila, no quince) y con un sobre distinto,
`{data, total}` sin `page` ni `totalPages`. Quien tome el apartado siguiente como
la norma de la casa se equivocará con ella. Unificar los sobres es la tarea C3.

`?export=true` desaparece en esa misma tarea. Cuando eso pase, hay que volver a
esta tabla.

---

## Paginación server-side

`/api/poste` y `/api/evento` aceptan:

| Param | Default | Descripción |
|-------|---------|-------------|
| `page` | 1 | Número de página |
| `limit` | 50 (**mín 15**, máx 100) | Registros por página |
| `filterColumn` | — | Columna a filtrar |
| `filterValue` | — | Valor del filtro. **ILIKE sólo en algunas columnas** — ver debajo |
| `archived` | false | Registros archivados (paranoid) |
| `export` | false | Devuelve todos sin paginación |

**`filterColumn` no acepta cualquier columna, y lo que no acepta lo ignora en
silencio.** En `/api/evento` sólo `description` y `poste` son ILIKE; `state`,
`priority` y `criticality` son coincidencia exacta o por tramos, así que
`filterColumn=state&filterValue=pend` no encuentra nada. En `/api/poste` sólo se
honra `name`: cualquier otra columna devuelve la primera página **sin filtrar y
sin error**, que es peor que un fallo porque parece que funcionó.

El mínimo es 15, no 10: `Math.min(100, Math.max(15, Number(limit) || 50))` en
`poste.controller.ts` y `evento.controller.ts`. Y ese `|| 50` es la razón por la
que el estándar descartó `limit=0` como centinela de «sin paginar» — el cero es
*falsy* y devolvería cincuenta filas en silencio.

Respuesta paginada, con cifras de ejemplo:

```json
{
  "data": [...],
  "total": 1470,
  "page": 1,
  "totalPages": 30,
  "limit": 50
}
```

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
errata dentro. No es lo mismo y este documento las confundía: los nombres de
índice de abajo llevan la errata a propósito, porque nombran la tabla.

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
fila entera. Se cierran en la tarea C5. Lo que sí está cerrado es la autoría —
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
proyección*». Se cierra en el estándar; mientras tanto, no lo cites como ejemplo
de nada.

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

> ⚠️ **Ninguno de estos nueve índices está en una migración.** Se crearon a mano
> contra el servidor y este documento es el único sitio donde existen. Una base
> de datos nueva —un entorno de pruebas, una restauración desde esquema— no
> tendrá ni uno, y nadie se enterará hasta que una consulta tarde diez segundos.
>
> Que la cuenta sea nueve y no ocho, y que no haya excepción, es corrección de
> una revisión: la primera versión de este aviso decía «siete de ocho» y daba
> `idx_reviciones_id_evento` por migrado. No lo está. Ese nombre aparece en
> `20260822000002-add-authorship.ts` **dentro de un comentario**, en una línea
> que dice precisamente que está mal escrito, y un `grep` del nombre lo confunde
> con una migración. Era la peor de las dos erratas posibles: manda saltarse
> justo el índice que sostiene la lista de incidencias.
>
> La forma de verlo sin creerse a nadie: las migraciones **sí** crean
> `idx_solucions_id_evento` —el hermano exacto de este, para la otra tabla de la
> misma consulta—, y de `revicions` solo migran el de `id_usuario`. El hueco es
> ese.
>
> Meterlos en una migración es trabajo pendiente, no está en las catorce tareas
> del estándar, y merece la pena hacerlo antes de que alguien monte un entorno
> nuevo.

```sql
-- eventos: subquery pendingEvents (crítico — se ejecuta 1 vez por poste)
CREATE INDEX idx_eventos_poste_state_deleted
ON public.eventos (id_poste, state, "deletedAt");

-- eventos: queries paranoid
CREATE INDEX idx_eventos_deleted ON public.eventos ("deletedAt");

-- eventos: getEvento_usuario
CREATE INDEX idx_eventos_id_usuario ON public.eventos (id_usuario);

-- postes: queries paranoid
CREATE INDEX idx_postes_deleted ON public.postes ("deletedAt");

-- postes: getPosteByTramo / getPosteByCiudad
CREATE INDEX idx_postes_ciudadA ON public.postes ("id_ciudadA");
CREATE INDEX idx_postes_ciudadB ON public.postes ("id_ciudadB");

-- revicions: separate:true hace WHERE id_evento IN (...)
-- (el único de esta lista que sí tiene migración)
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
