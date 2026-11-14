function requireAdmin(req, _res, next) {
  try { req.admin=req.app.locals.adminAuth.require(req);next(); } catch(error){next(error);}
}

module.exports = { requireAdmin };
