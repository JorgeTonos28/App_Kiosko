/**
 * KioskoPOS
 * Punto de venta e inventario para Google Apps Script.
 */
const APP_VERSION = '1.1.3';
const APP_TIMEZONE = 'America/Santo_Domingo';
const DB_PROPERTY = 'KIOSKOPOS_SPREADSHEET_ID';
const APP_SCRIPT_FAVICON_URL = 'https://www.gstatic.com/images/icons/material/system/2x/storefront_black_48dp.png';
const SESSION_HOURS = 12;
const REMEMBER_SESSION_DAYS = 7;

const SHEETS = Object.freeze({
  CONFIG: 'Config',
  USERS: 'Usuarios',
  PRODUCTS: 'Productos',
  INVOICES: 'Facturas',
  DETAILS: 'FacturaDetalle',
  MOVEMENTS: 'Movimientos',
  CATEGORIES: 'Categorias',
  CATEGORY_FIELDS: 'CamposCategoria',
  PRODUCT_ATTRIBUTES: 'AtributosProducto',
  SESSIONS: 'Sesiones',
  AUDIT: 'Auditoria'
});

const SCHEMA = Object.freeze({
  Config: ['Clave', 'Valor', 'Descripcion'],
  Usuarios: [
    'ID', 'Nombre', 'Usuario', 'Email', 'PasswordHash', 'Salt', 'Rol',
    'Estado', 'UltimoAcceso', 'CreadoEn', 'ActualizadoEn'
  ],
  Productos: [
    'ID', 'SKU', 'CodigoBarras', 'Nombre', 'Categoria', 'Precio', 'Costo',
    'Stock', 'StockMinimo', 'ImagenFileId', 'Estado', 'CreadoEn', 'ActualizadoEn',
    'CategoriaID', 'NombreManual'
  ],
  Facturas: [
    'ID', 'Numero', 'Fecha', 'UsuarioID', 'Cajero', 'MetodoPago', 'Subtotal',
    'Descuento', 'Impuesto', 'Total', 'MontoRecibido', 'Cambio', 'Estado',
    'MotivoAnulacion', 'AnuladaPor', 'AnuladaEn'
  ],
  FacturaDetalle: [
    'ID', 'FacturaID', 'ProductoID', 'SKU', 'Producto', 'Categoria',
    'Cantidad', 'PrecioUnitario', 'CostoUnitario', 'Subtotal'
  ],
  Movimientos: [
    'ID', 'Fecha', 'ProductoID', 'SKU', 'Producto', 'Tipo', 'Cantidad',
    'Comentario', 'UsuarioID', 'Usuario', 'StockAntes', 'StockDespues', 'FacturaID'
  ],
  Categorias: [
    'ID', 'Nombre', 'Descripcion', 'Estado', 'CreadoEn', 'ActualizadoEn'
  ],
  CamposCategoria: [
    'ID', 'CategoriaID', 'Clave', 'Etiqueta', 'Tipo', 'Obligatorio',
    'Opciones', 'Orden', 'Estado', 'CreadoEn', 'ActualizadoEn'
  ],
  AtributosProducto: [
    'ID', 'ProductoID', 'CampoID', 'Clave', 'Valor', 'ActualizadoEn'
  ],
  Sesiones: [
    'ID', 'TokenHash', 'UsuarioID', 'CreadaEn', 'ExpiraEn', 'Revocada', 'UltimaActividad'
  ],
  Auditoria: [
    'ID', 'Fecha', 'UsuarioID', 'Usuario', 'Accion', 'Entidad', 'EntidadID', 'Detalle'
  ]
});

