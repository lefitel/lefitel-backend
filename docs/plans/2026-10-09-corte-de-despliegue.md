# Corte de despliegue: de `master` a la rama `isaias`

Escrito el 9 de octubre de 2026, tras la auditoría de todo lo que la rama `isaias` lleva
por delante de `master` (192 commits en `api`, 117 en `web`, más el trabajo sin commitear).

Este documento es la lista para el día del corte. Lo que hace falta saber antes de empezar:

- **`api` y `web` salen juntas.** Ninguna mitad vieja funciona con la otra mitad nueva.
  Mientras solo una esté desplegada, nadie puede iniciar sesión.
- **Todos los usuarios vuelven a iniciar sesión**, una vez. La credencial pasa de un token
  guardado en el navegador a una cookie.
- **No hay vuelta atrás redesplegando `master`.** Una vez migrada la base, la imagen de
  `master` no arranca. La marcha atrás es restaurar la copia de la base (paso 2).
- **La imagen nueva migra sola al arrancar.** No hay que configurar ningún comando de
  migración en Coolify, y si había uno de pre-despliegue hay que quitarlo.
- **La imagen anterior se para ANTES de que arranque la nueva.** La migración del tramo
  (`20261010000005`) elimina de `postes` las columnas `id_ciudadA` e `id_ciudadB`, y la imagen
  anterior las consulta en toda lectura de postes, incidencias y reportes: si sigue
  atendiendo mientras la nueva migra, todo eso falla. Es lo contrario de lo que cuenta el
  paso 4 (cambio en caliente, con la vieja atendiendo hasta que la nueva esté sana): **para
  este corte se renuncia a esa red**, y se asume que el servicio está caído desde que se
  para la vieja hasta que la nueva queda sana. Como *Auto Deploy* arranca el despliegue con
  el push a `master`, la vieja se para **antes** del push. Cómo se para en el panel de
  Coolify no está comprobado desde aquí: verlo antes del día del corte.

Cada paso dice qué está comprobado y qué no. Lo no comprobado es lo que no se puede ver
desde el código: la base de producción y el panel de Coolify.

---

## 0. Antes de nada: commitear

Los arreglos de la auditoría están en el árbol **sin commitear**, mezclados con el arco de
la ventana de reautenticación. Tres ficheros nuevos no pueden quedarse fuera del commit:

| Fichero | Si falta |
|---|---|
| `api/src/controllers/usuarioRol.controller.ts` | `api` no compila |
| `web/src/components/dialogs/useStepUpCeremony.ts` | `web` no compila |
| `api/src/migrations/20260908000001-add-password-confirmed-at.ts` | compila, pero toda consulta de sesión falla en producción |

Comprobación: `git status --short` en los dos repos no debe mostrar ninguna línea `??`
bajo `src/`.

## 1. Consultas a la base de producción

Solo lectura. Cada una decide si el corte puede seguir.

**1.1 Registro de migraciones.** Debe devolver una fila con la migración de mayo
(`20260503000001-add-missing-fields`, con o sin extensión).

```sql
SELECT name FROM "SequelizeMeta";
```

Si la tabla no existe o está vacía: **parar**. La primera migración intentaría añadir una
columna que ya existe, fallaría, y no correría ninguna de las demás.

**1.2 Nombres de usuario duplicados.** Debe devolver cero filas.

```sql
SELECT lower("user"), count(*)
FROM usuarios
WHERE "deletedAt" IS NULL
GROUP BY 1
HAVING count(*) > 1;
```

Una migración crea un índice único sobre el nombre sin distinguir mayúsculas, y `master`
no impedía duplicados al crear usuarios. Si hay filas: renombrar o archivar una de cada
par antes de seguir. Si no se hace, esa migración falla y bloquea las siguientes (revierte
limpio, no deja nada a medias).

**1.3 Nombres de usuario con espacios.** Debe devolver cero filas.

