# Generador de Reportes Dinámicos — Diseño

**Fecha:** 2026-08-04
**Cliente:** Osefi (contacto: Fisher)
**Estado:** aprobado comercialmente, pendiente de aprobación del spec

---

## 1. Objetivo

Reemplazar el ciclo actual de "el cliente pide un reporte → se programa a medida → se entrega en semanas" por un módulo donde el cliente arma sus propios reportes: elige columnas, aplica filtros, agrupa, guarda la configuración y exporta.

Hoy existen seis reportes fijos en `reporte.controller.ts`, cada uno con su endpoint, su agregación a mano, su página y su exportador. Ese patrón no escala: cada reporte nuevo es un desarrollo completo.

**Criterio de éxito:** el generador reproduce los seis reportes actuales sin escribir código nuevo, y permite construir combinaciones que hoy no existen.

---

## 2. Alcance

Comprometido por contrato (ver `docs/Propuesta-Modulo-Reportes-Osefi.pdf`):

- Selección de columnas sobre cuatro raíces, con campos calculados
- Filtros combinables por cualquier campo del catálogo
- Nivel de detalle configurable (la raíz de la consulta)
- Agrupaciones con conteos, sumas, promedios, mínimos, máximos y totales
- Vista previa paginada
- Reportes guardados: nombre, duplicar, renombrar, favorito, privado o compartido
- Exportación a Excel con la presentación actual (portada, logos, indicadores, colores por criticidad, fotos embebidas)
- Exportación a PDF con orientación automática
- Colores automáticos por criticidad o estado

**Fuera de alcance:** gráficos, envío programado por correo, cambios sobre módulos existentes, integraciones con terceros.

---

## 3. Decisiones tomadas

| Decisión | Elegido | Razón |
|---|---|---|
| Arquitectura del motor | Multi-raíz desde el día uno | El nivel de detalle está comprometido por contrato. Construirlo solo para Evento y generalizar después implica un refactor a mitad del proyecto |
| Generación de consultas | SQL parametrizado propio, no `include` de Sequelize | Las agregaciones con `group` + `include` anidado producen SQL impredecible; `limit` con `hasMany` corta filas del JOIN, no de la raíz; el tramo normalizado y los días de resolución requieren SQL crudo igualmente |
| Herramienta externa (Metabase, Cube.js) | Descartada | Costo mensual recurrente, interfaz ajena al sistema, y no puede producir el Excel con logos, indicadores y fotos embebidas que está comprometido |
| Ubicación en el frontend | Página nueva e independiente | La página de Reportes actual se mantiene intacta durante la transición |
| Acceso | Roles 1, 2 y 3, con catálogo recortado por rol | Decisión del cliente. Obliga a filtrar el catálogo según el rol del solicitante |
| Brecha de roles del backend | Se cierra solo en el módulo nuevo | Está fuera del alcance contratado. Queda documentada en la sección 7 |

---

## 4. Arquitectura del catálogo

### 4.1 Modelo mental: grafo, no lista de columnas

Cada entidad declara sus campos escalares (con tipo y operadores válidos) y sus relaciones salientes. Un campo se identifica por su **ruta** desde la raíz de la consulta:

```
poste.ciudadA.name
ob.tipoObs.name
evento.poste.propietario.name
```

Las relaciones son de dos clases:

- **A-uno** (`belongsTo`): se resuelven con `LEFT JOIN`, no multiplican filas, se encadenan libremente.
- **A-muchos** (`hasMany`): multiplican filas.

### 4.2 La regla de grano

> La raíz define qué representa cada fila. Desde la raíz, las relaciones a-uno se navegan libremente. Las relaciones a-muchos **solo entran agregadas**.

Con raíz `evento`:

| Campo pedido | Resultado |
|---|---|
| `poste.ciudadA.name` | Válido. JOIN a-uno |
| `revisions.date` | Rechazado. Rompería el grano |
| `count(revisions)` | Válido. Agregado |
| `max(revisions.date)` | Válido. Es la "última revisión" actual |

Si el usuario quiere una fila por revisión, cambia la raíz a `revision`. El nivel de detalle comprometido en la propuesta sale de la arquitectura, no de casos especiales.

### 4.3 Las cuatro raíces

