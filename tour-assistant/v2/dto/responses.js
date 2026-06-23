function ok(payload) {
  return { ok: true, ...payload };
}

function fail(message, status = 500) {
  const err = new Error(message);
  err.status = status;
  return err;
}

module.exports = { ok, fail };