```sql
SELECT id, '[' || "user" || ']' FROM usuarios WHERE "user" <> btrim("user");
```

El login nuevo recorta los espacios de lo que se escribe; una cuenta guardada con espacios
al principio o al final dejaría de poder entrar. Si hay filas: corregir el nombre.

> **Resultado de estas consultas sobre la copia del 9 de octubre de 2026:** el registro
> tiene la fila de mayo; no hay usuarios duplicados ni con espacios; solo existen los roles
> 1, 2 y 3; y hay 3 postes con fotos de nombre con dos puntos seguidos. Repetirlas el día
> del corte: lo que cuenta es cómo esté la base ese día.

**1.4 Fotos con dos puntos seguidos en el nombre.** Informativa.

```sql
SELECT 'postes' AS tabla, id, image FROM postes WHERE image LIKE '%..%'
UNION ALL SELECT 'eventos', id, image FROM eventos WHERE image LIKE '%..%'
UNION ALL SELECT 'ciudads', id, image FROM ciudads WHERE image LIKE '%..%'
UNION ALL SELECT 'usuarios', id, image FROM usuarios WHERE image LIKE '%..%'
UNION ALL SELECT 'solucions', id, image FROM solucions WHERE image LIKE '%..%';
```

La pantalla Archivos las tomaba por huérfanas y las habría borrado. **Está arreglado en el
código**; esta consulta solo sirve para saber si el caso existía de verdad.

**1.5 Roles fuera de los tres de siempre.** Informativa.

```sql
SELECT id, name FROM rols WHERE id NOT IN (1, 2, 3);
```

Los roles 1, 2 y 3 conservan exactamente los permisos que tenían. Cualquier otro arranca
**sin ningún permiso** y hay que dárselos a mano en la pantalla de Seguridad.

## 2. Copia de la base

```bash
pg_dump --format=custom --file=osefi-antes-del-corte.dump "$DATABASE_URL"
```

Es la única marcha atrás. Guardarla fuera del servidor.

## 3. Variables de entorno de `api` en Coolify

El servidor **se niega a arrancar** si falta cualquiera de las obligatorias. La referencia
con la explicación de cada una es `api/.env.example`.

**Estado del panel el 10 de octubre de 2026:** había seis variables — `NODE_ENV`, `PORT`,
`IMAGES_DIR`, `JWT_SECRET`, `CORS_ORIGIN` y `DATABASE_URL` — y ese mismo día se crearon las
diez nuevas, todas sin «Available at Buildtime»: `COOKIE_NAME`, `COOKIE_SECURE`,
`MFA_ENCRYPTION_KEY_ACTIVE`, `MFA_ENCRYPTION_KEY_1`, `WEBAUTHN_RP_ID`, `WEBAUTHN_ORIGIN`,
`MAIL_PROVIDERS`, `MAIL_FROM`, `RESEND_API_KEY` y `MAIL_RESEND_DAILY`. El dominio
`osefi.net` ya estaba verificado en Resend, y la clave de producción es propia, con permiso
solo de envío.

**Correo: tres proveedores, decidido ese día.** `MAIL_PROVIDERS=resend,mailjet,smtp2go`, con
las tres variables `MAIL_SMTP_<NOMBRE>_USER` / `_PASS` / `_DAILY` de Mailjet (180) y de
SMTP2GO (30). Las de SMTP2GO se vieron en el panel; las de Mailjet y el valor de
`MAIL_PROVIDERS` **faltan por ver en captura**. Dominio verificado en los tres (SMTP2GO con
tres CNAME: `em1052260`, `s1052260._domainkey`, `link`), rastreo apagado. Mailtrap y Elastic
quedan aplazados; no bloquean el corte. Las cuentas técnicas cuelgan del alias
`dev@osefi.net`, un reenvío de Namecheap: quitarlo deja esas cuentas sin recuperación.

