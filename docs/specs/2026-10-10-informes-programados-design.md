# Informes programados por correo — diseño

**Fecha:** 10 de octubre de 2026 · **Estado:** en construcción · **Rama:** `isaias`

Un informe guardado del generador se envía solo, por correo, cada día, cada semana o cada
mes, con el Excel o el PDF adjunto.

## 1. Decisiones de Isaias (10 de octubre de 2026)

| Pregunta | Decisión |
|---|---|
| ¿A quién se envía? | A usuarios del sistema **y también a direcciones externas** |
| ¿Cada cuánto? | Diario, semanal o mensual, con día y hora, en hora de Bolivia |
| ¿Quién puede programar? | Un permiso nuevo, `generador.programar` |
| ¿Y si sale vacío? | Se envía un aviso corto, sin adjunto |
| ¿Cuándo sale? | En el mismo corte que el resto de la rama (en contra de mi recomendación) |

## 2. Lo que ya existe y se reutiliza

- `reporte_vistas`: los informes guardados. La programación cuelga de uno.
- `buildExport()` (`src/reportBuilder/export/`): devuelve el fichero como bytes y ya
  rechaza lo que pase de 25 MB. La cola `exportSlot` deja pasar una exportación a la vez.
- La cadena de correo (`src/auth/mailRelay.ts`): relevo entre proveedores, tope diario por
  proveedor y un 25 % reservado para códigos de acceso y avisos de seguridad.
- `schedulePurge` (`src/auth/purgeJob.ts`): el modelo de trabajo en segundo plano.

Medido sobre los datos reales: el informe general pesa 96 KB en Excel, 1,8 MB con sus
1.955 fotos y 4,0 MB en PDF.

## 3. Piezas nuevas

### 3.1 Adjuntos en el correo

`CorreoAEnviar` gana un campo opcional `adjuntos` (nombre, tipo, bytes). Los dos
adaptadores, Resend y SMTP, lo envían. Tope: **10 MB por mensaje**, comprobado antes de
intentar ningún proveedor, para que quepa en el más estricto de los configurados una vez
codificado. Un mensaje que lo supera no se intenta: quien llama decide qué enviar en su
lugar.

### 3.2 Fechas relativas

Hoy un filtro de fecha solo admite días fijos, y un informe semanal enviaría siempre los
mismos datos. El valor de un filtro sobre un campo de fecha podrá ser un periodo con
nombre, que se convierte en dos fechas concretas en el momento de ejecutar, en hora de
Bolivia:

`hoy`, `ayer`, `ultimos_7_dias`, `ultimos_30_dias`, `esta_semana`, `semana_pasada`,
`este_mes`, `mes_pasado`.

Sirve también en el generador interactivo: un informe guardado con «mes pasado» se abre
siempre al día.

### 3.3 Datos

- `reporte_programaciones`: informe, dueño, frecuencia, día de la semana o del mes
  (1–28, para que exista en todos los meses), hora (0–23) y minuto (0–59), formato, con o sin fotos,
  activa, motivo de pausa, próxima ejecución.
- `reporte_programacion_destinatarios`: un usuario del sistema **o** una dirección
  externa; rechazos seguidos; baja y su token (guardado como hash).
- `reporte_ejecuciones`: una fila por envío previsto, con clave única
  `(programación, momento previsto)`. Insertarla es lo que «reclama» el envío: si el
  servidor reinicia, o un día hay dos contenedores, el segundo choca con la clave y no
  envía dos veces. Guarda resultado, filas, bytes y a cuántos se envió.

Es la migración 19. **Obliga a repetir la prueba de migración sobre la copia de
producción** antes del corte.

### 3.4 El programador

Un tic por minuto. Busca programaciones activas cuya próxima ejecución ya pasó, reclama
cada una, la ejecuta y calcula la siguiente. Reglas:

