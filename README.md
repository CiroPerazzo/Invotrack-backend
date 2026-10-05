# InvoTrack backend

API Express independiente y futura raíz de `invotrack-backend`. Necesita
únicamente este directorio y acceso al mismo proyecto Supabase que usa el
frontend. No lee el `.env`, `package.json` ni `node_modules` del frontend.

## Instalación y ejecución

```bash
npm install
```

Copiá `.env.example` a `.env` y completá `SUPABASE_URL` y
`SUPABASE_ANON_KEY`. El puerto predeterminado es `3001` y `CORS_ORIGIN`
predetermina `http://localhost:5173`. Definí ambos según el despliegue.

```bash
npm run dev
npm start
npm run lint
npm test
```

`GET /api/v1/health` es público. Las rutas de catálogo
`/api/v1/companies/:companyId/{clients|providers|products}` requieren
`Authorization: Bearer <Supabase access_token>`. El middleware valida el
usuario con Supabase Auth, comprueba su rol en la empresa y usa su JWT en
consultas a PostgreSQL para conservar RLS.

`POST /api/v1/invoices/emit` también requiere token y rol admin/accountant.
Solo esta ruta Express utiliza `SUPABASE_SERVICE_ROLE_KEY` y
`AFIPSDK_ACCESS_TOKEN`; no son necesarios para iniciar el servidor ni para
las rutas de catálogo. El frontend actual emite por Edge Function y no usa
esta ruta Express.

## Infraestructura Supabase

`supabase/schema.sql`, `supabase/migrations/`, `supabase/config.toml` y
`supabase/functions/` viven aquí. Las Edge Functions se despliegan con
Supabase y reciben sus propios secretos; no los lee automáticamente Express.
No apliques `schema.sql` ni migraciones sin revisar primero el estado real
de la base. `schema.sql` por sí solo no incluye todos los cambios usados por
la aplicación actual.

`scripts/arca/` contiene utilidades de homologación. Sus rutas de certificado
se resuelven desde esta raíz. Son independientes del proceso Express y usan
`AFIP_CERT_PATH`, `AFIP_KEY_PATH`, `AFIP_CUIT` y `AFIP_ENVIRONMENT` de
`.env` cuando se ejecutan. Los certificados, cachés y resultados están
excluidos de Git.
