function apiBootstrap(token) {
  const user = verifySession_(token);
  ensureLatestSchema_();
  const config = getPublicConfig_();
  const products = getProductsForClient_();
  const invoices = getInvoicesForUser_(user, {}).slice(0, 50);
  return {
    version: APP_VERSION,
    user: publicUser_(user),
    config: config,
    products: products,
    dashboard: buildDashboard_(user),
    invoices: invoices,
    movements: user.Rol === 'ADMIN' ? getMovements_({limit: 250}) : [],
    categories: user.Rol === 'ADMIN' ? getCategoryModels_(true) : getCategoryModels_(false),
    users: user.Rol === 'ADMIN' ? getUsersForClient_() : [],
    reports: user.Rol === 'ADMIN' ? buildReports_({preset: 'month'}) : null
  };
}

function apiRefreshDashboard(token) {
  const user = verifySession_(token);
  return buildDashboard_(user);
}

function apiListProducts(token, filters) {
  verifySession_(token);
  filters = filters || {};
  let products = getProductsForClient_();
  const query = cleanText_(filters.query, 100).toLowerCase();
  if (query) {
    products = products.filter(function (product) {
      return [product.name, product.sku, product.barcode, product.category, product.searchText]
        .join(' ').toLowerCase().indexOf(query) !== -1;
    });
  }
  if (filters.category && filters.category !== 'Todos') {
    products = products.filter(function (product) { return product.category === filters.category; });
  }
  if (filters.status) {
    products = products.filter(function (product) { return product.status === filters.status; });
  }
  return products;
}

function apiListCategories(token) {
  requireAdmin_(token);
  ensureLatestSchema_();
  return getCategoryModels_(true);
}

function apiSaveCategory(token, payload) {
  const user = requireAdmin_(token);
  ensureLatestSchema_();
  payload = payload || {};
  const id = cleanText_(payload.id, 80);
  const existing = id ? findById_(SHEETS.CATEGORIES, id) : null;
  const name = cleanText_(payload.name, 80);
  const description = cleanText_(payload.description, 500);
  const status = normalizeStatus_(payload.status);
  const fields = Array.isArray(payload.fields) ? payload.fields : [];
  if (!name) throw new Error('El nombre de la categoría es obligatorio.');
  if (fields.length > 30) throw new Error('Una categoría puede tener un máximo de 30 características adicionales.');

  const duplicate = getRowsAsObjects_(SHEETS.CATEGORIES).find(function (category) {
    return String(category.ID) !== String(id) &&
      String(category.Nombre).toLowerCase() === name.toLowerCase();
  });
  if (duplicate) throw new Error('Ya existe una categoría con ese nombre.');

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const now = new Date();
    const categoryId = existing ? existing.ID : Utilities.getUuid();
    if (existing) {
      updateObjectRow_(SHEETS.CATEGORIES, existing._row, {
        Nombre: name,
        Descripcion: description,
        Estado: status,
        ActualizadoEn: now
      });
    } else {
      appendObject_(SHEETS.CATEGORIES, {
        ID: categoryId,
        Nombre: name,
        Descripcion: description,
        Estado: status,
        CreadoEn: now,
        ActualizadoEn: now
      });
    }

    const storedFields = getRowsAsObjects_(SHEETS.CATEGORY_FIELDS).filter(function (field) {
      return String(field.CategoriaID) === String(categoryId);
    });
    const submittedIds = {};
    const usedKeys = {};
    fields.forEach(function (field, index) {
      const normalized = normalizeCategoryField_(field, index);
      let stored = normalized.id ? storedFields.find(function (item) {
        return String(item.ID) === String(normalized.id);
      }) : null;
      if (!stored) {
        const desiredKey = normalized.key || slugifyKey_(normalized.label);
        stored = storedFields.find(function (item) {
          return item.Estado !== 'ACTIVO' && item.Clave === desiredKey;
        }) || null;
      }
      let key = stored ? stored.Clave : (normalized.key || slugifyKey_(normalized.label));
      const baseKey = key || 'campo';
      let suffix = 2;
      while (usedKeys[key] || storedFields.some(function (item) {
        return item.Clave === key && (!stored || String(item.ID) !== String(stored.ID)) && item.Estado === 'ACTIVO';
      })) {
        key = baseKey + '_' + suffix++;
      }
      usedKeys[key] = true;
      if (stored) {
        submittedIds[stored.ID] = true;
        updateObjectRow_(SHEETS.CATEGORY_FIELDS, stored._row, {
          Etiqueta: normalized.label,
          Tipo: normalized.type,
          Obligatorio: normalized.required,
          Opciones: normalized.options,
          Orden: index + 1,
          Estado: 'ACTIVO',
          ActualizadoEn: now
        });
      } else {
        const fieldId = Utilities.getUuid();
        submittedIds[fieldId] = true;
        appendObject_(SHEETS.CATEGORY_FIELDS, {
          ID: fieldId,
          CategoriaID: categoryId,
          Clave: key,
          Etiqueta: normalized.label,
          Tipo: normalized.type,
          Obligatorio: normalized.required,
          Opciones: normalized.options,
          Orden: index + 1,
          Estado: 'ACTIVO',
          CreadoEn: now,
          ActualizadoEn: now
        });
      }
    });

    storedFields.forEach(function (field) {
      if (field.Estado === 'ACTIVO' && !submittedIds[field.ID]) {
        updateObjectRow_(SHEETS.CATEGORY_FIELDS, field._row, {
          Estado: 'INACTIVO',
          ActualizadoEn: now
        });
      }
    });

    if (existing && existing.Nombre !== name) {
      getRowsAsObjects_(SHEETS.PRODUCTS).forEach(function (product) {
        if (String(product.CategoriaID) === String(categoryId)) {
          updateObjectRow_(SHEETS.PRODUCTS, product._row, {Categoria: name, ActualizadoEn: now});
        }
      });
    }
    syncCategoryConfig_();
    addAudit_(user, existing ? 'ACTUALIZAR' : 'CREAR', 'CATEGORIA', categoryId, {
      name: name,
      fields: fields.length,
      status: status
    });
    return {
      ok: true,
      categories: getCategoryModels_(true),
      config: getPublicConfig_(),
      products: getProductsForClient_()
    };
  } finally {
    lock.releaseLock();
  }
}

