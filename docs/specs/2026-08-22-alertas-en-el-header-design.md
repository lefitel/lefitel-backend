# Alertas críticas en el header — diseño

> **Estado: en revisión, no implementar.** La auditoría del 2026-08-22 tumbó
> parte de este documento. Sigue en pie el §1 —el diagnóstico de las tres
> definiciones de «urgente» y el hueco entre `priority` y `criticality`— y la
> lista de lo descartado. **No** sigue en pie: contar los días desde `createdAt`
> (hay 70 eventos cargados en lote el 09/04/2024, y `date` y `createdAt`
> divergen 157 días de media, máximo 678); el total sin filtro de días como
> cifra del badge (779 pendientes contra 597 resueltos: el número sube y no
> baja); y `sinRevisar` como medida de abandono, que es siempre cero porque los
> dos formularios de creación obligan a una revisión inicial. Y el desglose por
> gravedad del panel colapsaría: solo 84 de 1.376 eventos tienen criticidad 1-3.
> El criterio está sin cerrar.

Saca el aviso de eventos prioritarios desatendidos de la pantalla de Inicio y lo
pone en la cabecera de la aplicación, visible desde cualquier pantalla, con el
desglose a un clic. De paso deja el criterio de «alerta» escrito en un solo
sitio: el servidor.

Toca los dos repositorios. En `api`, un endpoint nuevo. En `web`, el indicador
del header, su panel, y el banner de Inicio, que deja de calcular por su cuenta.

## 1. Por qué

El dato más importante del sistema solo se ve si estás en Inicio. Hoy
`useInicioData.ts` calcula `criticalAlerts` —eventos marcados como prioritarios,
sin resolver, con más de siete días abiertos— y lo pinta en un banner rojo. Si
estás en Postes, en Reportes o en Bitácora, no te enteras de que hay una
incidencia prioritaria sin atender desde hace nueve días.

Y hay un problema anterior a este: en esa misma pantalla conviven **tres
definiciones distintas de urgente**, y ninguna cuenta lo mismo.

| Dónde | Qué cuenta |
|---|---|
| Banner rojo (`AlertBanner`) | Prioritarios, abiertos, más de 7 días |
| Pestaña «Urgentes» (`UrgentEventsCard`) | Prioritarios y abiertos, sin importar la antigüedad |
| Pestaña «Obs. crítica» | Abiertos con cualquier observación clasificada, del nivel 1 al 9 |

La tercera además se contradice consigo misma: la lista incluye hasta el nivel 9
—«Mantenimiento», que no es urgente— mientras el contador de su propia pestaña
cuenta solo los de nivel 1. Lista y número miden cosas diferentes.

Con tres cifras en una pantalla, añadir una cuarta en el header la empeora. Si el
header dice 3 y el banner dice 11, se deja de creer a los dos. De ahí que este
diseño no consista solo en añadir un indicador, sino en dejar una única
definición y que todos la lean.

### Los dos ejes del dominio

Conviene tenerlos claros porque de ahí sale la discusión del criterio:

- **`priority`** es un booleano que una persona marca a mano.
- **`criticality`** sale de las observaciones del evento, es decir de lo que se
  vio físicamente en el poste, y va del 1 al 9: Catastrófico, Ferretería suelta,
  Sujeto a árbol, Daño estructural, Vano bajo, Fricción, Estresado,
  Antivibradores, Mantenimiento. Uno es el más grave. La gravedad de un evento
  es el mínimo de sus observaciones (`getEventCriticality`).

Son independientes, y ahí está el hueco conocido: **un poste con una observación
«Catastrófico» que nadie marcó como prioritario no aparece en el banner rojo**, y
al revés, un evento marcado prioritario cuya única observación es
«Mantenimiento» sí sale. Este diseño no lo arregla; lo documenta y deja el camino
abierto (§2).

Hay un tercer eje que ninguna alerta usa hoy: las **revisiones**. Un evento
abierto sin ninguna visita en tres semanas está abandonado y nadie avisa.

### Lo que se descartó, y por qué

**Un resumen de totales visible en el header** («12 abiertos · 3 críticos · 5 sin
revisar»). La idea es buena, el sitio es el equivocado. Información que siempre
está presente y siempre dice algo acaba no diciendo nada: a la semana ya no se
lee. Además no cabe —el header deja 32 px útiles cuando el sidebar está
colapsado, y tres cifras con etiqueta compiten con las migas de pan y no entran
en móvil— y duplica lo que Inicio ya es. El desglose no se pierde: se mueve
dentro del panel (§5), donde tiene espacio y solo aparece cuando se pide.