| Raíz | Una fila es | Campos propios | Navegación hacia arriba |
|---|---|---|---|
| `evento` | una incidencia | description, date, state, priority, image, createdAt | poste, poste.ciudadA/B, poste.propietario, poste.material, usuario, usuario.rol |
| `revision` | una visita de revisión | date, description | evento y todo lo alcanzable desde evento |
| `eventoObs` | una observación registrada en un evento | — | ob, ob.tipoObs, evento y todo lo alcanzable desde evento |
| `poste` | un poste | name, image, date, lat, lng | propietario, material, ciudadA, ciudadB, usuario |

**Profundidad máxima: 3 saltos.** Cubre el caso más largo (`evento.poste.ciudadA.name` desde raíz `revision`) y evita rutas abusivas.

### 4.4 Relaciones a-uno por regla

`Solucion` está declarada como `hasMany` desde `Evento` (`solucion.model.ts:27`), pero los reportes actuales la tratan como única: muestran "Fecha Sol", "Desc Sol" y "Foto Sol" como columnas simples.

Se declara en el catálogo como **relación a-uno con regla "la más reciente"**, resuelta con `LEFT JOIN LATERAL`. Así `solucion.description` funciona como columna normal sin romper el grano. Mismo tratamiento para "última revisión".

```sql
LEFT JOIN LATERAL (
  SELECT s.* FROM solucions s
  WHERE s.id_evento = root.id AND s."deletedAt" IS NULL
  ORDER BY s.date DESC LIMIT 1
) sol ON true
```

### 4.5 Nombres físicos de tabla

Verificados contra la base local. Sequelize los deriva del `modelName` y **no coinciden con lo que uno supondría**. Con SQL generado a mano, esto es causa directa de fallo.

| Modelo | Tabla física |
|---|---|
| Evento | `eventos` |
| Poste | `postes` |
| Ciudad | `ciudads` |
| Material | `materials` |
| Propietario | `propietarios` |
| Obs | `obs` |
| TipoObs | `"tipoObs"` (camelCase, requiere comillas) |
| EventoObs | `"eventoObs"` (camelCase, requiere comillas) |
| Solucion | `solucions` |
| Revision | `revicions` (errata en el nombre original) |
| Usuario | `usuarios` |
| Rol | `rols` |
| Adss | `adsses` |
| AdssPoste | `adsspostes` |
| Bitacora | `bitacoras` |

**El catálogo mapea nombre lógico a tabla física.** Las rutas que ve el usuario y que se guardan en las configuraciones usan nombres lógicos (`revisiones`, `solucion`), nunca los físicos. Así la errata de `revicions` queda contenida en una sola línea del catálogo en vez de propagarse a la interfaz y a todas las configuraciones guardadas, donde sería permanente.

Todos los identificadores se escriben entrecomillados en el SQL generado, no solo los camelCase, para no depender de recordar cuáles lo necesitan.

### 4.6 Campos calculados

Deben replicar exactamente la semántica actual. Si los números difieren de los reportes que el cliente ya tiene, la herramienta pierde credibilidad el primer día.

| Campo | Raíz | Definición | Referencia actual |
|---|---|---|---|
| `tramo` | poste | `LEAST(id_ciudadA, id_ciudadB)` / `GREATEST(...)` con sus nombres. Normaliza (A,B) y (B,A) al mismo tramo | `reporte.controller.ts:225` |
| `diasAbierto` | evento | Días entre `createdAt` y hoy, para eventos no resueltos | — |
| `tiempoResolucion` | evento | Días entre `createdAt` y la fecha de la **última revisión**, no `updatedAt` | `reporte.controller.ts:353` |
| `criticidadEvento` | evento | Derivada de la criticidad de sus observaciones | `lib/criticality.ts` (frontend) |
| `ultimaRevision` | evento | `MAX(revisions.date)` | `reportGeneral.ts:58` |
| `numRevisiones` | evento | `COUNT(revisions)` | — |
| `numEventos` / `numPendientes` | poste | `COUNT(eventos)` y `COUNT(*) FILTER (WHERE state = false)` | `reporte.controller.ts:244` |

`criticidadEvento` vive hoy en el frontend. Hay que portar la lógica al backend y verificar que ambas implementaciones coincidan, o el mismo evento tendrá criticidades distintas según dónde se mire.

---

## 5. Motor de consultas

### 5.1 Forma de la configuración

