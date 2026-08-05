# LicitaTech AI — Sync de licitaciones (100% gratis, sin IA)

Sincroniza automáticamente el feed oficial ATOM/CODICE de la PLACSP
(licitaciones en perfiles del contratante) con una base de datos Supabase,
aplicando un filtro previo y un scoring por reglas (CPV + importe + keywords).
No usa ninguna API de IA — coste 0€.

## Cómo desplegarlo

### 1. Crear proyecto en Supabase (gratis)
1. Crea un proyecto en https://supabase.com (plan Free)
2. Ve a **SQL Editor** y ejecuta el contenido de `sql/schema.sql`
3. Copia tu `Project URL` y tu `service_role key` (Settings → API)

### 2. Subir este código a un repositorio de GitHub
- Recomendado: repositorio **público** → GitHub Actions minutos ilimitados
- Si prefieres privado, tienes 2000 min/mes gratis (de sobra para este cron)

### 3. Configurar los Secrets del repositorio
En GitHub: Settings → Secrets and variables → Actions → New repository secret
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

### 4. Activar el workflow
El archivo `.github/workflows/sync-licitaciones.yml` ya está configurado para
ejecutarse cada 12h (06:00 y 18:00 UTC). También puedes lanzarlo a mano desde
la pestaña **Actions** del repo (botón "Run workflow").

## Probar en local

```bash
npm install
cp .env.example .env   # rellena tus credenciales de Supabase
node --env-file=.env scripts/sync-licitaciones.mjs
```

## Qué hace el script (`scripts/sync-licitaciones.mjs`)

1. Descarga el feed ATOM oficial (con paginación, hasta 20 páginas/500
   entradas cada una por ejecución — ajustable)
2. Parsea cada entrada CODICE a un esquema plano
3. Aplica el **filtro previo** (`pasaFiltroPrevio` en `rule-scoring.mjs`):
   descarta lo que claramente no tiene relación con nuestros sectores
4. Calcula el **score por reglas** (`calcularScore`): CPV + keywords +
   importe + bonus territorial — sin llamar a ninguna IA
5. Hace `upsert` en Supabase usando `id_expediente` como clave de
   deduplicación, conservando histórico si cambia de estado
6. Guarda el cursor de paginación en `sync_state` para la siguiente
   ejecución

## Notas importantes

- **No se descargan ni guardan documentos PDF** — solo se guarda el enlace
  oficial (`enlace_oficial`, `documentos_urls`), para no superar los límites
  del plan Free de Supabase (500MB DB / 1GB Storage)
- `raw_codice` guarda el objeto original completo de cada entrada — si algún
  campo no está bien mapeado a columna, el dato original no se pierde
- La estructura exacta de los campos CODICE (`normalizarEntry` en
  `sync-licitaciones.mjs`) se ha construido a partir de la documentación
  oficial de PLACSP, pero **conviene validarla contra datos reales en la
  primera ejecución** y ajustar las rutas si el organismo emisor usa alguna
  variante del estándar
- Pendiente: ampliar `cpv_biblioteca` y `keywords_biblioteca` (ya hay un
  seed inicial en `sql/schema.sql`) según qué licitaciones reales vayan
  apareciendo