const DEFAULT_CONFIG = Object.freeze({
  APP_NAME: 'KioskoPOS',
  BUSINESS_NAME: 'KioskoPOS',
  CURRENCY: 'RD$',
  INVOICE_PREFIX: 'KP',
  INVOICE_NEXT: '1',
  TAX_ENABLED: 'FALSE',
  TAX_RATE: '18',
  PAYMENT_METHODS: 'Efectivo,Tarjeta,Transferencia,Mixto',
  CATEGORIES: 'Bebidas,Snacks,Comestibles,Dulces,Galletas,Varios,Celulares,Artículos',
  CATEGORY_MODEL_VERSION: '2',
  ADDRESS: '',
  TAX_ID: '',
  PHONE: '',
  LOGO_FILE_ID: '',
  WEB_SIGNATURE_ENABLED: 'TRUE',
  WEB_SIGNATURE_FILE_ID: '',
  WEB_SIGNATURE_WIDTH: '140',
  PRIMARY_COLOR: '#0b2f78',
  RECEIPT_FOOTER: '¡Gracias por su compra!'
});

function doGet() {
  const branding = getBootBranding_();
  const template = HtmlService.createTemplateFromFile('Index');
  template.appVersion = APP_VERSION;
  template.appName = branding.appName;
  template.businessName = branding.businessName;
  template.logoDataUrl = branding.logoDataUrl;
  template.faviconDataUrl = branding.faviconDataUrl;
  return template
    .evaluate()
    .setTitle(branding.appName)
    .setFaviconUrl(APP_SCRIPT_FAVICON_URL)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

/**
 * Ejecutar una sola vez desde el editor de Apps Script.
 * @param {string=} spreadsheetId ID opcional de una hoja existente.
 * @return {Object} datos de instalación.
 */
function setupKioskoPOS(spreadsheetId) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    let spreadsheet;
    if (spreadsheetId) {
      spreadsheet = SpreadsheetApp.openById(String(spreadsheetId).trim());
    } else {
      spreadsheet = getActiveSpreadsheetSafely_();
      if (!spreadsheet) {
        spreadsheet = SpreadsheetApp.create('KioskoPOS - Base de Datos');
      }
    }

    PropertiesService.getScriptProperties().setProperty(DB_PROPERTY, spreadsheet.getId());
    ensureSchema_(spreadsheet);
    seedConfig_();
    seedAdmin_();
    seedProducts_();
    seedCategories_();
    migrateProductCategories_();
    formatDatabase_(spreadsheet);

    return {
      ok: true,
      version: APP_VERSION,
      spreadsheetId: spreadsheet.getId(),
      spreadsheetUrl: spreadsheet.getUrl(),
      temporaryAdmin: {
        user: 'admin',
        password: 'Admin123!'
      },
      message: 'KioskoPOS fue instalado. Cambie la contraseña temporal del administrador.'
    };
  } finally {
    lock.releaseLock();
  }
}

function getInstallationStatus() {
  const id = PropertiesService.getScriptProperties().getProperty(DB_PROPERTY);
  return {
    installed: Boolean(id),
    spreadsheetId: id || '',
    version: APP_VERSION
  };
}

function getActiveSpreadsheetSafely_() {
  try {
    return SpreadsheetApp.getActiveSpreadsheet();
  } catch (error) {
    return null;
  }
}

function getDb_() {
  const id = PropertiesService.getScriptProperties().getProperty(DB_PROPERTY);
  if (!id) {
    throw new Error('La aplicación no está instalada. Ejecute setupKioskoPOS() desde Apps Script.');
  }
  return SpreadsheetApp.openById(id);
}

function getSheet_(name) {
  const sheet = getDb_().getSheetByName(name);
  if (!sheet) throw new Error('No existe la hoja requerida: ' + name);
  return sheet;
}