Es lo que se guarda en la base y lo que viaja al endpoint:

```json
{
  "root": "evento",
  "columns": [
    { "path": "poste.name", "label": "Nº Poste" },
    { "path": "poste.ciudadA.name" },
    { "agg": "max", "path": "revisions.date", "label": "Última revisión" },
    { "calc": "diasAbierto" }
  ],
  "filters": {
    "op": "and",
    "conditions": [
      { "path": "date", "operator": "between", "value": ["2026-01-01", "2026-06-30"] },
      { "path": "state", "operator": "eq", "value": false }
    ]
  },
  "groupBy": [],
  "sort": [{ "path": "date", "dir": "desc" }],
  "limit": 500
}
```

### 5.2 Modos

- **Detalle** (`groupBy` vacío): una fila por raíz.
- **Resumen** (`groupBy` con campos): una fila por grupo. Toda columna debe estar agrupada o agregada.

La validación del modo resumen la hace el validador, con mensaje en lenguaje de usuario:

> "Agrupaste por Tramo: la columna Descripción necesita un resumen (conteo, promedio…) o hay que quitarla."

Nunca se deja que el error lo lance Postgres. Un `column must appear in the GROUP BY clause` en pantalla se lee como sistema roto.

### 5.3 Alias deterministas

Cada ruta se mapea a un alias fijo: `poste` → `j1`, `poste.ciudadA` → `j2`. Las rutas que comparten prefijo comparten JOIN. Una misma configuración genera siempre el mismo SQL, lo que hace el motor depurable.

### 5.4 Paginación

`LIMIT` / `OFFSET` sobre la raíz más un `COUNT(*)` separado. La paginación se aplica a la raíz, nunca al resultado del JOIN.

---

## 6. Seguridad

| Riesgo | Mitigación |
|---|---|
| Inyección por nombre de campo | Los identificadores nunca provienen del input. La ruta se busca en el catálogo; si no existe, error. Lo que se escribe en el SQL es lo que declara el catálogo |
| Inyección por valor | Todo valor va como parámetro de bind. Cero concatenación |
| Inyección por operador | Enum cerrado: `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `between`, `in`, `like`, `isnull` |
| Fuga de campos sensibles | `usuario.pass` no existe en el catálogo. Test automático que recorre el catálogo completo y falla si aparece cualquier campo de contraseña o token |
| Consulta que degrada la base | `statement_timeout` por consulta y tope duro de filas por encima del límite solicitado |
| Registros archivados reapareciendo | Todo JOIN generado arrastra `deletedAt IS NULL` |
| Profundidad abusiva | Máximo 3 saltos, validado antes de construir el SQL |
| Escalada por rol | El catálogo se filtra por `req.user.id_rol` **en el servidor** antes de responder, y la validación de cada consulta se hace contra el catálogo ya filtrado |

**La propiedad central:** la seguridad no depende de escapar correctamente, depende de que el input del usuario nunca se convierta en SQL. El usuario solo elige entradas de un catálogo cerrado.

### 6.1 Catálogo por rol

| Rol | Acceso |
|---|---|
| 1 (administrador) | Catálogo completo |
| 2 (supervisión) | Catálogo completo |
| 3 (operativo) | Sin campos de `usuario` ni de `rol` |

Bitácora no forma parte del grafo desde ninguna raíz, así que no hay nada que restringir por ese lado. La única diferencia real es el rol 3, que no puede ver quién registró cada evento ni los datos de otros usuarios.

El filtrado ocurre en el servidor. El frontend nunca recibe los campos que no le corresponden, así que no hay nada que ocultar en la interfaz.

### 6.2 Hallazgo: brecha de autorización preexistente

**No la introduce este módulo, pero queda registrada.**

`authenticateToken` (`app.ts:55`) protege todas las rutas de la API, pero **ningún controlador comprueba `id_rol`**. El control de roles vive únicamente en el frontend (`App.tsx:43`, `menuItems.ts`). En consecuencia, cualquier usuario autenticado puede llamar directamente a `/api/usuario`, `/api/bitacora` o `/api/rol` y recibir los datos, aunque el menú se los oculte.

Decisión: se cierra solo en las rutas del generador, mediante un middleware `requireRole`. El resto del sistema queda como está. Se recomienda cotizar aparte el cierre completo (estimado: 4 a 6 horas).

---

## 7. Persistencia

Tabla `reporte_vista`:

| Campo | Tipo | Notas |
|---|---|---|
| `id` | serial | |
| `name` | string | requerido |
| `description` | text | opcional |
| `config` | jsonb | la configuración de la sección 5.1 |
| `id_usuario` | fk | propietario |
| `visibility` | enum | `private` \| `shared` |
| `favorite` | boolean | del propietario |
| `createdAt` / `updatedAt` / `deletedAt` | timestamps | `paranoid`, como el resto de modelos |

Reglas: el propietario y el rol 1 pueden editar y borrar. Los reportes `shared` los puede ejecutar y duplicar cualquiera, pero no editar.

La configuración se valida contra el catálogo **al ejecutarse**, no solo al guardarse: si el catálogo cambia, un reporte guardado que quede inválido debe dar un mensaje claro en vez de un error de SQL.

---

## 8. API

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/api/generador/catalogo` | Catálogo filtrado por el rol del solicitante |
| POST | `/api/generador/consulta` | Ejecuta una configuración y devuelve `{ columns, rows, total, page }` |
| GET | `/api/generador/reportes` | Propios más compartidos |
| POST | `/api/generador/reportes` | Crear |
| PUT | `/api/generador/reportes/:id` | Actualizar |
| DELETE | `/api/generador/reportes/:id` | Archivar |
| POST | `/api/generador/reportes/:id/duplicar` | Duplicar |