Probado con envíos reales desde local: un correo por cada proveedor y el salto por tope
(`resend → mailjet → smtp2go`); los seis llegaron. Queda sin probar con las credenciales de
Coolify y con el remitente `no-reply@osefi.net` (el `.env` local envía desde otra
dirección): se confirma con el primer correo real tras el corte.

Comprobado desde fuera ese día: `https://osefi.net` redirige a `https://www.osefi.net`, que
es el único origen donde vive la aplicación, y `CORS_ORIGIN` ya vale exactamente eso.

Si se despliega faltando alguna, no se rompe nada: la imagen comprueba la configuración
**antes** de migrar, sale sin tocar la base, y Coolify se queda con la versión anterior. En
el log del despliegue aparece una línea por cada cosa que falta.

**Obligatorias y nuevas**

| Variable | Qué poner |
|---|---|
| `COOKIE_NAME` | Tiene que empezar por `__Host-` |
| `COOKIE_SECURE` | `true` |
| `MAIL_FROM` | Remitente de los correos |
| `MAIL_PROVIDERS` | Lista de proveedores, por orden de preferencia |
| Credenciales de al menos un proveedor de la lista | `RESEND_API_KEY` + `MAIL_RESEND_DAILY`, o las `MAIL_SMTP_<NOMBRE>_USER` / `_PASS` / `_DAILY` |
| `MFA_ENCRYPTION_KEY_ACTIVE` | El número de la clave activa (`1`) |
| `MFA_ENCRYPTION_KEY_1` | 64 caracteres hexadecimales. **Guardarla aparte**: si se pierde, los códigos de app autenticadora ya registrados quedan ilegibles |
| `WEBAUTHN_RP_ID` | `www.osefi.net`. **No se puede corregir después**: cambiarla invalida todas las passkeys registradas |
| `WEBAUTHN_ORIGIN` | `https://www.osefi.net` |

**Pasa de opcional a obligatoria**

| Variable | Qué poner |
|---|---|
| `CORS_ORIGIN` | El origen exacto de la web, `https://www.osefi.net`. También es el dominio de los enlaces que van en los correos |

**Opcionales**

| Variable | Sin ella |
|---|---|
| `MFA_OBLIGATORIO` | El segundo factor es opcional, que es lo decidido. Solo con el valor exacto `true` pasa a ser obligatorio para todos, con 14 días de gracia |
| `ORS_API_KEY` | Los mapas dibujan los tramos en línea recta, sin avisar. Es la clave que antes estaba en la web como `VITE_ORS_API_KEY` |
| `MAIL_SECURITY_TO` | No se envían los avisos de seguridad |
| `LOG_LEVEL` | `info` |

**Ya no se lee: `JWT_SECRET`.** Se puede dejar puesta; no hace falta para nada.

**Comprobar además**

- Que no convivan `PG_DATABASE` + `PG_USER` con `DATABASE_URL`. Antes mandaba siempre
  `DATABASE_URL` en producción; ahora **ganan las `PG_*`** si están completas. Con las dos
  puestas, el servidor podría conectarse a otra base. La primera línea del log dice a cuál
  se conectó.
- Las seis variables actuales tienen marcado «Available at Buildtime», `NODE_ENV=production`
  incluida, y eso hacía fallar la build (`eslint: not found`). **Ya no importa:** el
  `Dockerfile` instala las herramientas y fija su propio entorno para los tests pase lo que
  pase. Comprobado construyendo la imagen con esas variables inyectadas como lo hace
  Coolify. Las variables nuevas conviene crearlas **sin** «Available at Buildtime»: son
  secretos que la build no necesita.
- No hay variables `PG_*`: la base sale solo de `DATABASE_URL`. Bien.

## 4. Ajustes de la aplicación `api` en Coolify

La imagen migra al arrancar y declara su propia comprobación de salud. Para que una
migración fallida **no** deje el servicio caído, Coolify tiene que hacer el cambio en
caliente: arrancar el contenedor nuevo al lado del viejo y cambiar solo cuando el nuevo
esté sano. Eso exige:

- [x] **Comprobación de salud del panel DESACTIVADA**, como está. Al revés de lo que parece:
      con la del panel apagada, Coolify lee la que declara el `Dockerfile` y usa esa. Si se
      pulsa «Enable Healthcheck», la del panel la sustituye, y sus valores por defecto
      (`GET /` en el puerto 80 esperando un 200) no los cumple este servidor: **todos los
      despliegues se darían por fallidos y se revertirían.**
- [x] **Ningún puerto mapeado al host.** «Port Mappings» está vacío.
- [x] **Sin nombre de contenedor fijo.** «Consistent Container Names» está desmarcado.
- [x] **Sin comando de pre-despliegue ni de post-despliegue.** Los dos campos están vacíos.

Las cuatro se miraron en el panel el 9 de octubre de 2026 y están como hace falta. Volver a
mirarlas el día del corte.

- **«Auto Deploy» está activado.** Un push a `master` despliega `api` solo, sin pulsar nada.
  El corte empieza en el momento del push, no cuando alguien entra al panel.
- [ ] **Almacenamiento persistente montado** en la ruta de `IMAGES_DIR` (por defecto
      `/images`). Sin él, cada despliegue pierde las fotos subidas.

Si hubiera un puerto mapeado o un nombre fijo, Coolify pararía el contenedor viejo antes de
arrancar el nuevo, y una migración fallida sería una caída hasta el siguiente despliegue.

Con la configuración actual, cada despliegue espera 30 segundos y luego mira hasta seis
veces, cada 10 segundos, si el contenedor nuevo está sano. Si no lo está pasado ese minuto
y medio, se queda con el anterior.

Comprobado: el comportamiento está leído en el código fuente de Coolify («New container is
not healthy, rolling back to the old container»), y la imagen se construyó y se arrancó en
local contra una base que no respondía — la migración falló, el contenedor salió con error
y el servidor no llegó a arrancar.

**Comprobado también, el 9 de octubre, sobre una copia real de producción** (PostgreSQL 17,
restaurada en un contenedor desechable): las 18 migraciones aplican limpias, el contenedor
queda sano en unos 12 segundos, los recuentos de todas las tablas quedan intactos, y una
cuenta de cada rol inicia sesión con un hash de contraseña del tipo antiguo, ve lo que su
rol veía y cierra sesión. La imagen de `master` arrancada después sobre esa base falla
como describe el paso 8.

**Repetido el 10 de octubre de 2026 con la rama tal como está ese día**, sobre la misma
copia, porque desde la primera prueba entraron tres migraciones más (las dos de los
informes programados y una que hace único el nombre de un rol):

- **21 migraciones aplican limpias** (son 22 ficheros; la de mayo ya estaba aplicada).
- **Después de esta prueba entró una migración más** (`20261010000004`, que añade el
  minuto a la hora de un envío programado: una columna con valor 0 sobre una tabla que en
  producción nace vacía). **No se ha pasado sobre la copia de producción**; sí sobre un
  PostgreSQL 17 desechable, junto con las otras de los informes programados. El día del
  corte serán **22 aplicadas**, no 21.
- El contenedor queda **sano en unos 10 segundos**.
- **Los recuentos de las 15 tablas son idénticos antes y después**: 1.900 eventos, 2.073
  postes, 11.853 revisiones, 10.208 líneas de bitácora, 13 usuarios.
- Las tablas pasan de 16 a 29. Las tres de los informes programados existen con sus diez
  restricciones.
- El permiso nuevo `generador.programar` queda **abierto para el rol 1 y cerrado para el 2
  y el 3**.
- El log no tiene ninguna línea de aviso ni de error tras dos pasadas del programador.
- El programador, ejecutado sobre esos datos con el exportador real y sin enviar correo,
  generó tres informes en 3,8 segundos: 1.750 eventos en Excel (65 KB) y en PDF (1,9 MB),
  y «últimos 30 días» con las mismas 49 filas que una consulta hecha a mano.

