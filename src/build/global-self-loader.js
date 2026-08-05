module.exports = source => `var self = typeof globalThis === 'undefined' ? this : globalThis;\n${source}`;