function apiSaveProduct(token, payload) {
  const user = requireAdmin_(token);
  ensureLatestSchema_();
  payload = payload || {};
  const id = cleanText_(payload.id, 80);
  const existing = id ? findById_(SHEETS.PRODUCTS, id) : null;
  const sku = cleanText_(payload.sku, 40).toUpperCase();
  const manualName = cleanText_(payload.name, 160);
  const categoryId = cleanText_(payload.categoryId, 80);
  const category = getCategoryModels_(true).find(function (item) {
    return String(item.id) === String(categoryId);
  });
  const price = roundMoney_(payload.price);
  const cost = roundMoney_(payload.cost);
  const minimum = Math.max(0, Math.floor(toNumber_(payload.minimum)));
  const initialStock = Math.max(0, Math.floor(toNumber_(payload.stock)));
  if (!category) throw new Error('Seleccione una categoría válida.');
  if (category.status !== 'ACTIVO' && (!existing || String(existing.CategoriaID) !== String(category.id))) {
    throw new Error('No se pueden crear productos en una categoría inactiva.');
  }
  const attributes = validateProductAttributes_(category, payload.attributes || {});
  const brand = getAttributeValueByKey_(attributes, 'marca');
  const model = getAttributeValueByKey_(attributes, 'modelo');
  if (!manualName && (!brand || !model)) {
    throw new Error('Indique un nombre para el producto o complete Marca y Modelo.');
  }
  const name = manualName || (brand + ' ' + model).trim();

  if (price <= 0) throw new Error('El precio de venta debe ser mayor que cero.');
  if (cost < 0 || cost > price * 10) throw new Error('Revise el costo indicado.');

  if (sku) {
    const duplicateSku = getRowsAsObjects_(SHEETS.PRODUCTS).find(function (product) {
      return String(product.SKU).toUpperCase() === sku && String(product.ID) !== String(id);
    });
    if (duplicateSku) throw new Error('Ya existe un producto con el SKU ' + sku + '.');
  }
  const barcode = cleanText_(payload.barcode, 80);
  if (barcode) {
    const duplicateBarcode = getRowsAsObjects_(SHEETS.PRODUCTS).find(function (product) {
      return String(product.CodigoBarras) === barcode && String(product.ID) !== String(id);
    });
    if (duplicateBarcode) throw new Error('Ya existe un producto con ese código de barras.');
  }

  const now = new Date();
  if (existing) {
    updateObjectRow_(SHEETS.PRODUCTS, existing._row, {
      SKU: sku,
      CodigoBarras: barcode,
      Nombre: name,
      Categoria: category.name,
      CategoriaID: category.id,
      NombreManual: Boolean(manualName),
      Precio: price,
      Costo: cost,
      StockMinimo: minimum,
      ImagenFileId: cleanText_(payload.imageFileId, 160),
      Estado: normalizeStatus_(payload.status),
      ActualizadoEn: now
    });
    saveProductAttributes_(existing.ID, attributes);
    addAudit_(user, 'ACTUALIZAR', 'PRODUCTO', existing.ID, {
      sku: sku, name: name, category: category.name
    });
  } else {
    const productId = Utilities.getUuid();
    appendObject_(SHEETS.PRODUCTS, {
      ID: productId,
      SKU: sku,
      CodigoBarras: barcode,
      Nombre: name,
      Categoria: category.name,
      CategoriaID: category.id,
      NombreManual: Boolean(manualName),
      Precio: price,
      Costo: cost,
      Stock: initialStock,
      StockMinimo: minimum,
      ImagenFileId: cleanText_(payload.imageFileId, 160),
      Estado: normalizeStatus_(payload.status),
      CreadoEn: now,
      ActualizadoEn: now
    });
    saveProductAttributes_(productId, attributes);
    if (initialStock > 0) {
      appendInventoryMovement_({
        product: {ID: productId, SKU: sku, Nombre: name},
        type: 'ENTRADA',
        quantity: initialStock,
        comment: 'Stock inicial del producto',
        user: user,
        before: 0,
        after: initialStock,
        invoiceId: ''
      });
    }
    addAudit_(user, 'CREAR', 'PRODUCTO', productId, {
      sku: sku, name: name, category: category.name
    });
  }
  return {ok: true, products: getProductsForClient_()};
}

function apiInventoryMovement(token, payload) {
  const user = requireAdmin_(token);
  ensureLatestSchema_();
  payload = payload || {};
  const product = findById_(SHEETS.PRODUCTS, cleanText_(payload.productId, 80));
  const type = String(payload.type || '').toUpperCase();
  const quantity = Math.floor(toNumber_(payload.quantity));
  const comment = cleanText_(payload.comment, 500);
  if (!product) throw new Error('Producto no encontrado.');
  if (['ENTRADA', 'SALIDA'].indexOf(type) === -1) throw new Error('Tipo de movimiento inválido.');
  if (quantity <= 0) throw new Error('La cantidad debe ser mayor que cero.');
  if (!comment) throw new Error('El comentario es obligatorio.');

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const current = findById_(SHEETS.PRODUCTS, product.ID);
    const before = toNumber_(current.Stock);
    const after = type === 'ENTRADA' ? before + quantity : before - quantity;
    if (after < 0) throw new Error('La salida excede el stock disponible (' + before + ').');
    updateObjectRow_(SHEETS.PRODUCTS, current._row, {Stock: after, ActualizadoEn: new Date()});
    appendInventoryMovement_({
      product: current,
      type: type,
      quantity: type === 'ENTRADA' ? quantity : -quantity,
      comment: comment,
      user: user,
      before: before,
      after: after,
      invoiceId: ''
    });
    addAudit_(user, type, 'INVENTARIO', current.ID, {quantity: quantity, comment: comment});
    return {
      ok: true,
      products: getProductsForClient_(),
      movements: getMovements_({limit: 100})
    };
  } finally {
    lock.releaseLock();
  }
}