Esta vez **no** se repitió el inicio de sesión de una cuenta por rol: nada de lo añadido
toca la autenticación.

**Pendiente, desde el 10 de octubre: dos migraciones más** — `20261010000005` (el tramo pasa
a ser una tabla propia, se fusionan cinco ciudades duplicadas y `postes` pierde las columnas
`id_ciudadA` e `id_ciudadB`) y `20261010000006` (los permisos del módulo `tramos`). Con ellas,
y con la `…07` que se describe más abajo, son **26 ficheros y 25 aplicadas** el día del corte, no 23
y 22. **La prueba sobre la copia de producción se repite entera**, con las 25, y esta vez trae por delante cuatro
comprobaciones previas que la `…05` hace antes de tocar nada:

1. Las diez ciudades de la fusión existen y se llaman como se espera, y las cinco que ganan
   están activas.
2. Ningún poste apunta a una ciudad inexistente.
3. Ningún poste acaba con la misma ciudad en los dos extremos una vez aplicada la fusión.
4. Ningún informe guardado, archivado o no, usa «Ciudad A/B» ni filtra por el texto del tramo.

Si una se dispara, la `…05` se detiene **sin haber cambiado nada** y el mensaje nombra las
filas (postes, ciudades o informes). Para la `…05` sola, corregir el dato y volver a
ejecutar basta; no hace falta restaurar nada. **El día del corte no es así.** Cuando la `…05`
se detiene, las 22 migraciones anteriores ya están confirmadas en la base; la imagen nueva
sale al arrancar porque queda una pendiente, y la imagen anterior no puede arrancar sobre
ese esquema. «Corregir el dato» sería entonces SQL escrito a mano sobre producción, con el
servicio parado, o restaurar la copia del paso 2. Por eso la prueba sobre la copia de
producción **es una puerta y no un trámite**: esas comprobaciones deben saltar en la
repetición, con tiempo, y no el día del corte. Dirán si producción tiene algo que la base
local no tenía.

**Una migración más, aditiva: `20261010000007`** (`reporte_ejecucion_entregas`, a quién se
envió cada ejecución de un informe programado). Crea una tabla nueva, con su índice y tres
restricciones, y no toca ninguna existente; su `down` solo la borra. Con ella son **26
ficheros y 25 aplicadas** el día del corte. No depende de los datos de producción: la tabla
nace vacía y solo se llena con las ejecuciones posteriores.

**Cómo se ensaya la `…05`.** Un volcado de producción sin tocar trae aplicada solo la
migración más antigua; las tablas que leen las comprobaciones (por ejemplo `reporte_vistas`)
no existen hasta que corren las anteriores. Por eso hay un tope, `MIGRAR_HASTA`:

1. Restaurar el volcado de producción en una base que se llame exactamente `probe_tramos`
   (un PostgreSQL desechable, nunca el de siempre).
2. Migrar hasta la `…04`, con las variables de esa base:
   `MIGRAR_HASTA=20261010000004-add-minuto-to-reporte-programaciones npm run migrate`.
   El nombre va sin extensión; uno que no exista falla con un mensaje claro.
3. Ejecutar `npx vitest run src/tramos/tramos.db.test.ts` con las mismas variables y exigir
   ver **`11 passed`**, no solo que el código de salida sea 0. Esa suite es la única
   comprobación poste por poste de la `…05`: cada poste conserva el tramo de las dos
   ciudades que tenía. Con `PG_DATABASE=probe_tramos` se niega a salir en verde sobre una
   base vacía o ya migrada (falla con una frase que lo dice), pero «skipped» no es
   «passed»: si el recuento no dice 11 pasadas, la migración no se ha comprobado.
