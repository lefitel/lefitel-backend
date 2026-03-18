# Backend — Arquitectura y Optimizaciones

## Stack
- Node.js + Express + TypeScript
- Sequelize ORM + PostgreSQL
- Desplegado en Render

---

## Endpoints principales

| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/api/dashboard` | Datos ligeros para la página de inicio |
| GET | `/api/postes` | Lista paginada de postes |
| GET | `/api/postes?export=true` | Todos los postes sin paginación (para exports) |
| GET | `/api/eventos` | Lista paginada de eventos |
| GET | `/api/eventos?export=true` | Todos los eventos sin paginación (para exports) |

---

## Paginación server-side

`/api/postes` y `/api/eventos` aceptan:

| Param | Default | Descripción |
|-------|---------|-------------|
| `page` | 1 | Número de página |
| `limit` | 50 (mín 10, máx 100) | Registros por página |
| `filterColumn` | — | Columna a filtrar |
| `filterValue` | — | Valor del filtro (ILIKE) |
| `archived` | false | Registros archivados (paranoid) |
| `export` | false | Devuelve todos sin paginación |

Respuesta paginada:
```json
{
  "data": [...],
  "total": 1470,
  "page": 1,
  "totalPages": 147,
  "limit": 10
}
```

---

## Optimizaciones de queries

### `separate: true` en hasMany (getEvento)
`RevicionModel` y `EventoObsModel` usan `separate: true`. Sin esto, Sequelize genera un JOIN que produce un producto cartesiano (evento × revisiones × observaciones). Con `separate: true` ejecuta queries separadas `WHERE id_evento IN (...)`.

```typescript
{ model: RevicionModel, separate: true, attributes: ["id", "date", "id_evento"] }
{ model: EventoObsModel, separate: true, attributes: ["id", "id_obs", "id_evento"] }
```

### Subquery `pendingEvents` en getPoste
Cuenta eventos pendientes por poste directamente en SQL, evitando cargar todos los eventos en el frontend.

```sql
(SELECT COUNT(*) FROM "eventos"
 WHERE "eventos"."id_poste" = "poste"."id"
 AND "eventos"."state" = false
 AND "eventos"."deletedAt" IS NULL)
```

### Atributos limitados en includes
Todos los includes especifican solo las columnas necesarias (`attributes: ["id", "name"]`) para reducir la transferencia de datos.

### Endpoint `/api/dashboard` separado
La página de inicio usa un endpoint dedicado con campos mínimos, evitando los JOINs pesados de los endpoints completos.

---

## Base de datos — Índices

Creados manualmente (Sequelize no los genera automáticamente en FKs).

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
CREATE INDEX idx_reviciones_id_evento ON public.revicions (id_evento);

-- eventoObs: idem (nombre de tabla con comillas por camelCase)
CREATE INDEX idx_evento_obs_id_evento ON public."eventoObs" (id_evento);

-- bitacoras: filtros por rango de fecha
CREATE INDEX idx_bitacora_created ON public.bitacoras ("createdAt");
```

Verificar índices existentes:
```sql
SELECT tablename, indexname
FROM pg_indexes
WHERE tablename IN ('eventos', 'postes', 'revicions', 'evento_obs', 'bitacoras')
ORDER BY tablename, indexname;
```

Eliminar un índice (reversible, no modifica datos):
```sql
DROP INDEX nombre_del_indice;
```

---

## Docker local (simulación de servidor)

```bash
docker build -t lefitel-backend .
docker run -d \
  --name lefitel-sim \
  --env-file .env.docker \
  --memory="192m" \
  --cpus="0.5" \
  -p 3001:3000 \
  lefitel-backend
```

`.env.docker` usa `PG_IP=host.docker.internal` para conectarse a la base de datos local del host.