function apiListMovements(token, filters) {
  requireAdmin_(token);
  ensureLatestSchema_();
  filters = filters || {};
  return getMovements_({
    productId: cleanText_(filters.productId, 80),
    from: cleanText_(filters.from, 20),
    to: cleanText_(filters.to, 20),
    type: cleanText_(filters.type, 30).toUpperCase(),
    limit: Math.min(2000, Math.max(1, Math.floor(toNumber_(filters.limit, 1000))))
  });
}

function apiCreateSale(token, payload) {
  const user = verifySession_(token, ['ADMIN', 'CAJERO']);
  ensureLatestSchema_();
  payload = payload || {};
  const items = Array.isArray(payload.items) ? payload.items : [];
  if (!items.length) throw new Error('Agregue al menos un producto a la venta.');

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const config = getConfigMap_();
    const productRows = getRowsAsObjects_(SHEETS.PRODUCTS);
    const activeCategoryIds = {};
    getRowsAsObjects_(SHEETS.CATEGORIES).forEach(function (category) {
      if (category.Estado === 'ACTIVO') activeCategoryIds[String(category.ID)] = true;
    });
    const detail = [];
    let subtotal = 0;
    let estimatedCost = 0;

    items.forEach(function (item) {
      const product = productRows.find(function (row) {
        return String(row.ID) === String(item.productId);
      });
      const quantity = Math.floor(toNumber_(item.quantity));
      if (!product || product.Estado !== 'ACTIVO' || !activeCategoryIds[String(product.CategoriaID)]) {
        throw new Error('Uno de los productos ya no está disponible.');
      }
      if (quantity <= 0) throw new Error('La cantidad de cada producto debe ser mayor que cero.');
      if (toNumber_(product.Stock) < quantity) {
        throw new Error(product.Nombre + ' solo tiene ' + product.Stock + ' unidad(es) disponible(s).');
      }
      const lineSubtotal = roundMoney_(toNumber_(product.Precio) * quantity);
      subtotal = roundMoney_(subtotal + lineSubtotal);
      estimatedCost = roundMoney_(estimatedCost + toNumber_(product.Costo) * quantity);
      detail.push({
        product: product,
        quantity: quantity,
        price: roundMoney_(product.Precio),
        cost: roundMoney_(product.Costo),
        subtotal: lineSubtotal
      });
    });

    let discount = Math.max(0, roundMoney_(payload.discount));
    if (discount > subtotal) discount = subtotal;
    const taxable = roundMoney_(subtotal - discount);
    const taxEnabled = asBoolean_(config.TAX_ENABLED);
    const taxRate = taxEnabled ? Math.max(0, toNumber_(config.TAX_RATE)) : 0;
    const tax = roundMoney_(taxable * taxRate / 100);
    const total = roundMoney_(taxable + tax);
    const paymentMethod = validatePaymentMethod_(payload.paymentMethod, config);
    const received = paymentMethod === 'Efectivo' || paymentMethod === 'Mixto'
      ? roundMoney_(payload.received)
      : total;
    if (received < total && paymentMethod === 'Efectivo') {
      throw new Error('El monto recibido es menor que el total de la venta.');
    }
    const change = paymentMethod === 'Efectivo' ? roundMoney_(received - total) : 0;
    const invoiceId = Utilities.getUuid();
    const invoiceNumber = nextInvoiceNumber_();
    const now = new Date();

    appendObject_(SHEETS.INVOICES, {
      ID: invoiceId,
      Numero: invoiceNumber,
      Fecha: now,
      UsuarioID: user.ID,
      Cajero: user.Nombre,
      MetodoPago: paymentMethod,
      Subtotal: subtotal,
      Descuento: discount,
      Impuesto: tax,
      Total: total,
      MontoRecibido: received,
      Cambio: change,
      Estado: 'PAGADA',
      MotivoAnulacion: '',
      AnuladaPor: '',
      AnuladaEn: ''
    });

    const detailRows = [];
    detail.forEach(function (line) {
      const before = toNumber_(line.product.Stock);
      const after = before - line.quantity;
      updateObjectRow_(SHEETS.PRODUCTS, line.product._row, {Stock: after, ActualizadoEn: now});
      detailRows.push([
        Utilities.getUuid(), invoiceId, line.product.ID, line.product.SKU,
        line.product.Nombre, line.product.Categoria, line.quantity, line.price,
        line.cost, line.subtotal
      ]);
      appendInventoryMovement_({
        product: line.product,
        type: 'VENTA',
        quantity: -line.quantity,
        comment: 'Venta ' + invoiceNumber,
        user: user,
        before: before,
        after: after,
        invoiceId: invoiceId
      });
    });
    appendRows_(SHEETS.DETAILS, detailRows);
    addAudit_(user, 'CREAR', 'FACTURA', invoiceId, {
      number: invoiceNumber,
      total: total,
      estimatedCost: estimatedCost
    });
    SpreadsheetApp.flush();
    return {
      ok: true,
      invoice: getInvoiceForClient_(invoiceId),
      products: getProductsForClient_(),
      dashboard: buildDashboard_(user)
    };
  } finally {
    lock.releaseLock();
  }
}

