# Auditoría del sistema de incidencias — estado

Cuatro revisiones en paralelo sobre `api` y `web`, lanzadas el 2026-08-22 para decidir el criterio
de un aviso de incidencias urgentes en la cabecera. Una de ellas tenía el encargo de atacar ese
diseño, y lo tumbó. Este documento es el estado de lo que salió: qué se arregló, qué queda, y qué
espera una decisión.

**Método, y no es un detalle.** Cada hallazgo de los agentes se verificó leyendo el fichero justo
antes de tocarlo. De los cinco más graves, **dos ya estaban arreglados** por otras sesiones y **uno
era falso**. Con ocho sesiones sobre el mismo árbol, un informe de hace dos horas describe un
sistema que ya no existe. Citar con `git show <sha>:ruta`, nunca con `sed` sobre el árbol.

## Hecho

| Qué | Dónde |
|---|---|
| El tema claro/oscuro se aplica en toda la aplicación; cuatro sitios lo resolvían por su cuenta | `0419acd` (web) |
| El estado de un evento salió del formulario de edición: el toggle de prioridad podía reabrir lo que otro acababa de resolver | `580fcfc` + test en `b60de8b` (api) |
| Los dos avisos de reabrir dicen que la fotografía se borra y no se recupera | `ca2fa4b` (web) |
| Una sola escala de colores para la gravedad, con test que impide escribir otra | `ca2fa4b` (web) |
| El contador de «Obs. crítica», los días negativos y el «hace Hoy», y las dos frases falsas del aviso rojo | `2c1f9e1` (web) |
| El gráfico de Actividad, descrito y traspasado al rediseño de `/app/home` | `f3df742` (api) |
| El gráfico de Actividad, ya arreglado por esa sesión: Isaias eligió flujos, y `pending`/`solved` pasaron a `entraron`/`salieron` | `adaa4ff` (web) |
| El CSV del recorrido exporta lo que hay en pantalla, y el botón dice cuántas filas se lleva | ver abajo (web) |
| La gravedad llega al navegador y se ve: columna en la tabla, insignia en la ficha, etiquetas teñidas por nivel, y también en Excel/CSV/PDF | ver abajo (api + web) |
| Filtros rápidos de estado, gravedad y prioridad sobre la tabla de incidencias, resueltos en el servidor | ver abajo (api + web) |
| Las bandas de gravedad (1-3 críticas, 4-5 altas…) se escribían en tres sitios; ahora en uno, con test a los dos lados del cable | ver abajo (web) |
| Recargar la tabla dejó de tirar los filtros: `load()` recargaba con los valores del primer render | ver abajo (web) |

## Descartado al verificar

- El hash de contraseñas filtrado en dos consultas — ya estaba arreglado.
- `createEvento` aceptando cualquier columna — ya estaba arreglado por `authoredBy`.
- `GET /api/dashboard` sin permiso — cerrado mientras auditábamos.
- «Editar puede escribir en otra fila» — **falso**: Sequelize protege la clave primaria de un
  registro ya cargado (`model.js:2281`, guard `originalValue &&`).

## Abierto — frontend, sin bloqueo

Verificado abierto el 2026-09-01 en `adaa4ff`. Los tres primeros de esta lista están **cerrados**;
lo que sigue es lo que queda.

4. **«N prioritarios» incluye los resueltos** (`ReportGeneralSec.tsx:334`, `list.filter(e =>
   e.priority)` sin `!e.state`).
5. **El «último evento» de una persona no es el último**: ordena por prioridad antes que por fecha
   (`useUsuarioDetalleData.ts:32`) y toma el primero.
6. **El rango personalizado pierde el último día** en las tarjetas de Inicio
   (`KpiCards.tsx:43`, medianoche local como cierre) mientras los informes y el propio gráfico de esa
   pantalla sí lo cubren.
7. **Tres formas de contar días**: distinto origen y distinto redondeo. La misma incidencia dice 6
   días en su ficha y 7 en el informe de tiempos.
8. **El mapa del recorrido usa un rojo que no está en su leyenda** e indistinguible del que sí
   significa «crítica».
9. **En el recorrido, el mapa y los contadores de arriba siguen sin filtrar.** No se arregló con el
   CSV a propósito: los filtros viven dentro de la tarjeta «Eventos del Tramo», y el mapa es otra
   tarjeta, encima. Hacer que el mapa obedezca a unos controles que están debajo de él es peor que
   dejarlo; el arreglo de verdad es subir los filtros al nivel de la pantalla, y eso cambia la
   distribución. **Decisión de Isaias, no bug.**

## Abierto — zona de otras sesiones

Lo más grave que queda. Es el terreno de quienes llevan autenticación y permisos.