**Un endpoint por consumidor**, uno para el badge y otro para el banner. Son dos
consultas y dos lugares donde el criterio puede divergir, que es exactamente el
problema que venimos a cerrar. El payload es diminuto: un total, un desglose y
cinco filas. No hay nada que ahorrar partiéndolo. Si algún día el header
necesitara solo la cifra, es un parámetro del mismo endpoint.

**Tiempo real (WebSocket o SSE).** El criterio exige siete días abiertos, así que
un evento recién registrado **no puede entrar en el contador**: no es que tarde
en aparecer, es que no debe aparecer. Lo que sí mueve la cifra por acción de otra
persona —resolver, reabrir, marcar prioridad, archivar— no cambia ninguna
decisión por llegar cinco minutos tarde; hablamos de un contador de cosas
desatendidas desde hace más de una semana. El coste sería montar el transporte,
autenticar la conexión, gestionar reconexiones y decidir el comportamiento con la
pestaña en segundo plano, en un backend que hoy es Express plano sin nada de
sockets. Lo que de verdad se percibe como «desactualizado» es resolver algo y ver
que el número no baja, y eso lo cubre §7 sin canal permanente. Si algún día hace
falta, SSE encaja encima de este diseño sin rehacer nada.

**Reusar `GET /api/dashboard`.** Trae todos los eventos y todos los postes con
sus relaciones, sin filtrar ni paginar. Pedirlo desde el header en cada pantalla
no es viable, y la consulta crece con la base de datos.

**Añadir filtros a `GET /api/evento` y contar en el navegador.** Obliga a
traerse filas solo para contarlas y deja el criterio escrito en el frontend, que
es justo de donde queremos sacarlo.

**Plazos por gravedad** (un Catastrófico vence en 24 h, Ferretería suelta en 3
días, el resto en una semana, Mantenimiento nunca). Es el criterio correcto a
medio plazo y el único que respeta el hueco descrito arriba, pero exige acordar
los plazos con el cliente, y acordarlos sin haber visto qué cifras salen en
producción es adivinar. Aplazado, no descartado: §2 y §3 están escritos para que
cambiar el criterio sea cambiar una función en el servidor.

**Colgar el endpoint de `/api/dashboard`.** Las alertas son sobre eventos, no
sobre una pantalla. Atarlo al Inicio justo cuando lo va a leer toda la
aplicación sería heredar el nombre equivocado.

### Lo que se verificó antes de decidir

- `GET /api/dashboard` hace dos `findAll` sin `where` ni `limit`, con seis
  modelos incluidos. Confirmado en `dashboard.controller.ts`.
- `GET /api/evento` solo admite filtro por `description` y por nombre de poste.
  No hay filtro por `state`, `priority` ni antigüedad, así que el badge no se
  puede alimentar de ahí sin tocar el controlador.
- No hay ninguna dependencia de sockets en `api/package.json`; el servidor es
  Express sobre Docker.
- Todas las rutas pasan por `authenticate`, y el módulo de eventos tiene ya
  `requirePermission` en crear, editar y archivar.
- El header mide 48 px cuando el sidebar está colapsado
  (`group-has-data-[collapsible=icon]/sidebar-wrapper:h-12`) y con el `p-2`
  actual deja 32 px de alto útil. Lo que se añada tiene que caber en `h-8`.
- `useInicioData.ts:288` reimplementa a mano el `getEventCriticality` que ya
  existe en `web/src/lib/criticality.ts`. Duplicación real que este diseño
  elimina al mover el cálculo al servidor.

## 2. El criterio

Un evento entra en las alertas cuando cumple las tres condiciones:

1. `priority` es verdadero,
2. `state` es falso, es decir sigue abierto,
3. han pasado más de **7 días** desde `date`.

Es exactamente el criterio que hoy usa el banner rojo. Se elige por coherencia
inmediata: el número que aparecerá en el header es el mismo que la gente ya ve en
Inicio, así que nadie tiene que aprender nada nuevo ni desconfiar de dos cifras.

**El umbral no se escribe suelto.** Vive en una constante única del controlador
de eventos, junto a la función que construye el `where` de las alertas, y las dos
se exportan para que las pruebas interroguen la misma definición que usa el
endpoint. Endurecer el criterio más adelante —plazos por gravedad, o incluir los
de criticidad 1 y 2 aunque nadie los haya marcado— es editar ese sitio, no
perseguir condiciones repartidas.

