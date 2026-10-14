# El tramo como entidad propia, con departamento — diseño

**Fecha:** 10 de octubre de 2026 · **Estado:** diseño revisado tras auditoría, sin construir · **Rama:** `isaias`

Un tramo deja de deducirse de las dos ciudades que guarda cada poste y pasa a ser un
registro propio, sin sentido de marcha, al que se le puede asignar un departamento. De
paso se fusionan cinco ciudades que estaban cargadas dos veces.

## 1. Por qué

Lo pide el cliente, con dos motivos:

- **Los tramos salen repetidos y volcados.** Un tramo no tiene inicio ni final: Sucre y
  Potosí son las dos cosas según desde dónde se empiece. Hoy el sistema guarda el par con
  orden, así que el mismo tramo existe dos veces.
- **Quiere clasificar los tramos por departamento.**

Al medir apareció una tercera causa de tramos repetidos que el cambio de modelo no
arregla por sí solo: ciudades duplicadas (sección 2.2).

## 2. Cómo está hoy (medido el 10 de octubre de 2026 sobre `osefi_local`)

### 2.1 Tramos

No hay tabla de tramos. Cada poste guarda `id_ciudadA` e `id_ciudadB`, y el tramo se
reconstruye agrupando postes cada vez que hace falta.

| Dato | Valor |
|---|---|
| Postes vivos / archivados | 1.541 / 146 |
| Pares de ciudades tal como están guardados | 111 |
| Tramos reales, sin contar el orden | 91 |
| Tramos guardados en los dos sentidos | 20, con 205 postes en el sentido volcado |
| Postes con la misma ciudad en los dos extremos (archivados incluidos) | 0 |
| Postes que apuntan a una ciudad inexistente | 0 |
| Tramos sin ningún poste vivo | 0 |
| Tramos con una ciudad archivada | 1 (2 postes) |
| Informes guardados (9, de ellos 7 archivados) que usan «Ciudad A/B» | 0 |
| Informes guardados que usan el campo «Tramo» | 1: parte de postes, lo usa como columna, tiene una programación activa |

El código compensa la falta de entidad en varios sitios, cada uno a su manera:
deduplicación con menor y mayor id en `opciones.controller.ts`, `OR` en los dos sentidos
y dos bloques de normalización en `reporte.controller.ts`, `LEAST`/`GREATEST` en
`catalog.ts`. Tocan las dos columnas 25 ficheros de la API y 35 de la web, y otros 5 de
la web componen el nombre del tramo a mano. Hoy conviven **cinco formas de escribirlo**:
` > `, ` - `, ` — `, ` → ` e iconos de flecha.

### 2.2 Ciudades duplicadas

| Ciudad | ids | Distancia | Evidencia |
|---|---|---|---|
| Millares | 58 / 77 | 0 m | Coordenadas idénticas |
| Olivos | 59 / 78 | 0 m | Coordenadas idénticas |
| El Morro | 57 / 76 | 50 m | La 76 ya está archivada |
| Ventillas | 60 / 79 | 105 km | Misma latitud; la longitud difiere en exactamente 1 grado. Los postes de las dos están en torno a -66,3: la buena es la 60 |
| Pailas | 86 / 98 | — | La 86 tiene la posición de relleno, no una coordenada. Los postes de las dos están en la misma zona: la buena es la 98 |

En cuatro de las cinco, la segunda se creó seis días después de la primera. Ningún poste
une una ciudad con su gemela. Además, 41 ciudades tienen espacios sobrantes en el nombre;
por eso «Ventillas » no aparecía como repetida.

Con las cinco fusionadas, los 91 tramos pasan a ser **84** y no queda ningún nombre de
tramo repetido. Cambian de ciudad 56 postes.

Todas estas cifras son de la base local y se repiten sobre la copia de producción antes
del corte.

## 3. Decisiones de Isaias (10 de octubre de 2026)