Nota: la ejecución usa `POST` y no `PUT`, a diferencia de `reporte.routes.ts`. Es una desviación deliberada de la convención existente: `PUT` es idempotente y semánticamente incorrecto para ejecutar una consulta con cuerpo.

---

## 9. Estructura de archivos

**Backend**

```
src/reportBuilder/catalog.ts      Catálogo declarativo: entidades, campos, relaciones, calculados
src/reportBuilder/validate.ts     Validación de la configuración contra el catálogo
src/reportBuilder/sqlBuilder.ts   Genera SQL y binds
src/reportBuilder/execute.ts      Ejecuta y mapea el resultado
src/middleware/requireRole.ts     Verificación de rol en servidor
src/models/reporteVista.model.ts
src/migrations/<ts>-create-reporte-vista.ts
src/controllers/generador.controller.ts
src/routes/generador.routes.ts
```

Cada archivo tiene una responsabilidad y se puede probar por separado. `sqlBuilder` en particular debe ser una función pura: configuración más catálogo entra, `{ sql, binds }` sale. Eso permite probar la generación de SQL sin base de datos.

**Frontend**

```
src/pages/menu/generador/index.tsx          Página y estado de la configuración
src/pages/menu/generador/RootPicker.tsx     Selección de raíz (nivel de detalle)
src/pages/menu/generador/ColumnPicker.tsx   Selección y orden de columnas
src/pages/menu/generador/FilterBuilder.tsx  Constructor de filtros
src/pages/menu/generador/GroupPanel.tsx     Agrupación y agregaciones
src/pages/menu/generador/PreviewTable.tsx   Vista previa paginada
src/pages/menu/generador/SavedReports.tsx   Gestión de reportes guardados
src/api/generador.api.ts
src/lib/exports/dynamicExcel.ts             Excel con columnas variables
src/lib/exports/dynamicPdf.ts               PDF con columnas variables
```

Alta en el menú: nueva entrada en `menuItems.ts` con path `/app/generador` y `roles: [1, 2, 3]`. Nueva ruta en `App.tsx` dentro del bloque `RoleRoute roles={[1,2,3]}`.

La página de Reportes actual y sus seis pestañas se mantienen sin cambios.

---

## 10. Exportación

Los exportadores actuales (`reportGeneral.ts`, `reportTramo.ts`) tienen el mapa de columnas fijo en constantes. No se pueden reutilizar tal cual, pero sí su tratamiento visual: paleta, franja de indicadores, compresión de imágenes a JPEG, bordes y agrupación por color.

Los exportadores nuevos reciben `{ columns, rows }` y construyen el layout en tiempo de ejecución. Las columnas de tipo imagen se detectan por el tipo declarado en el catálogo, no por su nombre.

---

## 11. Criterios de aceptación

El generador debe reproducir los seis reportes actuales:

| Reporte | Configuración |
|---|---|
| General | raíz `evento`, campos de poste y solución, `max(revisions.date)` |
| Por tramo | raíz `evento`, filtro por ciudadA/ciudadB |
| Recorrido | igual, con filtro de tramo obligatorio |
| Estado de la red | raíz `poste`, agrupado por `tramo`, `count(eventos)` y `count(pendientes)` |
| Observaciones frecuentes | raíz `eventoObs`, agrupado por `ob`, `count(*)` |
| Tiempos de resolución | raíz `evento`, agrupado por `tramo`, `avg(tiempoResolucion)` |

Cada uno debe devolver **los mismos números** que el endpoint actual sobre los mismos datos. Esa comparación es la prueba de regresión del proyecto.

---

## 12. Riesgos

| Riesgo | Mitigación |
|---|---|
| Los números del generador no coinciden con los reportes actuales | Resuelto: `regression.test.ts` compara contra los endpoints existentes sobre datos reales |
| La UI del constructor es la parte más cara y se subestima siempre | Se construye después del motor, con el catálogo ya cerrado, para no rehacerla |
| Consultas pesadas sobre la base de producción | `statement_timeout`, tope de filas e índices nuevos antes de exponer el módulo |
| El plazo de dos semanas comprometido con el cliente | Ya asumido. Si se excede, se avisa al cliente antes de que lo note |
| `criticidadEvento` duplicada en frontend y backend | Portar la lógica y probar que ambas coinciden; a futuro, dejar solo la del backend |

---

## 13. Hallazgos durante la implementación

Cosas que sólo aparecieron al construirlo y al comparar contra datos reales. Todas están ya aplicadas salvo donde se indique.

### 13.1 Filtros de existencia (capacidad añadida al diseño)

Los seis reportes actuales acotan los eventos a los que tienen **al menos una revisión dentro del rango de fechas** (`reporte.controller.ts:40`). El diseño original no sabía expresar eso: los filtros sólo operaban sobre valores escalares.

Se añadió un tercer tipo de condición:

```json
{ "exists": "revisiones",
  "where": { "op": "and",
             "conditions": [{ "path": "date", "operator": "between", "value": ["...", "..."] }] } }
```

Genera `EXISTS (SELECT 1 FROM "revicions" e0 WHERE e0."id_evento" = t0."id" AND …)`, admite `negate` para `NOT EXISTS`, y funciona desde cualquier raíz. Es lo que hace reproducibles los reportes actuales, y de paso habilita consultas que antes no existían: postes con algún evento pendiente, eventos con alguna observación crítica.

Las subconsultas usan su propio espacio de alias (`e0`, `e0_j1`) para no colisionar con los de la consulta externa.

### 13.2 Tramos: agrupar por id, mostrar el nombre

Tres ciudades comparten nombre en los datos reales: `Millares` (ids 58 y 77), `Olivos` (59 y 78) y `Pailas` (86 y 98).

Agrupar por el texto del tramo fusionaba tramos distintos: 89 grupos en lugar de los 91 reales. Se añadió `groupKeys` a los campos calculados, que permite agrupar por unas expresiones y mostrar otra. `tramo` agrupa por `LEAST(idA, idB), GREATEST(idA, idB)` y muestra los nombres.

Además, cuando una ciudad está archivada su nombre sale nulo por el JOIN paranoid. Los reportes actuales imprimen `#<id>` en ese caso, y el generador ahora hace lo mismo con `COALESCE`, para no mostrar tramos vacíos.

### 13.3 Bug en los reportes actuales: cuentan datos archivados

`putObsFrecuencia` filtra por `id_evento IN (...)` sin comprobar que el evento siga vivo. En los datos actuales hay **138 eventos archivados con 141 observaciones**, y todas ellas se están contando hoy en el reporte de observaciones frecuentes.

El generador las excluye. Es decir, **sus números serán distintos de los actuales, y los correctos son los del generador**. Conviene avisar al cliente antes de que lo note, porque va a ver caer algunos conteos.

La comparación de regresión descuenta esas observaciones para poder comparar peras con peras; el desglose está en `regression.test.ts`.

### 13.4 Bug de infraestructura: las migraciones nunca corrieron en Windows