function ensureSchema_(spreadsheet) {
  Object.keys(SCHEMA).forEach(function (name) {
    let sheet = spreadsheet.getSheetByName(name);
    if (!sheet) sheet = spreadsheet.insertSheet(name);
    const headers = SCHEMA[name];
    if (sheet.getMaxColumns() < headers.length) {
      sheet.insertColumnsAfter(sheet.getMaxColumns(), headers.length - sheet.getMaxColumns());
    }
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
  });

  const defaultSheet = spreadsheet.getSheetByName('Sheet1') || spreadsheet.getSheetByName('Hoja 1');
  if (defaultSheet && defaultSheet.getLastRow() === 0 && spreadsheet.getSheets().length > 1) {
    spreadsheet.deleteSheet(defaultSheet);
  }
}

function formatDatabase_(spreadsheet) {
  Object.keys(SCHEMA).forEach(function (name) {
    const sheet = spreadsheet.getSheetByName(name);
    const width = SCHEMA[name].length;
    sheet.getRange(1, 1, 1, width)
      .setBackground('#0b2f78')
      .setFontColor('#ffffff')
      .setFontWeight('bold');
    sheet.autoResizeColumns(1, width);
    sheet.setRowHeight(1, 30);
  });
}

function seedConfig_() {
  const current = getConfigMap_();
  const rows = [];
  Object.keys(DEFAULT_CONFIG).forEach(function (key) {
    if (!Object.prototype.hasOwnProperty.call(current, key)) {
      rows.push([key, DEFAULT_CONFIG[key], 'Configuración inicial de KioskoPOS']);
    }
  });
  if (rows.length) appendRows_(SHEETS.CONFIG, rows);
}

function seedAdmin_() {
  const users = getRowsAsObjects_(SHEETS.USERS);
  if (users.length) return;
  const now = new Date();
  const salt = Utilities.getUuid().replace(/-/g, '');
  appendObject_(SHEETS.USERS, {
    ID: Utilities.getUuid(),
    Nombre: 'Administrador',
    Usuario: 'admin',
    Email: 'admin@kiosk.local',
    PasswordHash: hashPassword_('Admin123!', salt),
    Salt: salt,
    Rol: 'ADMIN',
    Estado: 'ACTIVO',
    UltimoAcceso: '',
    CreadoEn: now,
    ActualizadoEn: now
  });
}

function seedProducts_() {
  if (getRowsAsObjects_(SHEETS.PRODUCTS).length) return;
  const now = new Date();
  const samples = [
    ['BEB-001', '746000000001', 'Refresco Cola 20 oz', 'Bebidas', 50, 32, 24, 6],
    ['BEB-002', '746000000002', 'Agua purificada 16 oz', 'Bebidas', 25, 12, 40, 10],
    ['BEB-003', '746000000003', 'Jugo de naranja', 'Bebidas', 45, 28, 18, 5],
    ['SNK-001', '746000000004', 'Papas clásicas', 'Snacks', 65, 40, 12, 5],
    ['SNK-002', '746000000005', 'Palitos de queso', 'Snacks', 35, 20, 8, 4],
    ['DUL-001', '746000000006', 'Chocolate con leche', 'Dulces', 40, 24, 3, 5],
    ['GAL-001', '746000000007', 'Galletas de chocolate', 'Galletas', 30, 17, 20, 5],
    ['COM-001', '746000000008', 'Pan de agua', 'Comestibles', 15, 8, 30, 8],
    ['COM-002', '746000000009', 'Sándwich de jamón y queso', 'Comestibles', 125, 78, 10, 3],
    ['VAR-001', '746000000010', 'Servilletas paquete', 'Varios', 55, 31, 7, 3]
  ];
  const rows = samples.map(function (item) {
    return [
      Utilities.getUuid(), item[0], item[1], item[2], item[3], item[4], item[5],
      item[6], item[7], '', 'ACTIVO', now, now
    ];
  });
  appendRows_(SHEETS.PRODUCTS, rows);
}

/**
 * Migra instalaciones anteriores al modelo de categorías configurables.
 * Es idempotente y puede ejecutarse manualmente si se desea.
 */
function migrateKioskoPOS() {
  ensureLatestSchema_();
  return {ok: true, version: APP_VERSION, categories: getCategoryModels_(true).length};
}