4. Volver a restaurar el volcado: el paso 3 deja la base migrada por la `…05`.
5. Entonces sí, el ensayo entero en el contenedor, con las 25 migraciones.

**Hecho el 13 de octubre de 2026, los cinco pasos**, sobre un volcado de producción sacado
de Coolify esa misma noche y con **el árbol tal como estaba ese día, sin commitear** (las
migraciones `…05`, `…06` y `…07` aún no estaban en git). Si alguna migración cambia antes
del commit que se despliega, se repite.

- Las consultas del paso 1 sobre ese volcado: el registro tiene la fila de mayo, cero
  usuarios duplicados o con espacios, solo los roles 1, 2 y 3, y los mismos 3 postes con
  fotos de dos puntos seguidos.
- Paso 2: 22 migraciones limpias hasta la `…04`. Paso 3: **`11 passed`**. Ninguna de las
  cuatro comprobaciones previas de la `…05` se disparó.
- Ensayo entero con la imagen construida del árbol (lint y 3.436 tests pasan en la puerta):
  **25 migraciones aplicadas, contenedor sano a los 17 segundos, ninguna línea de aviso ni
  de error en el log.**
- **Los recuentos de las 16 tablas que trae producción son idénticos antes y después**:
  1.917 eventos, 2.090 postes, 11.956 revisiones, 10.390 líneas de bitácora, 13 usuarios,
  110 ciudades. Las tablas pasan de 16 a 32.
- La `…05` sobre producción: **101 tramos** (134 pares con sentido, 109 sin él, y 8 que se
  juntan por la fusión), ningún poste sin tramo, ningún tramo sin postes, y **los 101 sin
  departamento**: hay que asignarlos a mano después del corte. De las cinco ciudades que
  pierden en la fusión, «El Morro» (76) ya estaba archivada en producción; las otras
  cuatro quedan archivadas.
- Permisos sembrados: `generador.programar` 1=sí 2=no 3=no; `tramos.ver` para los tres,
  `tramos.crear` y `tramos.editar` para 1 y 2, `tramos.archivar` solo para 1.
- Inicio de sesión de una cuenta por rol contra la API migrada, y lectura de sesión,
  postes, tramos, eventos, ciudades, dashboard y envíos programados: todo 200 en los tres.
  La contraseña de esas tres cuentas se reescribió en la copia con un hash nuevo: **no**
  prueba los hashes antiguos, que es lo que ya probó el ensayo del 9 de octubre.

**Visto de paso, y cuenta el día del corte:** `MFA_ENCRYPTION_KEY_1` son exactamente 64
caracteres hexadecimales. Con una clave mal formada el contenedor queda **sano** igual (es
deliberado: solo se apaga el TOTP), así que Coolify dará el despliegue por bueno. Tras el
corte, buscar en el log la línea `fatal` «la clave de cifrado del segundo factor no es
válida»; si no está, la clave sirve.

**Una migración más tras ese ensayo: `20261013000001`**, el departamento de cada tramo según
la lista que mandó el cliente el 13 de octubre. Solo datos: escribe donde el departamento
está vacío, busca cada tramo por su par de ciudades y comprueba los dos nombres, y una fila
que no cuadra se salta sin parar el arranque. Con ella son **27 ficheros y 26 aplicadas** el
día del corte. Probada esa misma noche sobre una restauración nueva del mismo volcado, con las
26: **65 tramos con departamento y 36 vacíos**, exactamente los esperados, y los 65 coinciden
con un emparejamiento hecho a ciegas desde cero. Quedan vacíos: 20 que la lista no menciona,
8 que solo casan con un nombre dudoso, 3 a los que da dos departamentos y 5 donde la lista
contradice el mapa (cuatro de la zona Guarayos, en Santa Cruz y listados como Beni, y
Villamontes–Hito Paraguay, en Tarija y listado como Santa Cruz). Su `down` los deja vacíos,
repetirla no cambia nada y respeta un departamento puesto a mano. No se repitió el ensayo con
la imagen Docker: la migración no toca el esquema.
**Tras el corte quedan 36 tramos por asignar a mano** en la pantalla de tramos. Ocho esperan
al cliente: los tres con dos departamentos (Independencia–Inquisivi, Caracollo–Ayo Ayo,
Villamontes–Boyuibe) y los cinco del mapa, que dependen de si su columna es el departamento
o su zona.