La regla que este criterio debe seguir cumpliendo, y con la que hay que juzgar
cualquier cambio futuro: **el badge dice «esto se te está escapando», no «esto
existe y es grave», y el número tiene que bajar cuando el equipo trabaja.** Un
contador clavado en 40 se deja de mirar.

## 3. El endpoint

```
GET /api/evento/alertas
```

Devuelve el resumen **ya calculado**, no las filas para que el cliente cuente:

```jsonc
{
  "criterio":    { "diasUmbral": 7 },
  "total":       4,                    // la cifra del badge
  "porGravedad": [                     // solo niveles presentes, ya ordenados
                                       // de más grave a menos, con null al final
    { "nivel": 1,    "total": 2 },
    { "nivel": 4,    "total": 1 },
    { "nivel": null, "total": 1 }      // sin observación clasificada
  ],
  "sinRevisar":  3,                    // de los que cuentan, cuántos no tienen ninguna revisión
  "eventos": [                         // los 5 más antiguos
    {
      "id": 812,
      "descripcion": "…",
      "diasAbierto": 23,
      "gravedad": 1,                   // null si no hay observación clasificada
      "poste": { "id": 44, "nombre": "P-1032" }
    }
  ]
}
```

`criterio` viaja en la respuesta a propósito: el texto que explica al usuario qué
está contando se construye con ese valor, en lugar de repetir el «7» en el
frontend y arriesgarse a que un día diga una cosa distinta a la que el servidor
calcula.

**Declaración de la ruta.** Va **antes** de `GET /:id` en `evento.routes.ts`. Si
se declara después, Express interpreta «alertas» como un identificador y la ruta
nunca se alcanza. Es el error clásico y conviene dejarlo escrito.

**Permiso:** `requirePermission("eventos", "ver")`, como el resto de las rutas
del módulo (§8).

**Cómo se calcula.** El conjunto de alertas es pequeño por definición —son los
prioritarios abiertos que llevan más de una semana—, así que no hace falta SQL
retorcido:

1. Un `findAll` con `where: { priority: true, state: false, date: { [Op.lte]:
   corte } }`, ordenado por `date` ascendente, incluyendo las observaciones con
   su `criticality` y los identificadores de las revisiones. Nada de imágenes.
2. `total`, `porGravedad` y `sinRevisar` se agregan en el servidor sobre ese
   resultado, reusando la regla del mínimo por evento. `eventos` son los cinco
   primeros.

Se descarta hacerlo con un `GROUP BY` sobre subconsulta —que sería lo correcto
si el conjunto fuese grande— porque complica la consulta sin ganar nada a esta
escala. **El día que ese conjunto pase de unos pocos cientos de filas, esta
decisión hay que revisarla**, y el sitio donde revisarla es una sola función.

## 4. El indicador en el header

Va en el `ml-auto` de la cabecera de `HomePage.tsx`, a la izquierda del botón de
tema, con un separador vertical entre ambos: son cosas de naturaleza distinta y
pegarlas invita a pulsar la equivocada.

Un botón de icono de `h-8` —el alto útil disponible— con el número encima. El
número, no un punto: «hay algo» obliga a abrir el panel para saber si merece la
pena; «4» ya informa.

**Cuando `total` es 0, el indicador no se dibuja.** Un icono permanentemente
apagado enseña a ignorar ese rincón de la pantalla, y es además lo que ya hace
el banner de Inicio, que se oculta cuando no hay nada. Si no hay alertas no hay
nada que describir, y para la foto general está Inicio.

Mientras la primera petición está en vuelo no se dibuja nada. Un hueco que
aparece y desaparece en la cabecera es peor que un hueco que aparece tarde. Si
la petición falla, tampoco se dibuja: un indicador de alertas que miente por
exceso o por defecto es peor que ausente, y el fallo ya se ve en Inicio.

## 5. El panel

Se abre al pulsar el indicador. Un popover anclado, alineado a la derecha, no un
modal: consultar cuántas alertas hay no debe bloquear la pantalla.

Contenido, en este orden:

1. **Una frase con el criterio**, construida con `criterio.diasUmbral`:
   «4 eventos prioritarios llevan más de 7 días sin atender». Sin esa frase, el
   número es un dato sin definición y cada persona le supone la suya.
2. **Desglose por gravedad**, de más grave a menos, con la etiqueta y el color
   que ya usa `CriticalityBadge`. Los que no tienen observación clasificada van
   al final, como «Sin clasificar».