function ensureLatestSchema_() {
  const cache = CacheService.getScriptCache();
  const cacheKey = 'schema-ready:' + APP_VERSION;
  if (cache.get(cacheKey)) return;
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const spreadsheet = getDb_();
    ensureSchema_(spreadsheet);
    seedConfig_();
    seedCategories_();
    migrateProductCategories_();
    cache.put(cacheKey, '1', 21600);
  } finally {
    lock.releaseLock();
  }
}

function seedCategories_() {
  const configured = String(getConfigValue_('CATEGORIES', DEFAULT_CONFIG.CATEGORIES))
    .split(',').map(function (name) { return cleanText_(name, 80); }).filter(Boolean);
  const productNames = getRowsAsObjects_(SHEETS.PRODUCTS)
    .map(function (product) { return cleanText_(product.Categoria, 80); }).filter(Boolean);
  const existing = getRowsAsObjects_(SHEETS.CATEGORIES);
  const names = configured.concat(productNames).concat(existing.length ? [] : ['Celulares', 'Artículos']);
  const known = {};
  existing.forEach(function (category) { known[String(category.Nombre).toLowerCase()] = category; });
  const now = new Date();

  names.forEach(function (name) {
    const normalized = name.toLowerCase();
    if (known[normalized]) return;
    const category = {
      ID: Utilities.getUuid(),
      Nombre: name,
      Descripcion: normalized === 'celulares'
        ? 'Celulares y dispositivos móviles con datos de identificación.'
        : normalized === 'artículos' ? 'Artículos generales sin características adicionales.' : '',
      Estado: 'ACTIVO',
      CreadoEn: now,
      ActualizadoEn: now
    };
    appendObject_(SHEETS.CATEGORIES, category);
    known[normalized] = category;
    if (normalized === 'celulares') seedCellPhoneFields_(category.ID, now);
  });

  const activeNames = getRowsAsObjects_(SHEETS.CATEGORIES)
    .filter(function (category) { return category.Estado === 'ACTIVO'; })
    .map(function (category) { return category.Nombre; });
  setConfigValues_({
    CATEGORIES: activeNames.join(','),
    CATEGORY_MODEL_VERSION: '2'
  });
}

function seedCellPhoneFields_(categoryId, now) {
  const definitions = [
    ['marca', 'Marca', 'TEXT', true, '', 1],
    ['modelo', 'Modelo', 'TEXT', true, '', 2],
    ['color', 'Color', 'TEXT', false, '', 3],
    ['memoria', 'Memoria', 'TEXT', false, '', 4],
    ['imei', 'IMEI', 'TEXT', false, '', 5],
    ['serial', 'Serial', 'TEXT', false, '', 6],
    ['descripcion', 'Descripción', 'TEXTAREA', false, '', 7]
  ];
  const rows = definitions.map(function (field) {
    return [
      Utilities.getUuid(), categoryId, field[0], field[1], field[2], field[3],
      field[4], field[5], 'ACTIVO', now, now
    ];
  });
  appendRows_(SHEETS.CATEGORY_FIELDS, rows);
}

function migrateProductCategories_() {
  const categories = getRowsAsObjects_(SHEETS.CATEGORIES);
  const byName = {};
  const byId = {};
  categories.forEach(function (category) {
    byName[String(category.Nombre).toLowerCase()] = category;
    byId[String(category.ID)] = category;
  });
  getRowsAsObjects_(SHEETS.PRODUCTS).forEach(function (product) {
    const category = byId[String(product.CategoriaID || '')] ||
      byName[String(product.Categoria || '').toLowerCase()];
    if (!category) return;
    const patch = {};
    if (String(product.CategoriaID || '') !== String(category.ID)) patch.CategoriaID = category.ID;
    if (product.Categoria !== category.Nombre) patch.Categoria = category.Nombre;
    if (product.NombreManual === '') patch.NombreManual = true;
    if (Object.keys(patch).length) updateObjectRow_(SHEETS.PRODUCTS, product._row, patch);
  });
}