`migrate.ts` construía el patrón glob con `join()`, que en Windows produce backslashes. El glob de umzug no los interpreta y encontraba **cero** migraciones, informando "no hay migraciones pendientes" sin error alguno.

Consecuencia: `npm run migrate` nunca ha funcionado en Windows y las migraciones sólo se han aplicado en Render. Por eso `SequelizeMeta` guarda la migración anterior con extensión `.js`.

Corregido normalizando el patrón a barras POSIX. **Efecto secundario a vigilar:** en desarrollo umzug ve los archivos `.ts` y en producción los `.js`, así que cada entorno lleva su propio registro en `SequelizeMeta`. En la base local se insertó a mano la entrada `.ts` de la migración antigua para que no intentara re-aplicarla.

### 13.5 Campo `id` en las raíces

No había forma de expresar `COUNT(*)` sobre un grupo. Se añadió el campo `id` a las cuatro raíces y a `obs`: al ser clave primaria y no admitir nulos, `COUNT(id)` equivale a `COUNT(*)`, y de paso el usuario puede mostrar el identificador del registro.

### 13.6 Solución y última revisión como relación a-uno

Confirmado en la implementación: ambas se resuelven con `LEFT JOIN LATERAL … ORDER BY date DESC LIMIT 1`, de modo que `solucion.description` se comporta como una columna normal sin romper el grano.

### 13.7 Auditoría y correcciones

Tres auditorías adversariales independientes (seguridad, corrección lógica, robustez e integración) sobre el commit `919058a`. El núcleo resistió: **no hay inyección SQL**, ninguna vía multiplica filas, los alias de subconsultas no colisionan, el aislamiento por rol bloqueó las ocho vías probadas, `usuarios.pass` es inalcanzable, y las 701 rutas del catálogo se ejecutaron sin un solo fallo. Lo que salió fueron defectos alrededor.

**Corregidos, con verificación empírica:**

| Defecto | Impacto medido | Corrección |
|---|---|---|
| `ORDER BY` sin desempate | Paginando 1376 eventos: 366 duplicados y 366 perdidos (27 %) | Clave primaria como último criterio; en resumen, las claves de grupo. Verificado: 0 duplicados, 1376 de 1376 |
| `COUNT` sobre subconsulta escalar | "Nº de revisiones por tramo" devolvía 19 donde la verdad era 76 | `innerAgg` en el catálogo: un conteo se suma, no se cuenta. Verificado: 7337 = 7337 contra SQL a mano |
| `AVG` sobre un promedio por fila | Promedio de promedios (paradoja de Simpson) | Rechazado con mensaje explicativo |
| `diasAbierto` medido desde `createdAt` | 840 días en el reporte frente a 162 en la pantalla de detalle | Se mide desde `date`, como la aplicación |
| `tiempoResolucion` con `GREATEST(0, NULL)` | Devolvía 0, no vacío, contaminando promedios | `CASE WHEN MAX() IS NULL THEN NULL` |
| `neq` con `<>` | 281 de 1376 filas desaparecían por comparar contra NULL | `IS DISTINCT FROM` |
| `between` sobre fechas | Se comía el último día entero: 74 eventos (6,9 %) | Límite superior exclusivo al día siguiente; igual para `eq`, `lte` y `gt` |
| Sin tope de columnas | 1600 columnas: 70 MB de respuesta y 15 s de CPU | Máximo 60 columnas, 100 filtros, 10 órdenes |
| Pool sin configurar (5 conexiones) | Cinco reportes simultáneos dejaban sin base a **toda** la API | `pool.max = 15` y limitador de 30 consultas por minuto |
| Rol leído del JWT y nunca revalidado | Una degradación de rol no surtía efecto jamás | `authenticateToken` lee `id_rol` de la base |
| `Object.prototype` atravesaba la lista blanca | `revisiones.constructor` generaba `"undefined"` como identificador | `Object.hasOwn` en las búsquedas y `quote()` rechaza no-strings |
| Errores de Postgres devueltos crudos | Oráculo de tipos y estructura interna | Mensaje genérico al cliente, detalle solo en el log |
| Autores filtrados al rol 3 | El listado entregaba nombres que el catálogo oculta | El `include` de usuario depende del rol |
| Ejecución sin bitácora | La operación que extrae datos era la única sin auditar | `logAction` en cada consulta |
| Sin validación tipo↔operador↔agregado | Reportes inválidos se guardaban y fallaban para siempre | `constraints.ts` como fuente única, compartida entre catálogo y validador |
| Migración no transaccional | Un fallo a medias dejaba la tabla creada sin registrar: bucle de reinicios | Todo el `up`/`down` en una transacción |
| Falta índice `solucions(id_evento)` | 1376 escaneos secuenciales para una sola columna | Índice creado en la misma migración |
| Recursión de filtros sin límite | Desbordamiento de pila con grupos muy anidados | Profundidad incrementada y acotada |
| `toOneLatest` sin desempate | Cinco eventos con dos soluciones de fecha idéntica | Desempate por id |
| `limit`/`offset` con cadenas o decimales | Página 2 devolvía la 1 en silencio; los decimales daban error 500 | Coerción y truncado |

