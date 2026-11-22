// validate(schema, 'body'|'query'|'params'): replaces req[where] with the parsed, trusted value.
module.exports = (schema, where = 'body') => (req, _res, next) => {
  const r = schema.safeParse(req[where]);
  if (!r.success) return next(r.error);
  req[where] = r.data; next();
};