function getRowsAsObjects_(sheetName) {
  const sheet = getSheet_(sheetName);
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];
  const headers = values[0];
  return values.slice(1).filter(function (row) {
    return row.some(function (value) { return value !== ''; });
  }).map(function (row, index) {
    const object = {_row: index + 2};
    headers.forEach(function (header, column) {
      object[header] = serializeValue_(row[column]);
    });
    return object;
  });
}

function serializeValue_(value) {
  if (value instanceof Date) return value.toISOString();
  return value;
}

function appendObject_(sheetName, object) {
  const headers = SCHEMA[sheetName];
  if (!headers) throw new Error('Esquema desconocido: ' + sheetName);
  appendRows_(sheetName, [headers.map(function (header) {
    return Object.prototype.hasOwnProperty.call(object, header) ? object[header] : '';
  })]);
}

function appendRows_(sheetName, rows) {
  if (!rows || !rows.length) return;
  const sheet = getSheet_(sheetName);
  sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
}

function updateObjectRow_(sheetName, rowNumber, patch) {
  const headers = SCHEMA[sheetName];
  const sheet = getSheet_(sheetName);
  const values = sheet.getRange(rowNumber, 1, 1, headers.length).getValues()[0];
  headers.forEach(function (header, index) {
    if (Object.prototype.hasOwnProperty.call(patch, header)) values[index] = patch[header];
  });
  sheet.getRange(rowNumber, 1, 1, headers.length).setValues([values]);
}

function findById_(sheetName, id) {
  return getRowsAsObjects_(sheetName).find(function (row) {
    return String(row.ID) === String(id);
  }) || null;
}

function getConfigMap_() {
  const config = {};
  getRowsAsObjects_(SHEETS.CONFIG).forEach(function (row) {
    config[String(row.Clave).trim()] = String(row.Valor == null ? '' : row.Valor);
  });
  return config;
}

function getConfigValue_(key, fallback) {
  const config = getConfigMap_();
  return Object.prototype.hasOwnProperty.call(config, key) ? config[key] : fallback;
}

function setConfigValues_(values) {
  const sheet = getSheet_(SHEETS.CONFIG);
  const rows = getRowsAsObjects_(SHEETS.CONFIG);
  Object.keys(values).forEach(function (key) {
    const existing = rows.find(function (row) { return row.Clave === key; });
    if (existing) {
      updateObjectRow_(SHEETS.CONFIG, existing._row, {Valor: String(values[key])});
    } else {
      sheet.appendRow([key, String(values[key]), 'Configuración de KioskoPOS']);
    }
  });
}

function cleanText_(value, maxLength) {
  return String(value == null ? '' : value).trim().slice(0, maxLength || 500);
}

function slugifyKey_(value) {
  return String(value || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '').slice(0, 60);
}

function toNumber_(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : (fallback || 0);
}

function roundMoney_(value) {
  return Math.round((toNumber_(value) + Number.EPSILON) * 100) / 100;
}

function normalizeRole_(role) {
  return String(role || '').toUpperCase() === 'ADMIN' ? 'ADMIN' : 'CAJERO';
}

function normalizeStatus_(status) {
  return String(status || '').toUpperCase() === 'INACTIVO' ? 'INACTIVO' : 'ACTIVO';
}

function nowIso_() {
  return new Date().toISOString();
}

function hashString_(value) {
  const digest = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    String(value),
    Utilities.Charset.UTF_8
  );
  return digest.map(function (byte) {
    const normalized = byte < 0 ? byte + 256 : byte;
    return ('0' + normalized.toString(16)).slice(-2);
  }).join('');
}

function hashPassword_(password, salt) {
  return hashString_(salt + ':' + String(password));
}