**No comprobado:** un despliegue real en Coolify.

## 5. Variables de `web` en Vercel

- `VITE_PROD_API_URL`: sigue igual. Tiene que apuntar a `https://api.osefi.net/` — el
  mismo dominio que la web. La cookie de sesión y las fotos **no funcionan** si la web se
  sirve desde otro dominio (por ejemplo una dirección `*.vercel.app`).
- `VITE_ORS_API_KEY`: borrarla. Ya no se usa, y todo lo que empieza por `VITE_` acaba
  publicado en el código de la web.
- Versión de Node del proyecto: **22.x o 24.x**. 🔴 Visto en el panel el 10 de octubre de
  2026: estaba en 20.x, que Vercel retiró el 30 de septiembre — con ella **no se crean
  builds nuevos**, así que el push del corte no publicaría la web. Vite 8 pide
  `^20.19.0 || >=22.12.0`; la API ya corre en 24. **Cambiada a 24.x ese mismo día**; se
  aplica en el siguiente build, que es el del corte.

Visto ese mismo día: la rama de producción es `master` y **un push a `master` publica la
web solo**, igual que Coolify con la API. `VITE_PROD_API_URL` vale `https://api.osefi.net/`,
con la barra final, que hace falta (`src/api/url.ts` le concatena `api/` sin separador).
`VITE_ORS_API_KEY` sigue ahí: la versión nueva no la lee, así que no vuelve a publicarse,
pero la que está en producción la lleva escrita en su JavaScript — borrarla tras el corte y
rotar esa clave en OpenRouteService.

## 6. El corte

Elegir una ventana tranquila y avisar: durante unos minutos nadie podrá entrar.

1. Fusionar `isaias` en `master` en los dos repos y hacer push. **El push a `master`
   despliega `api` automáticamente**: no hay un segundo paso de «desplegar» que esperar.
2. Seguir el despliegue de `api` en Coolify (pestaña Deployments). Mirar el log del
   contenedor nuevo, en este orden:
   - la línea que dice a qué base se conecta;
   - `22 migración(es) aplicada(s)` con la lista — son 23 en total, y la de mayo ya está
     aplicada en producción. **El número es el del 10 de octubre**: si entra otra
     migración antes del corte, será uno más;
   - que el servidor queda escuchando y Coolify lo marca sano.
3. Desplegar `web` en cuanto `api` esté sana.
4. Recargar la web en el navegador (sin caché) e iniciar sesión.

**Si `api` no queda sana:** Coolify debería quedarse con la versión anterior, pero la base
puede haber quedado migrada a medias o entera. No reintentar a ciegas: leer el log, y ver
el paso 8.

## 7. Comprobación después del corte

- [ ] Iniciar sesión con un usuario de cada rol (1, 2 y 3) con su contraseña de siempre.
- [ ] Abrir una ficha de poste y una de incidencia: **el mapa se dibuja**. Los mapas estaban
      rotos en la build de producción y están arreglados, pero solo se probó que cargan su
      motor, no la pantalla entera en un navegador.
- [ ] Ver una foto antigua y subir una nueva.
- [ ] Crear y editar un poste y una incidencia.
- [ ] Sacar un informe general y uno de recorrido; comprobar que el recorrido sigue la
      carretera (si no, falta `ORS_API_KEY`).
