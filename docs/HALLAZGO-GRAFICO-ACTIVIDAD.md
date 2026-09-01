# El gráfico de Actividad no cuenta lo que dice contar

**Para quien lleva el rediseño de `/app/home`.** Salió en una auditoría de otra cosa —el criterio
de un aviso de incidencias urgentes en la cabecera— y no lo he tocado a propósito: `ActivityChart`
está dentro de vuestro alcance y arreglarlo por mi cuenta significaría que una de las dos versiones
se pierde. Isaias está al tanto y ha pedido que os lo pase.

Todo lo que sigue está verificado en **`869d97d`**. Cito con la revisión fijada porque el árbol se
mueve cada pocos minutos y una cita sin SHA no es verificable.

## 1. Las dos barras miden poblaciones distintas

`ActivityChart.tsx` explica el modo normal así:

> Eventos **creados** en el período, agrupados por su estado actual: **Pendientes** — sin resolver
> al día de hoy. **Solucionados** — ya resueltos.

Eso describe una lectura de cohorte: ambas series sobre lo que entró en el período. Pero
`useInicioData.ts` coloca `pending` por `evento.date` y `solved` por la **fecha de solución**
(`getSolDate`). Son dos ejes temporales distintos en el mismo gráfico.

Consecuencia: **un evento que entró en enero y se cerró en marzo no aparece en enero por ningún
lado.** Desaparece del mes en que llegó. La barra de enero no dice «entraron N», dice «de los que
entraron en enero, N siguen abiertos hoy», que además es una lectura que cambia sola con el paso
del tiempo.

Y el modo Balance hereda el problema. Un mes con 50 entradas, todas resueltas dentro del mismo mes:
`pending` = 0, `solved` = 50, y el tooltip anuncia **«+50 — se resolvió más de lo que entró»**.
Entró exactamente lo mismo que salió. El balance real es 0.

## 2. La regla cambia según el período elegido

Dos implementaciones distintas conviven, y el mismo mes puede dar cifras distintas según desde qué
vista se mire.

| Período | Dónde | Cómo cuenta `solved` |
|---|---|---|
| Quincena, mes, personalizado ≤ 1 año | `useInicioData.ts:175-185`, `192-202`, `232-242` | Dentro de un `else` de `if (!e.state)`: solo cuenta si el evento **está resuelto ahora** |
| Trimestre, año, personalizado > 1 año, todo | `useInicioData.ts:211-212`, `219-220` | Por fecha de solución, **sin mirar `state`** |

El caso que las separa: un evento **reabierto** que conserva su fila en `solucions`. En la vista
mensual cuenta como pendiente; en la trimestral, como resuelto. Mismo evento, mismo mes.

Es alcanzable sin nada raro: `reabrirEvento` soft-borra la solución, pero `PUT /api/evento/:id`
podía dejar `state` en false con una solución viva. Ese camino ya está cerrado —el `PUT` dejó de
aceptar `state`, ver `evento.lifecycle.test.ts`— pero las filas que quedaron así siguen ahí.

## 3. Sugerencia, no propuesta cerrada

La pregunta de fondo es qué mide el gráfico, y hay dos lecturas legítimas que responden cosas
distintas:

- **Flujo** — cuántas entraron y cuántas se cerraron en cada período. Es la pregunta de si el atraso
  crece o baja, y **es la única lectura con la que el modo Balance significa algo**.
- **Cohorte** — de lo que entró en cada período, cuánto sigue abierto. Responde si lo que llega se
  resuelve o se queda. Con esta, el Balance sobra.

Isaias quiere las dos, y tienen sentido las dos. La condición es que **no se llamen igual**: hoy
ambas series son «Pendientes» y «Solucionados», y esa colisión de nombres es el origen del enredo.
Una posible salida: *Entraron* / *Se cerraron* en flujo, *Siguen abiertas* / *Ya cerradas* en
cohorte.

Y un apunte que quizá ya tenéis: el selector actual (`CHART_TYPES`) mezcla **Área, Compuesto,
Barras** —tres formas de dibujar— con **Balance**, que es otra cosa medida. Meter una segunda medida
en esa misma fila la convierte en un cajón de opciones no comparables. Si separáis «qué mide» de
«cómo se dibuja», las dos lecturas caben sin ambigüedad y el Balance encuentra su sitio dentro de
flujo.

Vosotros tenéis la foto completa de la pantalla; yo solo estaba mirando esta tarjeta.

## 4. Lo que sí toqué en esa pantalla, para que no os sorprenda

Tres arreglos pequeños, ninguno en `ActivityChart` ni en el cálculo de `chartData`:

- **`UrgentEventsCard`** — el contador de la pestaña «Obs. crítica» contaba solo criticidad 1 y se
  ocultaba en cero, mientras su lista muestra los nueve niveles. Treinta filas bajo una pestaña que
  se leía como ninguna. Ahora cuenta sus propias filas. Con test.
- **`helpers.ts`** — `daysOpen` no tenía suelo, así que una fecha futura imprimía «-3 días»; y
  `PosteDetalleEventosAbiertos` lo envolvía en `hace {…}` y rendía «hace Hoy». Añadido `openedAgo`
  para el segundo caso. Con test.
- **`AlertBanner`** — decía «más de 7 días» contando `<= cutoff`, o sea 7 o más, y decía «desde su
  creación» cuando el filtro usa `evento.date`, que se teclea al registrar. Solo texto.

Si vuestro rediseño se lleva por delante cualquiera de los tres, adelante: son arreglos de dato y
de copy, no de forma.