function apiListInvoices(token, filters) {
  const user = verifySession_(token);
  return getInvoicesForUser_(user, filters || {});
}

function apiGetInvoice(token, invoiceId) {
  verifySession_(token);
  const invoice = findById_(SHEETS.INVOICES, invoiceId);
  if (!invoice) throw new Error('Factura no encontrada.');
  return getInvoiceForClient_(invoiceId);
}

function apiVoidInvoice(token, payload) {
  const user = requireAdmin_(token);
  payload = payload || {};
  const reason = cleanText_(payload.reason, 500);
  if (!reason) throw new Error('Indique el motivo de anulación.');

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const invoice = findById_(SHEETS.INVOICES, payload.invoiceId);
    if (!invoice) throw new Error('Factura no encontrada.');
    if (invoice.Estado === 'ANULADA') throw new Error('La factura ya fue anulada.');
    const details = getRowsAsObjects_(SHEETS.DETAILS).filter(function (row) {
      return String(row.FacturaID) === String(invoice.ID);
    });
    const now = new Date();
    details.forEach(function (line) {
      const product = findById_(SHEETS.PRODUCTS, line.ProductoID);
      if (!product) return;
      const before = toNumber_(product.Stock);
      const quantity = Math.floor(toNumber_(line.Cantidad));
      const after = before + quantity;
      updateObjectRow_(SHEETS.PRODUCTS, product._row, {Stock: after, ActualizadoEn: now});
      appendInventoryMovement_({
        product: product,
        type: 'ANULACION',
        quantity: quantity,
        comment: 'Anulación ' + invoice.Numero + ': ' + reason,
        user: user,
        before: before,
        after: after,
        invoiceId: invoice.ID
      });
    });
    updateObjectRow_(SHEETS.INVOICES, invoice._row, {
      Estado: 'ANULADA',
      MotivoAnulacion: reason,
      AnuladaPor: user.Nombre,
      AnuladaEn: now
    });
    addAudit_(user, 'ANULAR', 'FACTURA', invoice.ID, {reason: reason});
    return {
      ok: true,
      invoice: getInvoiceForClient_(invoice.ID),
      products: getProductsForClient_(),
      invoices: getInvoicesForUser_(user, {})
    };
  } finally {
    lock.releaseLock();
  }
}

function apiListUsers(token) {
  requireAdmin_(token);
  return getUsersForClient_();
}

function apiSaveUser(token, payload) {
  const admin = requireAdmin_(token);
  payload = payload || {};
  const id = cleanText_(payload.id, 80);
  const existing = id ? findById_(SHEETS.USERS, id) : null;
  const name = cleanText_(payload.name, 120);
  const username = cleanText_(payload.username, 80).toLowerCase();
  const email = cleanText_(payload.email, 160).toLowerCase();
  const role = normalizeRole_(payload.role);
  const status = normalizeStatus_(payload.status);
  if (!name || !username || !email) throw new Error('Nombre, usuario y correo son obligatorios.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Ingrese un correo válido.');

  const duplicate = getRowsAsObjects_(SHEETS.USERS).find(function (user) {
    return String(user.ID) !== String(id) &&
      (String(user.Usuario).toLowerCase() === username || String(user.Email).toLowerCase() === email);
  });
  if (duplicate) throw new Error('El usuario o correo ya está registrado.');

  const now = new Date();
  if (existing) {
    const patch = {
      Nombre: name,
      Usuario: username,
      Email: email,
      Rol: role,
      Estado: status,
      ActualizadoEn: now
    };
    if (payload.password) {
      validatePassword_(payload.password);
      const salt = Utilities.getUuid().replace(/-/g, '');
      patch.Salt = salt;
      patch.PasswordHash = hashPassword_(payload.password, salt);
    }
    if (String(existing.ID) === String(admin.ID) && status === 'INACTIVO') {
      throw new Error('No puede desactivar su propio usuario.');
    }
    updateObjectRow_(SHEETS.USERS, existing._row, patch);
    if (status === 'INACTIVO' || payload.password) revokeUserSessions_(existing.ID, token);
    addAudit_(admin, 'ACTUALIZAR', 'USUARIO', existing.ID, {role: role, status: status});
  } else {
    validatePassword_(payload.password);
    const salt = Utilities.getUuid().replace(/-/g, '');
    const userId = Utilities.getUuid();
    appendObject_(SHEETS.USERS, {
      ID: userId,
      Nombre: name,
      Usuario: username,
      Email: email,
      PasswordHash: hashPassword_(payload.password, salt),
      Salt: salt,
      Rol: role,
      Estado: status,
      UltimoAcceso: '',
      CreadoEn: now,
      ActualizadoEn: now
    });
    addAudit_(admin, 'CREAR', 'USUARIO', userId, {role: role});
  }
  return {ok: true, users: getUsersForClient_()};
}

function apiSaveSettings(token, payload) {
  const user = requireAdmin_(token);
  payload = payload || {};
  const allowed = [
    'APP_NAME', 'BUSINESS_NAME', 'CURRENCY', 'INVOICE_PREFIX', 'TAX_ENABLED', 'TAX_RATE',
    'PAYMENT_METHODS', 'ADDRESS', 'TAX_ID', 'PHONE',
    'LOGO_FILE_ID', 'PRIMARY_COLOR', 'RECEIPT_FOOTER'
  ];
  const values = {};
  allowed.forEach(function (key) {
    if (Object.prototype.hasOwnProperty.call(payload, key)) {
      values[key] = cleanText_(payload[key], key === 'RECEIPT_FOOTER' ? 500 : 300);
    }
  });
  if (!values.APP_NAME) throw new Error('El nombre de la app es obligatorio.');
  if (!values.BUSINESS_NAME) throw new Error('El nombre del negocio es obligatorio.');
  if (values.TAX_RATE && (toNumber_(values.TAX_RATE) < 0 || toNumber_(values.TAX_RATE) > 100)) {
    throw new Error('La tasa de impuesto debe estar entre 0 y 100.');
  }
  setConfigValues_(values);
  addAudit_(user, 'ACTUALIZAR', 'CONFIGURACION', '', values);
  return {ok: true, config: getPublicConfig_()};
}

