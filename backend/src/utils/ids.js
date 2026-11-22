const { z } = require('zod');
const slugify = (s) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'clinic';
const uuid = z.string().uuid();
module.exports = { slugify, uuid, params: (...names) => z.object(Object.fromEntries(names.map((n) => [n, uuid]))) };