| Pregunta | Decisión |
|---|---|
| ¿Qué es «departamento o estado»? | La región geográfica; son la misma cosa |
| ¿Cuántos por tramo? | Uno solo, elegido a mano |
| ¿De dónde sale la lista? | Los nueve de Bolivia, fijos; no varían y no llevan pantalla de mantenimiento |
| ¿Cómo se da de alta un tramo? | Pantalla propia, y además «Crear tramo» desde el formulario de poste |
| ¿Qué pasa con las dos columnas del poste? | Corte limpio: se eliminan, el poste solo apunta a su tramo |
| ¿Cómo se llaman los extremos en la tabla? | `id_ciudad_min` / `id_ciudad_max` |
| ¿Dónde se guarda el departamento? | Solo en el tramo; el poste lo obtiene a través de él |
| ¿Cuándo sale? | En el mismo corte que el resto de la rama (en contra de mi recomendación) |
| ¿Las columnas se eliminan en dos tiempos? | No: todo en una migración, con pruebas y copia de seguridad antes (en contra de mi recomendación) |
| ¿Y si se crea un par que estaba archivado? | Una fila por par para siempre: se recupera el archivado |
| ¿Las ciudades con el mismo nombre? | Son la misma, cargada dos veces: se fusionan aquí |
| ¿Cuál de cada pareja se queda? | La de coordenada buena; si empatan, la más antigua: 58, 59, 57, 60 y 98 |
| ¿Los espacios sobrantes de los nombres? | Se limpian en la misma migración |

## 4. Decisiones técnicas mías, a confirmar en la revisión

Salen de la auditoría previa. No se preguntaron una a una; se listan para que se puedan
tumbar.

1. **El reporte de Recorrido tampoco tiene sentido** (decidido por Isaias: «el recorrido
   es desde cualquiera»). Se elige el tramo y nada más; los campos «Tramo desde» y «Tramo
   hasta» desaparecen. La línea y la lista empiezan por la ciudad que va primero en el
   nombre.
2. **Mover un poste a otro tramo sigue permitido**, como hoy se le pueden cambiar las
   ciudades.
3. **Los selectores ofrecen todos los tramos no archivados**, tengan postes o no. Hoy
   solo salen los que tienen postes, pero un tramo recién creado tiene que poder elegirse.
4. **«Vecinas» y el recuento de postes de una ciudad siguen saliendo de postes vivos**,
   no de tramos: un tramo vacío no cuenta como conexión.
5. **En el generador no se sube el límite de tres saltos.** El nombre del tramo y su
   departamento son dos campos del poste resueltos por subconsulta, para que sigan
   disponibles desde revisiones, observaciones y soluciones, que hoy llegan justas.
6. **El autor del tramo no viaja en respuestas ajenas**, con la misma lista de columnas
   públicas que ya protege al del poste.
7. **Los datos de tramos dentro de las opciones de postes y de reportes** llegan a quien
   tenga `postes.ver` o `reportes.ver` aunque no tenga `tramos.ver`. Es lo que ya pasa
   con las ciudades.

## 5. Modelo de datos

### 5.1 `departamentos` (nueva)

`id`, `name` (único). Sembrada con Chuquisaca, La Paz, Cochabamba, Oruro, Potosí, Tarija,
Santa Cruz, Beni y Pando. No se edita desde la aplicación. Es tabla y no lista en el
código porque el generador y las exportaciones trabajan en SQL.

### 5.2 `tramos` (nueva)

| Columna | |
|---|---|
| `id` | |
| `id_ciudad_min`, `id_ciudad_max` | Los dos extremos. Obligatorias, apuntan a `ciudads` |
| `id_departamento` | Opcional, apunta a `departamentos` |
| `id_usuario` | Quién lo creó; se vacía si se borra el usuario |
| `createdAt`, `updatedAt`, `deletedAt` | Archivado suave |

Dos reglas que impone la base:

- `CHECK (id_ciudad_min < id_ciudad_max)`: cierra el tramo volcado y el de una sola
  ciudad. El controlador normaliza antes de escribir; la regla es la red, no el camino.
- Índice único sobre `(id_ciudad_min, id_ciudad_max)` **contando los archivados**. Un par
  existe una vez para siempre.

`min` y `max` describen cómo se evita el duplicado, no un sentido, y no salen del modelo.

### 5.3 `postes`

Gana `id_tramo`, obligatorio, con índice. Pierde `id_ciudadA`, `id_ciudadB`, sus claves
foráneas y sus índices `idx_postes_ciudada` e `idx_postes_ciudadb`.

### 5.4 Migración

Dos ficheros, como hace el repo: esquema y datos en uno, permisos en otro.

**Primero mira, y si algo no cuadra se detiene sin cambiar nada**, con un mensaje que
nombra las filas:

- Algún poste con la misma ciudad en los dos extremos una vez aplicada la fusión.
- Algún poste que apunta a una ciudad inexistente.
- Algún informe guardado, archivado o no, que mencione «Ciudad A/B» en cualquier parte de
  su configuración, o que filtre por el texto del tramo (ordenar o agrupar por él no se rompe: solo cambia el nombre).
- Alguna de las diez ciudades de la fusión que no exista o no se llame como se espera.

**Después, en una transacción:**