function apiGetReports(token, filters) {
  requireAdmin_(token);
  return buildReports_(filters || {});
}

function getCategoryModels_(includeInactive) {
  const fields = getRowsAsObjects_(SHEETS.CATEGORY_FIELDS);
  return getRowsAsObjects_(SHEETS.CATEGORIES)
    .filter(function (category) { return includeInactive || category.Estado === 'ACTIVO'; })
    .map(function (category) {
      return {
        id: category.ID,
        name: category.Nombre,
        description: category.Descripcion || '',
        status: category.Estado,
        fields: fields.filter(function (field) {
          return String(field.CategoriaID) === String(category.ID) && field.Estado === 'ACTIVO';
        }).sort(function (a, b) {
          return toNumber_(a.Orden) - toNumber_(b.Orden);
        }).map(function (field) {
          return {
            id: field.ID,
            key: field.Clave,
            label: field.Etiqueta,
            type: field.Tipo || 'TEXT',
            required: asBoolean_(field.Obligatorio),
            options: String(field.Opciones || '').split('|').map(function (option) {
              return option.trim();
            }).filter(Boolean),
            order: toNumber_(field.Orden)
          };
        })
      };
    }).sort(function (a, b) { return a.name.localeCompare(b.name, 'es'); });
}

function normalizeCategoryField_(field, index) {
  field = field || {};
  const label = cleanText_(field.label, 80);
  const allowedTypes = ['TEXT', 'TEXTAREA', 'NUMBER', 'SELECT', 'DATE'];
  const type = allowedTypes.indexOf(String(field.type || '').toUpperCase()) !== -1
    ? String(field.type).toUpperCase() : 'TEXT';
  let options = Array.isArray(field.options) ? field.options.join('|') : String(field.options || '');
  options = options.split(/[|,]/).map(function (option) {
    return cleanText_(option, 80);
  }).filter(Boolean).join('|');
  if (!label) throw new Error('Cada característica debe tener un nombre. Revise la posición ' + (index + 1) + '.');
  if (type === 'SELECT' && !options) {
    throw new Error('La característica "' + label + '" necesita al menos una opción.');
  }
  return {
    id: cleanText_(field.id, 80),
    key: slugifyKey_(cleanText_(field.key, 80) || label),
    label: label,
    type: type,
    required: field.required === true || String(field.required).toUpperCase() === 'TRUE',
    options: options
  };
}

function syncCategoryConfig_() {
  const names = getRowsAsObjects_(SHEETS.CATEGORIES)
    .filter(function (category) { return category.Estado === 'ACTIVO'; })
    .sort(function (a, b) { return String(a.Nombre).localeCompare(String(b.Nombre), 'es'); })
    .map(function (category) { return category.Nombre; });
  setConfigValues_({CATEGORIES: names.join(','), CATEGORY_MODEL_VERSION: '2'});
}

function validateProductAttributes_(category, rawAttributes) {
  let source = rawAttributes || {};
  if (typeof source === 'string') {
    try { source = JSON.parse(source); } catch (error) { source = {}; }
  }
  return category.fields.map(function (field) {
    let value = Object.prototype.hasOwnProperty.call(source, field.id)
      ? source[field.id] : source[field.key];
    value = cleanText_(value, field.type === 'TEXTAREA' ? 2000 : 300);
    if (field.required && !value) {
      throw new Error('La característica "' + field.label + '" es obligatoria.');
    }
    if (value && field.type === 'NUMBER' && !Number.isFinite(Number(value))) {
      throw new Error('La característica "' + field.label + '" debe ser numérica.');
    }
    if (value && field.type === 'SELECT' && field.options.indexOf(value) === -1) {
      throw new Error('El valor indicado para "' + field.label + '" no es válido.');
    }
    return {
      fieldId: field.id,
      key: field.key,
      label: field.label,
      type: field.type,
      value: value
    };
  });
}

function getAttributeValueByKey_(attributes, key) {
  const attribute = attributes.find(function (item) { return item.key === key; });
  return attribute ? attribute.value : '';
}

function saveProductAttributes_(productId, attributes) {
  const existing = getRowsAsObjects_(SHEETS.PRODUCT_ATTRIBUTES).filter(function (row) {
    return String(row.ProductoID) === String(productId);
  });
  const now = new Date();
  attributes.forEach(function (attribute) {
    const row = existing.find(function (item) {
      return String(item.CampoID) === String(attribute.fieldId);
    });
    if (row) {
      updateObjectRow_(SHEETS.PRODUCT_ATTRIBUTES, row._row, {
        Clave: attribute.key,
        Valor: attribute.value,
        ActualizadoEn: now
      });
    } else if (attribute.value !== '') {
      appendObject_(SHEETS.PRODUCT_ATTRIBUTES, {
        ID: Utilities.getUuid(),
        ProductoID: productId,
        CampoID: attribute.fieldId,
        Clave: attribute.key,
        Valor: attribute.value,
        ActualizadoEn: now
      });
    }
  });
}