- **Hora de Bolivia** (`America/La_Paz`, UTC−4, sin cambio de hora).
- **Servidor caído a la hora prevista:** al volver se envía **una vez**, no una por
  periodo perdido, y solo si el retraso es menor de 24 horas. Más allá, se salta y se
  anota.
- **Cola de exportación ocupada:** se reintenta en el tic siguiente; no cuenta como fallo.
- **Tres fallos seguidos:** la programación se pausa sola y se avisa al dueño.

### 3.5 Con qué permisos se genera

El generador oculta los datos personales del personal según quién pregunta. Un envío
programado no tiene quién pregunte, así que la regla es:

- Un destinatario ve datos de personal solo si **él** puede verlos **y** el dueño de la
  programación también. Nadie recibe por correo más de lo que vería en pantalla, ni más
  de lo que el dueño puede ver.
- **Una dirección externa nunca recibe datos de personal.**
- En la práctica son dos variantes del fichero como mucho, no una por destinatario.

Se pausa sola, con el motivo a la vista, si el dueño pierde `generador.programar`, si su
cuenta se desactiva o si el informe se archiva.

### 3.6 Defensas por admitir direcciones externas

Enviar a fuera es una vía de salida de datos y un riesgo para la reputación del dominio,
del que también salen los códigos de acceso.

- Crear o cambiar una programación pide **confirmar identidad** (la ventana de
  reautenticación de 10 minutos) y queda en la **bitácora** con sus destinatarios.
- **Máximo 10 destinatarios** por programación.
- **Enlace de baja** en cada correo a una dirección externa: un clic, sin iniciar sesión.
  El pie dice quién programó el envío.
- **Tres rechazos seguidos** de una dirección: se deja de enviarle y se marca en pantalla.
- **Tope propio:** los informes programados no pueden gastar más de 100 correos al día,
  para no dejar sin cupo a «olvidé mi contraseña» ni a la verificación de correo. No
  tocan la reserva de los códigos de acceso.

### 3.7 Cuando algo no sale

| Caso | Qué recibe la gente |
|---|---|
| Informe sin filas | Aviso corto, sin adjunto |
| Fichero de más de 10 MB | Aviso sin adjunto: demasiado grande, ábrelo en la aplicación (o pídeselo a quien lo programó, si es externo) |
| La exportación falla | Nada a los destinatarios; aviso al dueño |
| Ningún proveedor disponible | Queda como fallido en el historial; se reintenta en el siguiente periodo |

### 3.8 API y pantalla

Bajo `/api/generator/schedules` (en inglés por la norma de nombres del API, §3.4 del
estándar: «programación» es vocabulario de la aplicación, no de la red): listar, crear,
editar, pausar, borrar, «enviar ahora» como prueba, e historial de envíos (`/:id/runs`). Más una ruta pública para la baja.

En `web`: un selector de periodo en los filtros de fecha, y en cada informe guardado un
panel «Programar envío» con su historial.

### 3.9 Historial global y a quién se envió cada vez

**El historial de todos los envíos.** La pantalla de Envíos tiene una segunda pestaña,
«Historial», con todas las ejecuciones de todos los envíos que quien mira puede ver, la más
reciente primero, paginadas y filtrables por resultado y por envío. La alimenta
`GET /api/generator/schedules/runs` (permiso `generador.ver`, como el historial de un envío
suelto). La visibilidad es la de la lista de envíos y se decide **en la consulta**, no sobre
la página ya leída: quien no modera solo ve las ejecuciones de sus envíos, y pedir un envío
ajeno devuelve una página vacía, no un 403, para que el filtro no sirva para averiguar qué
números existen. Un envío eliminado conserva sus ejecuciones (`eliminada: true`), y un informe
borrado o una cuenta archivada se nombran igualmente o salen como `null`. No hay migración
por esto: sale todo de lo que ya se guardaba.