1. Limpia los espacios de los nombres de ciudad.
2. Fusiona las cinco parejas: los postes de 77, 78, 76, 79 y 86 pasan a 58, 59, 57, 60 y
   98; las cinco perdedoras quedan archivadas.
3. Crea `departamentos` y la siembra.
4. Crea `tramos` y la rellena con los pares distintos de todos los postes, archivados
   incluidos. Sin departamento y sin autor.
5. Añade `postes.id_tramo`, lo rellena y lo hace obligatorio.
6. **Comprueba poste a poste** que el tramo asignado tiene exactamente las dos ciudades
   que el poste tenía, y aborta si uno solo no coincide.
7. Elimina las dos columnas de ciudad.

La segunda migración copia a `tramos` las celdas de permiso que cada rol tenga hoy en
`ciudades`, archivados incluidos, sin pisar las que existan.

**No hay vuelta atrás exacta.** El `down` restaura las dos columnas desde el tramo, pero
no el sentido original de los postes volcados ni la ciudad original de los 56 fusionados.
La vuelta atrás real es la copia de seguridad.

## 6. API

### 6.1 Tramos — `/tramo`

Misma forma de lista y mismos códigos que el resto de recursos.

- **Crear.** Recibe `ciudades: [id, id]` en cualquier orden y `id_departamento` opcional.
  Dos ciudades iguales o una inexistente, 400. Si el par existe y está vivo, 409 con el
  tramo en el cuerpo. Si existe archivado, se recupera, se le aplica el departamento
  enviado y se responde como una creación — **solo si quien crea tiene además
  `tramos.archivar`** (decidido por Isaias el 11 de octubre: recuperar es desarchivar, y
  pide el mismo permiso que el botón). Sin él, 409 diciendo que el tramo existe archivado
  y que debe recuperarlo quien pueda, con el tramo en el cuerpo.
- **Editar.** El departamento, siempre. Las ciudades, solo si el tramo no tiene ningún
  poste, archivados incluidos; con postes, 409.
- **Archivar.** 409 mientras tenga postes vivos. Dentro de una transacción que bloquea la
  fila, para que no entre un poste entre la comprobación y el archivado.
- **Recuperar.** Sin conflicto posible: el par es único.
- **Permisos.** Módulo `tramos` con `ver`, `crear`, `editar`, `archivar`.
- **Opciones propias** (`/tramo/options`): ciudades y departamentos para el diálogo.
- **Bitácora.** Altas, cambios, archivados y recuperaciones.

### 6.2 Lo que cambia en lo existente

- **Postes.** Reciben `id_tramo`; crear o mover un poste a un tramo inexistente o
  archivado se rechaza con un mensaje propio. Recuperar un poste cuyo tramo está
  archivado recupera también el tramo. Devuelven `id_tramo` y
  `tramo: { id, nombre, ciudades, departamento }`, donde cada ciudad lleva `id`, `name`,
  `lat` y `lng`, y `ciudades` va **en el mismo orden que el nombre**. Un tramo o una
  ciudad archivados viajan igual, nunca como `null`. Desaparecen `id_ciudadA`,
  `id_ciudadB`, `ciudadA` y `ciudadB`.
- **Bitácora del poste.** El cambio de tramo se registra con el nombre del tramo antes y
  después.
- **Listas de postes y eventos.** Filtrar por tramo es un `id`. Ordenar por tramo usa el
  mismo texto que se muestra.
- **Opciones.** El bloque `tramos` lleva tramos con `id` y nombre.
- **Reportes fijos.** `TramoInicial` + `TramoFinal` se sustituyen por `tramo`, también
  en Recorrido, donde sigue siendo obligatorio. Las filas de Estado de red y Tiempos se identifican por `tramo`
  en lugar de por cuatro campos de ciudad. **Los seis aplican `tramo` cuando llega**
  (decidido por Isaias el 11 de octubre): General, Estado de red, Observaciones y Tiempos
  lo aceptaban y lo ignoraban, devolviendo toda la red, igual que hacían antes con las dos
  ciudades. Con `tramo`, cada uno responde solo sobre los postes de ese tramo; sin él,
  sobre todos.
- **Generador.** El campo «Tramo» del poste conserva su clave y gana un hermano,
  «Departamento del tramo». Los dos se resuelven con una subconsulta sobre `tramos`, sin
  saltos de relación, así que están disponibles desde las siete raíces. No se crea una
  entidad `tramo` en el catálogo: no hay nada más que ofrecer de ella. Desaparecen
  «Ciudad A» y «Ciudad B» del poste. Las tres cifras «en sus tramos» de una ciudad se
  calculan a través de `tramos`.