function getProductsForClient_() {
  const categories = getCategoryModels_(true);
  const categoriesById = {};
  const categoriesByName = {};
  categories.forEach(function (category) {
    categoriesById[String(category.id)] = category;
    categoriesByName[String(category.name).toLowerCase()] = category;
  });
  const valuesByProduct = {};
  getRowsAsObjects_(SHEETS.PRODUCT_ATTRIBUTES).forEach(function (row) {
    if (!valuesByProduct[row.ProductoID]) valuesByProduct[row.ProductoID] = {};
    valuesByProduct[row.ProductoID][row.CampoID] = row.Valor;
  });
  return getRowsAsObjects_(SHEETS.PRODUCTS).map(function (product) {
    let imageUrl = '';
    if (product.ImagenFileId) {
      try {
        imageUrl = getDriveImageDataUrl_(product.ImagenFileId);
      } catch (error) {
        imageUrl = '';
      }
    }
    const category = categoriesById[String(product.CategoriaID || '')] ||
      categoriesByName[String(product.Categoria || '').toLowerCase()] || null;
    const productValues = valuesByProduct[product.ID] || {};
    const attributes = category ? category.fields.map(function (field) {
      return {
        fieldId: field.id,
        key: field.key,
        label: field.label,
        type: field.type,
        value: productValues[field.id] == null ? '' : String(productValues[field.id])
      };
    }) : [];
    return {
      id: product.ID,
      sku: product.SKU || '',
      barcode: product.CodigoBarras || '',
      name: product.Nombre,
      manualName: asBoolean_(product.NombreManual) ? product.Nombre : '',
      category: category ? category.name : product.Categoria,
      categoryId: category ? category.id : (product.CategoriaID || ''),
      attributes: attributes,
      searchText: attributes.map(function (attribute) { return attribute.value; }).filter(Boolean).join(' '),
      price: roundMoney_(product.Precio),
      cost: roundMoney_(product.Costo),
      stock: Math.floor(toNumber_(product.Stock)),
      minimum: Math.floor(toNumber_(product.StockMinimo)),
      imageFileId: product.ImagenFileId || '',
      imageUrl: imageUrl,
      status: product.Estado,
      createdAt: product.CreadoEn,
      updatedAt: product.ActualizadoEn
    };
  }).sort(function (a, b) {
    return String(a.name).localeCompare(String(b.name), 'es');
  });
}

function getUsersForClient_() {
  return getRowsAsObjects_(SHEETS.USERS).map(function (user) {
    return publicUser_(user);
  }).sort(function (a, b) { return a.name.localeCompare(b.name, 'es'); });
}

function getPublicConfig_() {
  const config = getConfigMap_();
  const categoryNames = getRowsAsObjects_(SHEETS.CATEGORIES)
    .filter(function (category) { return category.Estado === 'ACTIVO'; })
    .sort(function (a, b) { return String(a.Nombre).localeCompare(String(b.Nombre), 'es'); })
    .map(function (category) { return category.Nombre; });
  const publicConfig = {
    appName: config.APP_NAME || 'KioskoPOS',
    businessName: config.BUSINESS_NAME || 'KioskoPOS',
    currency: config.CURRENCY || 'RD$',
    invoicePrefix: config.INVOICE_PREFIX || 'KP',
    invoiceNext: toNumber_(config.INVOICE_NEXT, 1),
    taxEnabled: asBoolean_(config.TAX_ENABLED),
    taxRate: toNumber_(config.TAX_RATE),
    paymentMethods: splitList_(config.PAYMENT_METHODS),
    categories: categoryNames.length ? categoryNames : splitList_(config.CATEGORIES),
    address: config.ADDRESS || '',
    taxId: config.TAX_ID || '',
    phone: config.PHONE || '',
    logoFileId: config.LOGO_FILE_ID || '',
    logoDataUrl: safeLogoDataUrl_(),
    webSignatureEnabled: asBoolean_(config.WEB_SIGNATURE_ENABLED == null ? 'TRUE' : config.WEB_SIGNATURE_ENABLED),
    webSignatureFileId: config.WEB_SIGNATURE_FILE_ID || '',
    webSignatureDataUrl: safeImageDataUrlFromConfig_('WEB_SIGNATURE_FILE_ID', 'firma web'),
    webSignatureWidth: Math.min(420, Math.max(60, Math.floor(toNumber_(config.WEB_SIGNATURE_WIDTH, 140)) || 140)),
    primaryColor: config.PRIMARY_COLOR || '#0b2f78',
    receiptFooter: config.RECEIPT_FOOTER || '¡Gracias por su compra!'
  };
  publicConfig.faviconDataUrl = buildFaviconDataUrl_(publicConfig);
  return publicConfig;
}

function splitList_(value) {
  return String(value || '').split(',').map(function (item) { return item.trim(); }).filter(Boolean);
}

function validatePaymentMethod_(method, config) {
  const methods = splitList_(config.PAYMENT_METHODS);
  const selected = cleanText_(method, 60);
  if (methods.indexOf(selected) === -1) throw new Error('Método de pago no permitido.');
  return selected;
}

function nextInvoiceNumber_() {
  const config = getConfigMap_();
  const next = Math.max(1, Math.floor(toNumber_(config.INVOICE_NEXT, 1)));
  const prefix = cleanText_(config.INVOICE_PREFIX || 'KP', 12).toUpperCase();
  setConfigValues_({INVOICE_NEXT: String(next + 1)});
  return prefix + '-' + String(next).padStart(6, '0');
}

function appendInventoryMovement_(data) {
  appendObject_(SHEETS.MOVEMENTS, {
    ID: Utilities.getUuid(),
    Fecha: new Date(),
    ProductoID: data.product.ID,
    SKU: data.product.SKU,
    Producto: data.product.Nombre,
    Tipo: data.type,
    Cantidad: data.quantity,
    Comentario: data.comment,
    UsuarioID: data.user.ID,
    Usuario: data.user.Nombre,
    StockAntes: data.before,
    StockDespues: data.after,
    FacturaID: data.invoiceId || ''
  });
}

