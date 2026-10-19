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

### Puntos de venta

Aplicá `supabase/migrations/010_sale_points.sql` en el SQL Editor del proyecto
para crear `public.sale_points`. Requiere las funciones de permisos de
`001_rls_company_isolation.sql`; no depende de la migración 009.

Cada punto guarda empresa, número, nombre, domicilio, ambiente, sistema de
facturación, estado activo, selección predeterminada y fechas de auditoría.
El número se guarda como entero y se muestra con cinco dígitos: `3` → `00003`.
El sistema es `web_services`; el ambiente predeterminado es `testing`, como
la configuración actual de emisión. El mismo número puede existir en empresas
o ambientes distintos, pero no repetirse dentro de la misma combinación.

Propietarios y administradores pueden administrar y eliminar los registros;
accountants pueden crear y editar; viewers solo pueden consultar los de su
empresa. RLS también comprueba la empresa de destino al editar un registro.

Para elegir el predeterminado desde un cliente Supabase autenticado, llamá
`set_default_sale_point` con `p_company_id`, `p_sale_point_id` y
`p_environment` (`testing` por defecto). Solo admite puntos activos y cambia
la selección en una transacción. Al desactivar directamente un predeterminado,
hay que enviar también `is_default: false` o elegir antes otro punto.

Esta migración crea el catálogo y sus permisos. No modifica automáticamente el
campo anterior `companies.default_sale_point` ni agrega un selector al frontend.
El alta fiscal de los puntos sigue realizándose en ARCA.

### Una sola solicitud de CAE por factura

Antes de desplegar estos cambios, aplicá
`supabase/migrations/009_invoice_cae_requests.sql` en el proyecto y volvé a
desplegar la Edge Function `afip-emit`. Reiniciá también la API Express.
La migración agrega un registro permanente compartido por ambas vías de emisión.

Tanto `afip-emit` como `POST /api/v1/invoices/emit` requieren un `id` UUID
estable y `company_id` en la factura. El frontend debe generar el UUID una
sola vez al iniciar el borrador (`crypto.randomUUID()`), conservarlo ante
errores, recargas y reintentos, y usarlo también al guardar la factura.
Para una factura guardada debe enviar su `id` existente. No generar un UUID
nuevo al pulsar «Solicitar CAE». Sin ese identificador se rechaza la solicitud.
El repositorio contiguo `Invotrack-frontend` ya implementa este comportamiento:
conserva el UUID del borrador en la URL y deshabilita el botón después del
primer intento, también al recargar la misma pestaña.

La primera llamada reserva el identificador en PostgreSQL antes de solicitar
el CAE. Una segunda llamada, incluso simultánea, recibe **409** y no vuelve
a emitir. También se rechazan facturas que ya tienen un CAE en la base.
El usuario debe ser propietario, admin o accountant de la empresa.

El bloqueo se conserva incluso si ARCA rechaza la solicitud, hay un timeout
o falla el guardado posterior. No se libera automáticamente: el comprobante
podría haber quedado autorizado. `invoice_cae_requests` conserva los datos
del pedido y la respuesta recibida para consultar el comprobante en ARCA y
recuperar su resultado sin solicitar un nuevo CAE. No borrar ese registro
para reintentar. La respuesta de `afip-emit` mantiene su formato habitual.

Verificá con una factura de homologación: enviá dos llamadas simultáneas con
el mismo UUID y luego repetí la llamada. Solo una debe llegar a
`FECAESolicitar`; las restantes deben recibir 409. Dos facturas distintas
pueden tener datos comerciales idénticos, pero deben tener UUID distintos.

### Registro sin correo de confirmación

Las cuentas nuevas deben poder iniciar sesión al registrarse, sin recibir un
correo de confirmación. `supabase/config.toml` define
`auth.email.enable_confirmations = false` para el entorno local.

Para el proyecto alojado, abrí Supabase Dashboard → Authentication → Sign In /
Providers → Email, desactivá **Confirm email** y guardá los cambios. Editar
`config.toml` por sí solo no actualiza el proyecto remoto. Este ajuste lo
gestiona Supabase Auth; no requiere cambios en `.env` ni en las rutas Express.

Para verificarlo, registrá una cuenta nueva desde el frontend y comprobá que
Supabase devuelve una sesión y permite ingresar sin confirmar el correo.

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