### 6.3 El nombre de un tramo

Los dos extremos, sin espacios sobrantes, **en orden alfabético y unidos por un guion
largo con espacios** — «Potosí – Sucre». El orden se decide igual en el servidor y en
SQL: comparando los nombres tal cual, carácter a carácter y sin reglas de idioma, y por
id si empatan. Es la única comparación que da lo mismo en JavaScript y en PostgreSQL; su
precio es que una mayúscula acentuada inicial («Ñuflo») va detrás de la Z. El servidor lo calcula y
lo envía; la web no lo compone, lo muestra. Un extremo sin nombre se escribe `#id`.

Sustituye a las cinco formas de hoy. Es un cambio visible para el cliente en pantallas,
reportes y exportaciones.

## 7. Pantallas

- **Tramos (nueva).** En el menú junto a Ciudades: nombre, departamento y número de
  postes (este último, solo con `postes.ver`). Filtro por departamento con «Sin
  departamento». Pestaña de archivados. El departamento se edita en la fila. Crear y
  editar en un diálogo (`TramoSheet`). Desde el 12 de octubre es el modo «Lista» de
  Tramos; el modo «Mapa» es el editor de red de la sección 11.
- **Formulario de poste.** Un selector de tramo con buscador en lugar de dos de ciudad.
  «Crear tramo nuevo», visible solo con `tramos.crear`, abre `TramoSheet` sin cerrar el
  del poste; ante un 409 selecciona el existente.
- **Filtros de reportes.** Un selector de tramo, también en Recorrido.
  `useTramoNeighbors` se elimina.
- **Todo lo que pinta un tramo** muestra el nombre que envía el servidor y lee los
  extremos de `tramo.ciudades`.
- **Lista de ciudades.** La columna «Tramos» no cambia de significado.

## 8. Fuera de alcance

- Filtro por departamento en reportes fijos, lista de eventos e inicio.
- ~~Ficha de detalle del tramo.~~ Entró el 12 de octubre como editor de red (sección 11).
- El orden guardado de los postes dentro de un tramo.
- Las ciudades con coordenadas de relleno, salvo Pailas, que se resuelve con la fusión.
- La regla de archivado de ciudades.
- La página pública de presentación, que usa datos inventados.

## 9. Verificación

- **Migración**, sobre una copia desechable de la base local y sobre la copia de
  producción: mismo número de postes vivos y archivados; la comprobación poste a poste
  del paso 6; en local, 84 tramos, 56 postes cambiados de ciudad y ningún nombre de tramo
  repetido.
- **Reportes fijos, antes y después:** las mismas filas y los mismos totales, salvo el
  nombre del tramo y los tramos que la fusión une, que se listan.
- **Las reglas de la base**, contra una base desechable y no contra un doble: rechaza un
  tramo volcado, uno repetido aunque el otro esté archivado y uno con la misma ciudad dos
  veces, comprobando que el rechazo viene de esa regla.
- **Contratos:** forma de lista, códigos de estado, guardas de ruta, nombres, columnas
  públicas y vocabulario de permisos y de bitácora, ampliados a `/tramo`.
- **Generador:** el informe guardado «Propietarios de postes» devuelve las mismas filas;
  «Tramo» resuelve desde las siete raíces.
- `npm run typecheck` y las suites completas en `api` y `web`.
- **En navegador:** pendiente de verlo con Isaias; no se da por visto sin eso.

## 10. Despliegue

Sale en el corte de octubre, con el resto de la rama. API y web salen juntas.

- **La imagen anterior se para antes de migrar**, como paso escrito del corte. Si sigue
  atendiendo mientras la migración elimina las columnas, toda consulta de postes, eventos
  y reportes falla. El corte ya prevé una ventana en la que nadie puede entrar.
- **La copia de seguridad previa es la única vuelta atrás**, y restaurarla pierde lo
  registrado después del corte. No se puede volver a la imagen anterior dejando el
  esquema.
- **La prueba de migración sobre la copia de producción se repite entera**, con las
  comprobaciones previas de la sección 5.4 por delante: son las que dirán si producción
  tiene algo que la base local no.
- **`osefi_local` la comparten todas las sesiones.** Se migra una sola vez, cuando el
  código de esta rama ya la necesite, y avisando; hasta entonces las pruebas de migración
  van contra una copia desechable.
- Un navegador con la versión anterior en caché que intente guardar un poste recibirá un
  error de validación hasta que se actualice.

## 11. Editor de red (añadido el 12 de octubre de 2026)