function getMovements_(filters) {
  filters = filters || {};
  let rows = getRowsAsObjects_(SHEETS.MOVEMENTS);
  if (filters.productId) {
    rows = rows.filter(function (row) { return String(row.ProductoID) === String(filters.productId); });
  }
  if (filters.type) {
    rows = rows.filter(function (row) { return String(row.Tipo).toUpperCase() === String(filters.type).toUpperCase(); });
  }
  if (filters.from) {
    const from = new Date(filters.from + 'T00:00:00');
    rows = rows.filter(function (row) { return new Date(row.Fecha) >= from; });
  }
  if (filters.to) {
    const to = new Date(filters.to + 'T23:59:59');
    rows = rows.filter(function (row) { return new Date(row.Fecha) <= to; });
  }
  rows.sort(function (a, b) { return new Date(b.Fecha) - new Date(a.Fecha); });
  return rows.slice(0, filters.limit || 200).map(function (row) {
    return {
      id: row.ID,
      date: row.Fecha,
      productId: row.ProductoID,
      sku: row.SKU,
      product: row.Producto,
      type: row.Tipo,
      quantity: toNumber_(row.Cantidad),
      comment: row.Comentario,
      user: row.Usuario,
      stockBefore: toNumber_(row.StockAntes),
      stockAfter: toNumber_(row.StockDespues),
      invoiceId: row.FacturaID || ''
    };
  });
}

function getInvoicesForUser_(user, filters) {
  filters = filters || {};
  let invoices = getRowsAsObjects_(SHEETS.INVOICES);
  if (filters.cashierId && user.Rol === 'ADMIN') {
    invoices = invoices.filter(function (invoice) {
      return String(invoice.UsuarioID) === String(filters.cashierId);
    });
  }
  if (filters.paymentMethod) {
    invoices = invoices.filter(function (invoice) {
      return invoice.MetodoPago === filters.paymentMethod;
    });
  }
  if (filters.status) {
    invoices = invoices.filter(function (invoice) { return invoice.Estado === filters.status; });
  }
  if (filters.from) {
    const from = new Date(filters.from + 'T00:00:00');
    invoices = invoices.filter(function (invoice) { return new Date(invoice.Fecha) >= from; });
  }
  if (filters.to) {
    const to = new Date(filters.to + 'T23:59:59');
    invoices = invoices.filter(function (invoice) { return new Date(invoice.Fecha) <= to; });
  }
  invoices.sort(function (a, b) { return new Date(b.Fecha) - new Date(a.Fecha); });
  return invoices.map(invoiceSummary_);
}

function invoiceSummary_(invoice) {
  return {
    id: invoice.ID,
    number: invoice.Numero,
    date: invoice.Fecha,
    userId: invoice.UsuarioID,
    cashier: invoice.Cajero,
    paymentMethod: invoice.MetodoPago,
    subtotal: roundMoney_(invoice.Subtotal),
    discount: roundMoney_(invoice.Descuento),
    tax: roundMoney_(invoice.Impuesto),
    total: roundMoney_(invoice.Total),
    received: roundMoney_(invoice.MontoRecibido),
    change: roundMoney_(invoice.Cambio),
    status: invoice.Estado,
    voidReason: invoice.MotivoAnulacion || '',
    voidedBy: invoice.AnuladaPor || '',
    voidedAt: invoice.AnuladaEn || ''
  };
}

function getInvoiceForClient_(invoiceId) {
  const invoice = findById_(SHEETS.INVOICES, invoiceId);
  if (!invoice) throw new Error('Factura no encontrada.');
  const result = invoiceSummary_(invoice);
  result.items = getRowsAsObjects_(SHEETS.DETAILS)
    .filter(function (line) { return String(line.FacturaID) === String(invoiceId); })
    .map(function (line) {
      return {
        id: line.ID,
        productId: line.ProductoID,
        sku: line.SKU,
        name: line.Producto,
        category: line.Categoria,
        quantity: toNumber_(line.Cantidad),
        price: roundMoney_(line.PrecioUnitario),
        cost: roundMoney_(line.CostoUnitario),
        subtotal: roundMoney_(line.Subtotal)
      };
    });
  result.business = getPublicConfig_();
  return result;
}

