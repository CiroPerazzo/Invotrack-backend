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
`/api/v1/companies/:companyId/{clients|providers|products}` requieren una cookie
`accessToken` HttpOnly. `POST /api/v1/auth/session` recibe un `accessToken` de
Supabase, lo valida y establece la cookie; `DELETE /api/v1/auth/session` la borra.
El middleware valida el
usuario con Supabase Auth, comprueba su rol en la empresa y usa su JWT en
consultas a PostgreSQL para conservar RLS.

`POST /api/v1/invoices/emit` también requiere la cookie y rol admin/accountant.
Solo esta ruta Express utiliza `SUPABASE_SERVICE_ROLE_KEY` y
`AFIPSDK_ACCESS_TOKEN`; no son necesarios para iniciar el servidor ni para
las rutas de catálogo. El frontend actual emite por Edge Function y no usa
esta ruta Express.

## Infraestructura Supabase

### Órdenes de compra

Aplicá `supabase/migrations/008_purchase_orders.sql` en el SQL Editor del
proyecto Supabase antes de usar la nueva sección. La migración agrega órdenes,
ítems y asignaciones entre órdenes y facturas. No modifica facturas existentes.
Requiere que las migraciones anteriores, en especial
`001_rls_company_isolation.sql` y `007_products_company_rls.sql`, ya estén
aplicadas. Después, reiniciá el backend y el frontend.

Para probarlo: creá dos órdenes `pending` del mismo proveedor, seleccioná
importes de ambas y usá «Crear factura agrupada». La factura debe mostrar las
dos órdenes, y el listado debe mostrar el saldo restante de cada una. Una
selección de proveedores distintos debe rechazarse antes de abrir el formulario.

Una orden pertenece a una empresa y un proveedor. El total se deriva de sus
ítems; el saldo facturado se deriva de las asignaciones. Solo se pueden asociar
facturas `payable` del mismo proveedor y empresa. Los controles de saldo y
compatibilidad se ejecutan dentro de PostgreSQL, también para llamadas directas
a Supabase. El flujo de factura agrupada usa una línea resumen por orden y no
actualiza stock: recibir mercadería no está modelado por esta función.

Endpoints (todos bajo `/api/v1`, autenticados):

- `GET/POST /companies/:companyId/purchase-orders`
- `POST /companies/:companyId/purchase-orders/grouped-invoice` (factura, ítems y vínculos en una transacción)
- `GET/PUT/DELETE /companies/:companyId/purchase-orders/:id`
- `PATCH /companies/:companyId/purchase-orders/:id/cancel`
- `POST /companies/:companyId/purchase-orders/group-preview`
- `GET/POST /companies/:companyId/invoices/:invoiceId/purchase-orders`

Solo `admin` y `accountant` pueden crear, modificar o asignar; solo `admin`
puede eliminar. Las consultas respetan la pertenencia a la empresa.

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