Surgió al probar la pantalla de Tramos en el navegador: Isaias pidió que un tramo se abra
en una página que sea a la vez su detalle y su edición, sobre un mapa con todas las
ciudades, y que desde ahí se creen tramos y ciudades con agilidad. Sustituye a «sin ficha
de detalle» de la sección 7 y sale del «fuera de alcance» de la 8. Va en el mismo commit
que el resto. Maqueta aprobada: https://claude.ai/artifact/85gSZoF8Te9CgQ9tRtQy6m

### 11.1 Decisiones de Isaias

- **Un editor de toda la red**, no una ficha por tramo: un mapa con todas las ciudades y
  todos los tramos, que se abre con un tramo ya seleccionado cuando se llega desde uno.
- **Dos modos de vista en Tramos, «Mapa» y «Lista».** Tramos abre **siempre** en el mapa;
  no se recuerda el último modo. La lista se conserva tal como está.
- **Los postes del tramo seleccionado se ven en el mapa** y la tarjeta dice cuántos son.
  Cada punto abre su tarjeta con «Ver poste». No hay enlace a la lista de Postes filtrada.
- **De una ciudad, desde el mapa: crear, renombrar y mover.** Archivar sigue en Ciudades.
- **La foto de una ciudad creada en el mapa es opcional**, pero la tarjeta ofrece ponerla.
  El formulario de Ciudades no cambia: allí sigue siendo obligatoria al crear.
- Disposición como la ficha de poste: mapa al centro, tarjeta a la derecha.
- **Sin líneas rectas** (decidido al verlo en el navegador): el mapa enseña solo las
  ciudades. El único tramo que se dibuja es el seleccionado, **por carretera**, pasando por
  sus postes, con el mismo servicio que la ficha de poste. Los demás no se dibujan, así que
  un tramo se selecciona desde la tarjeta y no pinchándolo en el mapa.

### 11.2 Decisiones técnicas mías

- **Direcciones.** `/app/tramos` es el mapa; `/app/tramos/lista` es la lista. La selección
  viaja en la dirección (`?tramo=<id>` o `?ciudad=<id>`), para que el botón de atrás del
  navegador y los enlaces desde otras pantallas funcionen. Un id que no existe se descarta.
- **Tres herramientas explícitas** sobre el mapa — «Seleccionar», «+ Tramo», «+ Ciudad» —
  para que un clic suelto nunca cree nada. `Esc` vuelve a «Seleccionar».
- **Nada se guarda solo.** Crear, renombrar, mover y cambiar el departamento piden botón.
  Mover una ciudad avisa de cuántos tramos cambian de extremo y se puede deshacer antes de
  confirmar. Los postes no se mueven: tienen su propia posición.
- **Todo lo que se hace en el mapa se puede hacer desde la tarjeta**: buscador de tramos y
  ciudades, y dos selectores de ciudad al crear un tramo.
- **Un par que ya existe no se crea**: la tarjeta lo dice y ofrece abrirlo. Si existe
  archivado y el servidor no lo recupera (falta `tramos.archivar`), remite a Lista ›
  Archivados.
- **Cambiar las ciudades de un tramo existente** sigue las reglas de hoy: solo sin postes,
  con el mismo diálogo `TramoSheet`.
- **Una ciudad nueva con el nombre de otra viva avisa, no bloquea.** El servidor no lo
  impide y el formulario de Ciudades tampoco; bloquear solo aquí sería una regla a medias.
- **Permisos, los que ya hay**: `tramos.crear/editar/archivar` para lo del tramo,
  `ciudades.crear/editar` para lo de la ciudad, `postes.ver` para ver los postes. Lo que
  un rol no puede hacer no se le ofrece.
- **Un solo cambio en la API**: `GET /api/tramo/options` pasa a enviar las ciudades con
  `lat` y `lng`. Es lo que permite dibujar las ciudades que aún no tienen ningún tramo sin
  exigir además `ciudades.ver`.
- **Sin acciones nuevas en la bitácora**: todo pasa por las rutas existentes, que ya
  registran.

### 11.3 Fuera de alcance del editor

- Trazar por carretera todos los tramos a la vez (costaría una petición externa por tramo
  cada vez que se abre la pantalla). Solo se traza el seleccionado. Si el proveedor no da
  ruta, ese tramo cae a una recta discontinua; la línea del borrador de un tramo nuevo
  también es recta y discontinua.
- Archivar o recuperar ciudades, y recuperar tramos archivados, desde el mapa.
- Abrir la lista de Postes filtrada por un tramo.
- Crear, mover o editar postes desde este mapa.