function buildDashboard_(user) {
  const now = new Date();
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startWeek = new Date(startToday);
  startWeek.setDate(startToday.getDate() - ((startToday.getDay() + 6) % 7));
  let invoices = getRowsAsObjects_(SHEETS.INVOICES);
  if (user.Rol !== 'ADMIN') {
    invoices = invoices.filter(function (invoice) {
      return String(invoice.UsuarioID) === String(user.ID);
    });
  }
  const paid = invoices.filter(function (invoice) { return invoice.Estado === 'PAGADA'; });
  const today = paid.filter(function (invoice) { return new Date(invoice.Fecha) >= startToday; });
  const week = paid.filter(function (invoice) { return new Date(invoice.Fecha) >= startWeek; });
  const products = getProductsForClient_();
  const paidInvoiceIds = new Set(paid.map(function (invoice) { return invoice.ID; }));
  const details = getRowsAsObjects_(SHEETS.DETAILS).filter(function (line) {
    return paidInvoiceIds.has(line.FacturaID);
  });
  const productTotals = {};
  details.forEach(function (line) {
    productTotals[line.Producto] = (productTotals[line.Producto] || 0) + toNumber_(line.Cantidad);
  });
  const topProduct = Object.keys(productTotals).sort(function (a, b) {
    return productTotals[b] - productTotals[a];
  })[0] || 'Sin ventas';

  const cashierTotals = {};
  paid.forEach(function (invoice) {
    cashierTotals[invoice.Cajero] = (cashierTotals[invoice.Cajero] || 0) + toNumber_(invoice.Total);
  });
  const topCashier = Object.keys(cashierTotals).sort(function (a, b) {
    return cashierTotals[b] - cashierTotals[a];
  })[0] || 'Sin ventas';

  const daily = [];
  for (let offset = 6; offset >= 0; offset--) {
    const day = new Date(startToday);
    day.setDate(day.getDate() - offset);
    const next = new Date(day);
    next.setDate(next.getDate() + 1);
    daily.push({
      date: day.toISOString(),
      label: Utilities.formatDate(day, APP_TIMEZONE, 'EEE'),
      total: roundMoney_(paid.filter(function (invoice) {
        const date = new Date(invoice.Fecha);
        return date >= day && date < next;
      }).reduce(function (sum, invoice) { return sum + toNumber_(invoice.Total); }, 0))
    });
  }

  return {
    salesToday: sumField_(today, 'Total'),
    invoiceCountToday: today.length,
    lowStockCount: products.filter(function (product) {
      return product.status === 'ACTIVO' && product.stock <= product.minimum;
    }).length,
    topProduct: topProduct,
    topProductUnits: productTotals[topProduct] || 0,
    weekTotal: sumField_(week, 'Total'),
    topCashier: topCashier,
    dailySales: daily,
    latestInvoices: invoices.sort(function (a, b) {
      return new Date(b.Fecha) - new Date(a.Fecha);
    }).slice(0, 6).map(invoiceSummary_),
    lowStock: products.filter(function (product) {
      return product.status === 'ACTIVO' && product.stock <= product.minimum;
    }).sort(function (a, b) { return a.stock - b.stock; }).slice(0, 6)
  };
}

function sumField_(rows, field) {
  return roundMoney_(rows.reduce(function (sum, row) { return sum + toNumber_(row[field]); }, 0));
}

function buildReports_(filters) {
  const range = getDateRange_(filters);
  const invoices = getRowsAsObjects_(SHEETS.INVOICES).filter(function (invoice) {
    const date = new Date(invoice.Fecha);
    return invoice.Estado === 'PAGADA' && date >= range.from && date <= range.to;
  });
  const invoiceIds = new Set(invoices.map(function (invoice) { return invoice.ID; }));
  const details = getRowsAsObjects_(SHEETS.DETAILS).filter(function (line) {
    return invoiceIds.has(line.FacturaID);
  });
  const products = {};
  const categories = {};
  const cashiers = {};
  let cost = 0;
  details.forEach(function (line) {
    const amount = toNumber_(line.Subtotal);
    const quantity = toNumber_(line.Cantidad);
    cost += toNumber_(line.CostoUnitario) * quantity;
    if (!products[line.Producto]) products[line.Producto] = {name: line.Producto, units: 0, total: 0};
    products[line.Producto].units += quantity;
    products[line.Producto].total += amount;
    categories[line.Categoria] = (categories[line.Categoria] || 0) + amount;
  });
  invoices.forEach(function (invoice) {
    cashiers[invoice.Cajero] = (cashiers[invoice.Cajero] || 0) + toNumber_(invoice.Total);
  });

  const dailyMap = {};
  invoices.forEach(function (invoice) {
    const key = Utilities.formatDate(new Date(invoice.Fecha), APP_TIMEZONE, 'yyyy-MM-dd');
    dailyMap[key] = (dailyMap[key] || 0) + toNumber_(invoice.Total);
  });
  const dailySales = [];
  const cursor = new Date(range.from);
  while (cursor <= range.to && dailySales.length < 62) {
    const key = Utilities.formatDate(cursor, APP_TIMEZONE, 'yyyy-MM-dd');
    dailySales.push({
      date: key,
      label: Utilities.formatDate(cursor, APP_TIMEZONE, 'dd/MM'),
      total: roundMoney_(dailyMap[key] || 0)
    });
    cursor.setDate(cursor.getDate() + 1);
  }

  const totalSales = sumField_(invoices, 'Total');
  return {
    from: range.from.toISOString(),
    to: range.to.toISOString(),
    totalSales: totalSales,
    invoiceCount: invoices.length,
    averageTicket: invoices.length ? roundMoney_(totalSales / invoices.length) : 0,
    estimatedProfit: roundMoney_(totalSales - cost),
    dailySales: dailySales,
    byCategory: mapToSeries_(categories),
    byCashier: mapToSeries_(cashiers),
    topProducts: Object.keys(products).map(function (key) {
      products[key].total = roundMoney_(products[key].total);
      return products[key];
    }).sort(function (a, b) { return b.units - a.units; }).slice(0, 10),
    lowStock: getProductsForClient_().filter(function (product) {
      return product.status === 'ACTIVO' && product.stock <= product.minimum;
    }),
    recentMovements: getMovements_({limit: 30})
  };
}

function mapToSeries_(map) {
  return Object.keys(map).map(function (key) {
    return {label: key, value: roundMoney_(map[key])};
  }).sort(function (a, b) { return b.value - a.value; });
}

function getDateRange_(filters) {
  const now = new Date();
  let from;
  let to = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
  if (filters.from && filters.to) {
    from = new Date(filters.from + 'T00:00:00');
    to = new Date(filters.to + 'T23:59:59');
  } else if (filters.preset === 'today') {
    from = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  } else if (filters.preset === 'week') {
    from = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    from.setDate(from.getDate() - ((from.getDay() + 6) % 7));
  } else {
    from = new Date(now.getFullYear(), now.getMonth(), 1);
  }
  return {from: from, to: to};
}