- [ ] Generador: generar un informe y exportarlo a Excel.
- [ ] En un filtro de fecha del Generador, elegir «está en el periodo» y «La semana pasada».
- [ ] Menú → **Envíos programados** (solo lo ve el Administrador): crear un envío a tu
      propia cuenta, pulsar «Enviar ahora» y comprobar que llega el correo con el adjunto.
      Añadir después una dirección externa tuya, enviar otra vez, y comprobar que ese correo
      trae el enlace «dejar de recibirlo» y que la página de baja funciona.
- [ ] Roles y permisos: en la fila del Generador aparece una casilla nueva, «Programar
      envíos», marcada solo para el Administrador.
- [ ] Pedir un correo de verificación desde el perfil y comprobar que llega.
- [ ] Cambiar la contraseña equivocándose a propósito en la actual: debe decir
      «contraseña incorrecta» y **no** cerrar la sesión.

## 8. Marcha atrás

Redesplegar `master` **no funciona** después de migrar: el ejecutor nuevo renombra una
fila del registro de migraciones, la imagen de `master` la ve como pendiente, intenta
repetirla, falla, y no arranca.

La marcha atrás es, en este orden:

1. Parar `api`.
2. Restaurar la copia del paso 2:
   `pg_restore --clean --if-exists --dbname="$DATABASE_URL" osefi-antes-del-corte.dump`
3. Redesplegar `master` en `api` y en `web`.

Se pierde todo lo escrito en la base entre el corte y la restauración.

**Desde la migración del tramo (`…05`) esta restauración es la única vuelta exacta.** Su
`down` reconstruye las dos columnas de ciudad desde el tramo, pero no devuelve a cada poste
el sentido que tenía, ni deshace la fusión de las cinco ciudades, ni los espacios de los
nombres. Y no se puede volver a la imagen anterior dejando el esquema nuevo: no encuentra
las columnas.

## 9. Lo que cambia para los usuarios

Para avisar antes, no después:

- **Todos vuelven a iniciar sesión** el día del corte.
- **El segundo factor es opcional.** Quien quiera lo configura desde su perfil (passkey,
  app autenticadora o verificar su correo) y a partir de ahí se le pide en cada entrada,
  salvo en los equipos que marque como recordados (30 días). Quien no configure ninguno
  sigue entrando solo con su contraseña. Se puede hacer obligatorio más adelante con
  `MFA_OBLIGATORIO=true`, sin tocar código.
- **Recuperar contraseña por correo** solo sirve a quien haya verificado su correo. El
  primer día nadie lo tiene verificado.
- **Acciones delicadas piden la contraseña otra vez** (crear usuarios, cambiar roles,
  cambiar la propia contraseña).
- **Cinco contraseñas equivocadas bloquean la cuenta** entre 1 y 15 minutos. Mientras está
  bloqueada responde «usuario o contraseña incorrectos» también a la correcta. Un
  administrador puede desbloquearla desde la ficha del usuario.
- **El informe «Tiempos» da otros números** que antes para las mismas fechas: ahora mide
  desde la fecha de la incidencia hasta la fecha de la solución.
- **Editor y Visor ya no ven la pestaña «Bitácora»** en las fichas de poste, incidencia y
  ciudad.
- **Los mapas necesitan aceleración gráfica (WebGL).** Un equipo sin ella no verá mapa; los
  campos de latitud y longitud siguen funcionando.

## 10. Si alguien se queda fuera

Desde dentro del contenedor de `api`:

```bash
npm run auth:rescue:deploy -- --user <usuario> --unlock            # quita el bloqueo
npm run auth:rescue:deploy -- --user <usuario> --reset-mfa         # borra su segundo factor
npm run auth:rescue:deploy -- --user <usuario> --revoke-sessions   # cierra todas sus sesiones
npm run auth:rescue:deploy -- --user <usuario> --set-email <dirección>
npm run auth:rescue:deploy -- --user <usuario> --unarchive
```

Es el script de rescate: actúa sobre una cuenta sin pasar por la web. Una sola operación
por llamada. Funciona aunque la clave de cifrado del segundo factor esté mal.
