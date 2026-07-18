# KioskoPOS

Aplicación web interna de facturación, inventario y administración construida con Google Apps Script y Google Sheets.

## Funcionalidades

- POS rápido con búsqueda, categorías, carrito, descuento y varios métodos de pago.
- Descuento automático de inventario al generar una factura.
- Entradas y salidas manuales con comentario, usuario y trazabilidad de stock.
- Facturas imprimibles, historial, detalle y anulación con reversión de inventario.
- Categorías configurables desde la UI, con características adicionales y obligatoriedad por categoría.
- Categorías iniciales `Celulares` y `Artículos`; celulares incluye Marca, Modelo, Color, Memoria, IMEI, Serial y Descripción.
- Nombre de producto, SKU y código de barras opcionales; el nombre puede generarse con Marca + Modelo.
- Filtros de movimientos por producto, tipo y rango de fechas.
- Productos, usuarios, configuración, dashboard y reportes.
- Roles `ADMIN` y `CAJERO`, autenticación interna y sesiones con vencimiento.
- Imágenes y logo desde Google Drive convertidos a `data:` para Web App e impresión.
- Interfaz responsive para escritorio, tablet y móvil.

## Archivos

| Archivo | Propósito |
| --- | --- |
| `Código.js` | Configuración, instalación, acceso a la BD y utilidades. |
| `Auth.js` | Login, sesiones, permisos y contraseñas. |
| `Api.js` | Productos, inventario, ventas, usuarios, dashboard y reportes. |
| `Index.html` | Aplicación web completa. |
| `Scripts.html` | Estado, vistas, interacciones y modo demo. |
| `Styles.html` | Sistema visual responsive y estilos del POS. |
| `appsscript.json` | Manifest y permisos de Apps Script. |

## Instalación

1. Cree un proyecto nuevo de Apps Script o vincule esta carpeta mediante `clasp`.
2. Ejecute `setupKioskoPOS()` desde el editor.
3. Autorice los permisos solicitados.
4. Abra la URL de la hoja creada que devuelve la ejecución.
5. Despliegue como **Web app**, ejecutando como el usuario que despliega.
6. Inicie con `admin` / `Admin123!` y cambie la contraseña inmediatamente.

También puede ejecutar `setupKioskoPOS('ID_DE_UNA_HOJA_EXISTENTE')` para usar una hoja específica.

### Actualización de una instalación existente

Después de subir esta versión, ejecute una vez `migrateKioskoPOS()` desde el editor de Apps Script. La migración conserva productos y movimientos existentes, agrega las nuevas tablas y enlaza cada producto con su categoría. El arranque de la app también verifica el esquema de forma automática.

## Base de datos

La instalación crea estas pestañas:

- `Config`
- `Usuarios`
- `Productos`
- `Facturas`
- `FacturaDetalle`
- `Movimientos`
- `Categorias`
- `CamposCategoria`
- `AtributosProducto`
- `Sesiones`
- `Auditoria`

No cambie los nombres ni los encabezados de estas hojas.

Las características variables se guardan en `AtributosProducto` y se relacionan con `CamposCategoria`. Este modelo evita crear columnas arbitrarias en `Productos`; al quitar una característica se desactiva su definición, pero sus valores históricos permanecen en la base de datos.

## Imágenes de Drive

En Config, `LOGO_FILE_ID` contiene el ID del logo. En productos, `ImagenFileId` contiene el ID de su foto. La app obtiene el blob desde Drive y lo convierte a una URL `data:image/...;base64`.

## Desarrollo con clasp

```text
clasp login
clasp clone TU_SCRIPT_ID
clasp push
```

Mantenga `.clasp.json` fuera de Git. Para probar PRs por número puede agregar:

```text
git config --add remote.origin.fetch "+refs/pull/*/head:refs/remotes/origin/pr/*"
git fetch origin
git switch -c pr-1 origin/pr/1
clasp push
```

## Seguridad

- Toda operación sensible valida la sesión y el rol en el servidor.
- Los precios y totales se recalculan en Apps Script.
- Las contraseñas se almacenan con hash SHA-256 y salt individual.
- Las ventas y anulaciones usan `LockService` para evitar carreras de inventario.
- La impresión se realiza en un documento aislado del dashboard para evitar páginas vacías y estilos residuales del modal.
- Para un entorno institucional, restrinja el acceso del despliegue al dominio cuando corresponda.
