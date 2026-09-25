module.exports = function (bytes) {
  return `module.exports = Uint8Array.from(atob(${JSON.stringify(bytes.toString('base64'))}), c => c.charCodeAt(0));`;
};
module.exports.raw = true;