function getImageDataUrlFromConfig_(key) {
  const fileId = getConfigValue_(key, '');
  return fileId ? getDriveImageDataUrl_(fileId) : '';
}

function getDriveImageDataUrl_(fileId) {
  if (!fileId) return '';
  const cache = CacheService.getScriptCache();
  const cacheKey = 'image:' + hashString_(fileId).slice(0, 32);
  const cached = cache.get(cacheKey);
  if (cached) return cached;
  const blob = DriveApp.getFileById(fileId).getBlob();
  const contentType = blob.getContentType() || 'image/png';
  const dataUrl = 'data:' + contentType + ';base64,' + Utilities.base64Encode(blob.getBytes());
  if (dataUrl.length < 95000) cache.put(cacheKey, dataUrl, 21600);
  return dataUrl;
}

function safeLogoDataUrl_() {
  return safeImageDataUrlFromConfig_('LOGO_FILE_ID', 'logo');
}

function safeImageDataUrlFromConfig_(key, label) {
  try {
    if (!PropertiesService.getScriptProperties().getProperty(DB_PROPERTY)) return '';
    return getImageDataUrlFromConfig_(key);
  } catch (error) {
    console.warn('No se pudo cargar ' + (label || key) + ': ' + error.message);
    return '';
  }
}

function getBootBranding_() {
  const defaults = {
    appName: DEFAULT_CONFIG.APP_NAME,
    businessName: DEFAULT_CONFIG.BUSINESS_NAME,
    primaryColor: DEFAULT_CONFIG.PRIMARY_COLOR,
    logoDataUrl: ''
  };
  try {
    if (!PropertiesService.getScriptProperties().getProperty(DB_PROPERTY)) {
      return Object.assign(defaults, {faviconDataUrl: buildFaviconDataUrl_(defaults)});
    }
    const config = getConfigMap_();
    const branding = {
      appName: cleanText_(config.APP_NAME || defaults.appName, 80),
      businessName: cleanText_(config.BUSINESS_NAME || defaults.businessName, 120),
      primaryColor: cleanText_(config.PRIMARY_COLOR || defaults.primaryColor, 20),
      logoDataUrl: safeLogoDataUrl_()
    };
    branding.faviconDataUrl = buildFaviconDataUrl_(branding);
    return branding;
  } catch (error) {
    console.warn('No se pudo cargar el branding: ' + error.message);
    return Object.assign(defaults, {faviconDataUrl: buildFaviconDataUrl_(defaults)});
  }
}

function buildFaviconDataUrl_(branding) {
  const label = cleanText_(branding.businessName || branding.appName || 'K', 120);
  const initial = (label.trim().charAt(0) || 'K').toUpperCase();
  const color = /^#[0-9a-f]{6}$/i.test(String(branding.primaryColor || ''))
    ? branding.primaryColor : DEFAULT_CONFIG.PRIMARY_COLOR;
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">' +
    '<rect width="64" height="64" rx="14" fill="' + color + '"/>' +
    '<text x="32" y="42" text-anchor="middle" font-family="Arial,sans-serif" font-size="32" font-weight="800" fill="white">' +
    initial.replace(/[<>&"']/g, '') + '</text></svg>';
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}

function addAudit_(user, action, entity, entityId, detail) {
  appendObject_(SHEETS.AUDIT, {
    ID: Utilities.getUuid(),
    Fecha: new Date(),
    UsuarioID: user ? user.ID : '',
    Usuario: user ? user.Nombre : 'Sistema',
    Accion: action,
    Entidad: entity,
    EntidadID: entityId || '',
    Detalle: typeof detail === 'string' ? detail : JSON.stringify(detail || {})
  });
}

function publicUser_(user) {
  return {
    id: user.ID,
    name: user.Nombre,
    username: user.Usuario,
    email: user.Email,
    role: user.Rol,
    status: user.Estado,
    lastAccess: user.UltimoAcceso || ''
  };
}