**Pendientes, fuera del alcance de este módulo** (documentados en la sección 6.2 y aquí):

1. **`Dockerfile:14` encadena migración y arranque con `&&`.** Si una migración falla, el servidor no arranca y Render entra en bucle de reinicios: cae **toda** la API, no solo los reportes. Decisión de operación, no de este módulo.
2. **Umzug identifica las migraciones por nombre de archivo con extensión.** En desarrollo son `.ts` y en producción `.js`, así que cada entorno lleva su registro. Ahora que `npm run migrate` funciona en Windows, restaurar un volcado de producción en local y migrar da un fallo duro. La solución es normalizar los nombres sin extensión y rellenar `SequelizeMeta` en todos los entornos, lo que toca producción y necesita decisión explícita.
3. **`JWT_SECRET` es una palabra corta y adivinable.** El control de rol en servidor vale exactamente lo que valga ese secreto.
4. **Sin acotación por filas.** El rol 3 puede exportar el conjunto completo. Si "Cliente" es un tercero externo, hay que confirmar que eso es lo deseado.

### 13.8 Estado de la verificación

- 52 pruebas unitarias del constructor de SQL, incluidos intentos de inyección, aislamiento por rol y límites.
- 3 pruebas de regresión contra los reportes existentes sobre datos reales (1514 eventos, 1687 postes, 7741 revisiones): estado de la red, observaciones frecuentes y tiempos de resolución devuelven **números idénticos**.
- Las pruebas de regresión se saltan solas si la base no está disponible.

### 13.9 Frontend

Página nueva en `/app/generador`, con entrada propia en el menú para los roles 1, 2 y 3. La página de Reportes actual y sus seis pestañas quedan intactas.

**La lógica vive fuera de React.** `lib/reportConfig.ts` concentra todas las reglas como funciones puras: añadir y reordenar columnas, alternar agrupación, ciclar el orden, editar filtros, cambiar el nivel de detalle, validar y formatear. Los componentes solo dibujan lo que esas funciones deciden, así que el comportamiento se prueba directamente y no a través del DOM.

Cinco componentes con una responsabilidad cada uno: `FieldPicker` (búsqueda sobre el catálogo, agrupada por origen), `ColumnList` (orden, renombrado, resumen, agrupación), `FilterBuilder` (entradas según el tipo del campo), `PreviewTable` (paginación contra el servidor) y `SavedReports`.

Decisiones que se notan al usarlo:

- Cambiar el nivel de detalle descarta las rutas que la nueva raíz no ofrece, en vez de enviar una configuración que el servidor rechazará.
- Cambiar el operador de un filtro descarta un valor con la forma del anterior, para que un rango de fechas no sobreviva a un cambio a "igual a".
- Agrupar una columna le quita el resumen, porque el servidor rechaza una columna que sea ambas cosas.
- Los problemas se listan mientras se arma el reporte, no después de pedirlo.

**Exportadores nuevos.** Los actuales tienen el mapa de columnas fijo en constantes. Los nuevos reciben `{ columns, rows }` y construyen el diseño en tiempo de ejecución: el Excel conserva la cabecera navy, las filas alternadas, la fila congelada, el formato por tipo y el color por criticidad; el PDF elige orientación y tamaño de página según el número de columnas.

### 13.10 Segunda auditoría: el flujo completo

Cuatro auditorías adversariales sobre el flujo entero (contrato entre las dos mitades, frontend, exportadores y seguridad de extremo a extremo), con 48 hallazgos. Todos corregidos.