**A quién se envió.** Cada ejecución anota, destinatario por destinatario y **a medida que
termina cada envío** (no al final: un proceso que muera a mitad deja dicho quién ya lo recibió),
una fila en `reporte_ejecucion_entregas` (migración `20261010000007`). Guarda una **copia**, no
una referencia: el tipo (`usuario` o `externo`), el nombre que tenía en pantalla en ese
momento (nombre y apellido de la cuenta, o la dirección si es externo), la dirección solo si es
externa, y el resultado. Así la fila se sigue leyendo aunque la cuenta cambie de nombre o se
elimine (`id_usuario` pasa a `NULL`; por eso el CHECK distingue cuenta de externo por `tipo` y
no por qué columna está vacía). Los resultados son cuatro:

- `entregado`: la cadena de correo lo aceptó.
- `rechazado`: se rechazó la propia dirección (cuenta contra esa dirección, como antes).
- `no_enviado`: cualquier otro fallo del envío; no dice nada de la dirección.
- `sin_cupo`: no se intentó, porque se alcanzó el tope diario de correos de informes.

Solo se anota a quien la ejecución escribe: quien se dio de baja o ya rebotó demasiadas veces
no tiene fila. **Escribir esta fila nunca estropea una ejecución**: si falla, se registra un
aviso y el bucle sigue; un informe sin enviar vale más que una fila de historial. Una ejecución
devuelta porque el exportador estaba ocupado se borra y arrastra sus filas (`ON DELETE
CASCADE`), pero para entonces no se había enviado a nadie.

**Solo existe para las ejecuciones posteriores a la migración.** Las anteriores no tienen
filas; no se inventa nada hacia atrás. Cada fila del historial trae `con_destinatarios` para
distinguir unas de otras sin una petición por fila. La pantalla escribe «No se registró a quién»
solo bajo una ejecución sin registro que sí llegó a intentar el envío a alguien (entregados más no
entregados mayor que cero) y que ya no está en curso; una ejecución que no intentó a nadie (falló
antes de enviar) o que aún está construyendo sus ficheros muestra únicamente la cifra, y una
omitida, un guion. Si una ejecución se interrumpe a mitad, al cerrarla se cuentan sus filas:
entregados los `entregado`, no entregados los otros tres resultados.

**Quién puede ver a quién.** `GET /api/generator/schedules/runs/:id/recipients` (también
`generador.ver`) sigue la regla del historial de un envío: lo lee el dueño del envío o
administración; a cualquier otro se le niega (403) y se deja el rastro `READ_PROGRAMACION_DENIED`,
y una ejecución que no existe es un 404. **La dirección de una cuenta no se sirve nunca**: ni
se guarda en la fila, ni sale en la respuesta; la dirección solo aparece para un destinatario
externo, porque es lo único que ese destinatario es.

## 4. Orden de construcción

1. Adjuntos en la cadena de correo.
2. Fechas relativas en el motor.
3. Migración, modelos y permiso `generador.programar`.
4. Cálculo de la próxima ejecución, programador y ejecución.
5. Rutas, con sus guardas y la bitácora.
6. Baja con un clic.
7. Pantalla en `web` — **al final**: otra sesión está trabajando en ese árbol.
8. Repetir la prueba de migración sobre la copia de producción y actualizar el plan de
   despliegue.

## 5. Decisiones mías, a confirmar

Tomadas para poder avanzar; cualquiera se cambia con poco coste antes de construir su pieza.

- Tope de adjunto: 10 MB.
- Día del mes limitado a 1–28.
- ~~Hora con precisión de una hora, no de minutos.~~ Cambiado por Isaias el 2026-10-10 al
  ver el formulario: la hora lleva minutos (columna `minuto`, migración `20261010000004`).
  Las horas en punto quedan como atajos en el campo.
- Retraso máximo recuperable: 24 horas.
- 10 destinatarios por programación y 100 correos de informes al día.
- Crear o editar una programación entra en la ventana de reautenticación.
- El historial de envíos vive en su propia tabla; la bitácora solo registra los cambios en
  la programación, no cada envío.