1. **Los permisos de lectura no se comprueban.** Ocho consultas sin `requirePermission`, una de ellas
   devuelve todas las soluciones del sistema sin paginar.
2. **`routeGuards.test.ts` solo recorre las escrituras.** Causa raíz: cada lectura nueva hereda el
   hueco en silencio, con la suite en verde.
3. **Los permisos nunca se refrescan en el navegador.** El mecanismo espera una cabecera que ningún
   endpoint emite; el canal previsto (`GET /api/permisos/mias`) no lo llama nadie.
4. **`reportes.ver` y `generador.ver` son puertas laterales completas** a los datos de eventos.
5. **Invalidar la caché de permisos no cancela la carga en vuelo**, que puede recachear los valores
   viejos durante un TTL entero.

Y el **gráfico de Actividad**, en `HALLAZGO-GRAFICO-ACTIVIDAD.md`.

## Esperando decisión de Isaias

1. **¿Borrar un rol borra a sus usuarios?** `RolModel` es el único modelo sin `paranoid`. Si la FK de
   `usuarios.id_rol` es CASCADE, borrar un rol desde Seguridad borra permanentemente a esas personas.
   Una consulta lo resuelve: `SELECT conname, confdeltype FROM pg_constraint WHERE conrelid =
   'usuarios'::regclass;` — `confdeltype = 'c'` es cascade. **Es lo único de toda la auditoría que
   pierde datos con un clic.**
2. **Las cifras reales** de prioritarios abiertos y cuántos pasan de una semana. Es lo único que
   desbloquea el criterio del aviso de cabecera.
3. **«Crítico» significa cuatro cosas**: el indicador manual, gravedad ≤3, gravedad 1, y «cinco
   revisiones o más». Hay que quedarse con una.
4. **La gravedad se reescribe hacia atrás.** No se guarda el nivel que tenía la observación cuando
   ocurrió el evento, solo un enlace al catálogo. Bajar un nivel —desplegable de un clic, sin
   confirmación— deja de considerar críticos cientos de eventos históricos y hace irreproducible un
   informe ya entregado. Archivar una observación tiene el mismo efecto.

   **Y ya hay dos respuestas distintas conviviendo.** El filtro nuevo de la tabla de incidencias
   **sí** cuenta las observaciones archivadas, porque el listado las muestra y un filtro que
   escondiera lo que su propia columna pinta haría que la pantalla se contradijera sola. El
   generador de informes **no** las cuenta. No es un descuido: es la misma decisión sin tomar,
   asomando en dos sitios. Cuando se decida, se cambian los dos a la vez —
   `evento.controller.ts` y `reportBuilder/catalog.ts`, ambos con el comentario puesto.
5. **Las reglas que la base nunca tuvo**: estado no nulo con valor por defecto, fecha no futura,
   gravedad entre 1 y 9, y una sola solución viva por evento. Cambio de esquema en producción.
6. **Las fotografías se sirven sin autenticación.** En parte deliberado; debe ser decisión escrita.
7. **Los colores del mapa del recorrido**: unificarlos cambia su leyenda, y eso lo ve el usuario.
8. **«Des-resolver» y «Reabrir»** son la misma acción con dos nombres.

## El aviso de cabecera

El diseño está en `specs/2026-08-22-alertas-en-el-header-design.md`, **marcado como en revisión y no
implementar**. Lo que la auditoría tumbó: contar desde `createdAt` (70 eventos comparten el día de
una carga en lote, y `date` y `createdAt` divergen 157 días de media), el total sin filtro de días
como cifra del badge (779 pendientes contra 597 resueltos: el número sube y no baja), y `sinRevisar`
como medida de abandono, que es siempre cero porque los formularios obligan a una revisión inicial.
El desglose por gravedad además colapsaría: solo 84 de 1.376 eventos tienen gravedad 1-3.

Isaias quiere, para ese aviso: **el total de prioritarios abiertos como cifra**, neutro de color, en
**rojo solo si alguno pasa de la semana**, y el desglose dentro del panel que se abre al pulsarlo.
Falta el dato del punto 2 de arriba para confirmar que la cifra no queda clavada en un número alto.

## Menor, anotado

Archivar un evento no archiva sus revisiones ni observaciones · reabrir no reinicia el reloj ni deja
constancia · puede haber varias soluciones vivas por evento · `obs_ids` sin validar permite filas
duplicadas · endpoints vivos que la interfaz no usa y rompen invariantes · eventos de postes
archivados con tres comportamientos según la pantalla · `state = false` frente a `state IS NOT TRUE`
en el contador de pendientes de la lista de postes · el paquete del frontend pesa 3,2 MB en una
pieza.