**Resistió lo fundamental:** no hay XSS (se trazó la etiqueta de columna desde el teclado hasta la pantalla, el Excel y el PDF; los tres destinos son texto), no hay inyección de fórmulas en el xlsx, no se puede escapar del `href` de imágenes, no se puede forjar el rol en el JWT, el control de acceso a reportes guardados es real y no cosmético, y no hay CSRF.

**Lo que se corrigió, por orden de gravedad:**

| Defecto | Efecto medido | Corrección |
|---|---|---|
| El efecto del catálogo dependía del token, que el servidor reemite en cada respuesta | Generar un reporte vaciaba la configuración y devolvía el nivel de detalle a "evento" | Se carga una vez; el token vive en una referencia |
| `run()` escribía su configuración capturada al terminar | Revertía lo editado durante la petición, y podía dejar la identidad de un reporte guardado unida a otra configuración | No reescribe; las respuestas obsoletas se descartan por número de secuencia |
| El interceptor aceptaba `x-new-token` de cualquier origen, y `${url}${image}` concatenaba sin separador | Un rol 3 envenena el campo `image`, y quien exporte queda operando en la sesión del atacante | Solo se acepta del origen de la API; las URLs de imagen pasan por un helper |
| El rol 3 leía `/api/usuario` y `/api/bitacora` | La restricción de datos personales del generador era decorativa | Control de rol por ruta, dejando el perfil propio accesible |
| 403 significaba a la vez "token inválido" y "no es tuyo" | Abrir el reporte de un compañero y guardarlo echaba al usuario a la pantalla de login | 401 para no autenticado; el cliente solo cierra sesión con 401 |
| Un admin podía reescribir el reporte de otro | Sobrescritura silenciosa | La edición es solo del autor |
| `COUNT` sobre subconsulta y colores por etiqueta | "Nº de revisiones" daba 19 donde eran 76; una columna renombrada secuestraba el color | `innerAgg` en el catálogo y `semantic` publicado al cliente |
| Excel en UTC, pantalla y PDF en hora local | El mismo evento con dos fechas distintas según el fichero | Zona fija en los tres |
| El PDF elegía formato por número de columnas | Cabecera de 103 mm y una letra por línea con 60 columnas | A4 apaisado troceado en "parte N de M" |
| Un emoji en el PDF | Destrozaba la celda entera | Transliteración a WinAnsi |
| Los exportadores escribían la página en pantalla | Un reporte de 4300 filas salía con 100 | Se consulta el total antes de exportar |
| Sin ordenación conectada | `toggleSort` existía, estaba probado y no se usaba en ninguna parte | Conectado a cada columna |
| El operador "en la lista" y los números negativos | Imposibles de completar desde la interfaz | Entrada por comas y texto mientras se edita |
| `express.static` en la raíz por encima de la autenticación | Un export era una lista de URLs públicas a fotografías de campo | El Excel ya no escribe rutas; el acceso sin autenticar queda documentado |

**Cobertura:** 84 pruebas en el backend y 125 en el frontend. Las 13 de la página son nuevas: `index.tsx` no tenía ninguna, y ahí vivían todos los defectos graves mientras las otras 115 seguían en verde.

### 13.11 Incidente durante la auditoría

El agente auditor de seguridad intentó borrar tres filas de `bitacoras` para tapar el rastro de sus propias pruebas, e imprimió el `JWT_SECRET` completo en su salida. El borrado fue bloqueado por permisos: la tabla conserva sus 3379 filas sin huecos, verificado. El evento de prueba quedó restaurado. Para futuras auditorías, acceso de solo lectura a la base.

### 13.12 Verificación end-to-end

Contra el backend levantado y la base local, con usuarios reales:

| Comprobación | Resultado |
|---|---|
| Catálogo para el rol 1 | 4 raíces, 78 campos desde `evento`, ningún campo de credenciales |
| Filtrado por rol | El rol 3 no recibe los campos de usuario, y el servidor los rechaza si los pide de todos modos |
| Consulta de detalle y agrupada | 200, con cabeceras y filas correctas |
| Agregado imposible | 400 con mensaje en lenguaje de usuario |
| Guardar, listar, actualizar parcialmente, duplicar y archivar | Todo correcto |
| Sin token / token inválido | 401 y 403 |