3. **Sin revisar**, si es mayor que cero: «3 no tienen ninguna revisión».
4. **Los cinco más antiguos**, con poste, días abiertos y su distintivo de
   gravedad. Cada fila lleva al detalle del evento y cierra el panel.
5. **Un enlace a la lista completa de eventos**, para el resto.

**El panel describe exactamente el mismo conjunto que el badge, y nada más.** No
se le añaden totales globales de eventos abiertos ni otras cifras del dashboard,
por tentador que sea: en el momento en que el panel cuenta cosas que el badge no
cuenta, volvemos a tener dos definiciones en la misma superficie, que es el
problema del §1.

## 6. Inicio deja de calcular

`AlertBanner` pasa a leer este endpoint. Se elimina `criticalAlerts` de
`useInicioData.ts`, con su `useMemo` y su umbral escrito a mano.

Es la parte que hace que el diseño valga: si el criterio vive en el servidor pero
el banner sigue calculándolo en el navegador, no hemos unificado nada, solo hemos
repartido el problema entre dos máquinas, que es peor que tenerlo en una.

Las dos pestañas de `UrgentEventsCard` **se quedan como están**. Su contradicción
—lista del 1 al 9 contra contador de nivel 1— es real y está anotada en §1, pero
arreglarla es otra conversación sobre qué significa cada pestaña, y mezclarla
aquí dispersa este cambio.

## 7. Frescura

La cifra se pide:

- al arrancar la aplicación,
- **cuando la pestaña vuelve al primer plano** (`visibilitychange`), que es lo
  que produce la sensación de «siempre al día»: vuelves después de un rato y lo
  primero que pasa es que el número se actualiza,
- cada 5 minutos en segundo plano, solo con la pestaña visible, para no gastar
  peticiones contra una ventana que nadie mira,
- e inmediatamente después de resolver, reabrir o cambiar la prioridad de un
  evento.

El último punto es el que más se nota y el más barato: lo que la gente lee como
«esto está desactualizado» casi nunca es el retardo, es hacer algo y ver que el
número no reacciona.

## 8. Permisos

El indicador solo se dibuja si la sesión puede ver el módulo de eventos
(`can(rol, "eventos", "ver")`), y el endpoint lo exige con `requirePermission`.

No es un permiso nuevo: es el que la aplicación ya tiene. Un rol sin ese permiso
no ve «Eventos» en el menú, así que enseñarle «4 alertas» sería darle un botón
que no lleva a ninguna parte y, de paso, contarle cuántas incidencias graves hay
abiertas, que es precisamente lo que su rol no debe ver.

**Anotado aparte, sin tocar en este trabajo:** `GET /api/evento` no comprueba
permiso de módulo mientras crear, editar y archivar sí. Puede ser deliberado,
pero deja el módulo incoherente y merece revisarse con calma, probando rol por
rol, porque cambiarlo puede dejar sin datos alguna pantalla que hoy funciona.

## 9. Pruebas

En `api`:

- El criterio: un evento de 6 días no cuenta, uno de 8 sí; uno resuelto no
  cuenta; uno sin `priority` no cuenta; uno archivado no cuenta.
- La gravedad de un evento es el mínimo de sus observaciones, y `null` cuando
  ninguna está clasificada.
- `sinRevisar` cuenta los que no tienen ninguna revisión, no los que tienen una
  antigua.
- `eventos` devuelve como máximo cinco, los más antiguos primero.
- La ruta responde antes que `GET /:id`, o sea que `/alertas` no se interpreta
  como identificador.
- Un rol sin `eventos.ver` recibe 403.

En `web`:

- El indicador no se dibuja con `total` 0, ni mientras carga, ni si la petición
  falla, ni sin permiso.
- El texto del panel usa `criterio.diasUmbral` de la respuesta, no un 7 escrito
  en el componente.
- El desglose ordena de más grave a menos y pone «Sin clasificar» al final.
- Al resolver un evento, la cifra se vuelve a pedir.
- `AlertBanner` pinta lo que devuelve el endpoint, sin calcular nada.

## 10. Fuera de alcance

- Los plazos por gravedad (§1). Cuando haya cifras reales de producción.
- Incluir en las alertas los eventos de criticidad 1 y 2 que nadie marcó como
  prioritarios. Es el hueco de fondo del dominio y merece su propia decisión.
- El aviso de abandono por falta de revisiones como alerta propia; aquí solo
  aparece como dato dentro del panel.
- Arreglar la contradicción de la pestaña «Obs. crítica» (§6).
- El permiso de `GET /api/evento` (§8).
- La búsqueda global del header, que se diseña aparte y no depende de esto.
