function apiLogin(credentials) {
  credentials = credentials || {};
  const identifier = cleanText_(credentials.identifier, 160).toLowerCase();
  const password = String(credentials.password || '');
  if (!identifier || !password) throw new Error('Ingrese su usuario y contraseña.');

  const user = getRowsAsObjects_(SHEETS.USERS).find(function (item) {
    return String(item.Usuario).toLowerCase() === identifier ||
      String(item.Email).toLowerCase() === identifier;
  });

  if (!user || user.Estado !== 'ACTIVO' || hashPassword_(password, user.Salt) !== user.PasswordHash) {
    Utilities.sleep(350);
    throw new Error('Usuario o contraseña incorrectos.');
  }

  const rawToken = Utilities.getUuid() + Utilities.getUuid();
  const now = new Date();
  const expires = new Date(
    now.getTime() + (credentials.remember ? REMEMBER_SESSION_DAYS * 24 : SESSION_HOURS) * 60 * 60 * 1000
  );

  appendObject_(SHEETS.SESSIONS, {
    ID: Utilities.getUuid(),
    TokenHash: hashString_(rawToken),
    UsuarioID: user.ID,
    CreadaEn: now,
    ExpiraEn: expires,
    Revocada: false,
    UltimaActividad: now
  });
  updateObjectRow_(SHEETS.USERS, user._row, {UltimoAcceso: now, ActualizadoEn: now});
  addAudit_(user, 'LOGIN', 'SESION', '', {remember: Boolean(credentials.remember)});

  return {
    token: rawToken,
    expiresAt: expires.toISOString(),
    user: publicUser_(user)
  };
}

function apiLogout(token) {
  if (!token) return {ok: true};
  const tokenHash = hashString_(token);
  const session = getRowsAsObjects_(SHEETS.SESSIONS).find(function (item) {
    return item.TokenHash === tokenHash && !asBoolean_(item.Revocada);
  });
  if (session) updateObjectRow_(SHEETS.SESSIONS, session._row, {Revocada: true});
  return {ok: true};
}

function verifySession_(token, roles) {
  if (!token) throw new Error('Su sesión no es válida. Inicie sesión nuevamente.');
  const tokenHash = hashString_(token);
  const session = getRowsAsObjects_(SHEETS.SESSIONS).find(function (item) {
    return item.TokenHash === tokenHash;
  });
  if (!session || asBoolean_(session.Revocada) || new Date(session.ExpiraEn).getTime() <= Date.now()) {
    throw new Error('Su sesión expiró. Inicie sesión nuevamente.');
  }

  const user = findById_(SHEETS.USERS, session.UsuarioID);
  if (!user || user.Estado !== 'ACTIVO') throw new Error('Este usuario no tiene acceso activo.');

  if (roles && roles.length && roles.indexOf(user.Rol) === -1) {
    throw new Error('No tiene permisos para realizar esta acción.');
  }

  const lastActivity = session.UltimaActividad ? new Date(session.UltimaActividad).getTime() : 0;
  if (Date.now() - lastActivity > 5 * 60 * 1000) {
    updateObjectRow_(SHEETS.SESSIONS, session._row, {UltimaActividad: new Date()});
  }
  return user;
}

function asBoolean_(value) {
  return value === true || String(value).toUpperCase() === 'TRUE';
}

function requireAdmin_(token) {
  return verifySession_(token, ['ADMIN']);
}

function apiChangeMyPassword(token, payload) {
  const user = verifySession_(token);
  payload = payload || {};
  if (hashPassword_(String(payload.currentPassword || ''), user.Salt) !== user.PasswordHash) {
    throw new Error('La contraseña actual no es correcta.');
  }
  validatePassword_(payload.newPassword);
  const salt = Utilities.getUuid().replace(/-/g, '');
  updateObjectRow_(SHEETS.USERS, user._row, {
    Salt: salt,
    PasswordHash: hashPassword_(payload.newPassword, salt),
    ActualizadoEn: new Date()
  });
  revokeUserSessions_(user.ID, token);
  addAudit_(user, 'CAMBIAR_CONTRASENA', 'USUARIO', user.ID, {});
  return {ok: true};
}

function validatePassword_(password) {
  const value = String(password || '');
  if (value.length < 8 || !/[A-Za-z]/.test(value) || !/\d/.test(value)) {
    throw new Error('La contraseña debe tener al menos 8 caracteres, letras y números.');
  }
}

function revokeUserSessions_(userId, exceptRawToken) {
  const exceptHash = exceptRawToken ? hashString_(exceptRawToken) : '';
  getRowsAsObjects_(SHEETS.SESSIONS).forEach(function (session) {
    if (String(session.UsuarioID) === String(userId) &&
        session.TokenHash !== exceptHash &&
        !asBoolean_(session.Revocada)) {
      updateObjectRow_(SHEETS.SESSIONS, session._row, {Revocada: true});
    }
  });
}
