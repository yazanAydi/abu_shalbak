/**
 * Runs before each test file. Jest leaves a parent NODE_ENV=development in place,
 * which used to skip the print test doubles and talk to a real printer.
 */
process.env.NODE_ENV = "test";
process.env.DISABLE_AUTO_BACKUP = "1";
process.env.DISABLE_EXPIRY_TELEGRAM_ALERT = "1";
process.env.ZKTECO_ENABLED = "0";
for (const key of Object.keys(process.env)) {
  if (key.startsWith("TELEGRAM_")) delete process.env[key];
}

const realFetch = typeof global.fetch === "function" ? global.fetch.bind(global) : null;
if (realFetch) {
  global.fetch = async (url, options) => {
    const target = String(url || "");
    if (/api\.telegram\.org|:17891\b|:17892\b/i.test(target)) {
      const err = new Error("external integration blocked during automated tests");
      err.code = "TEST_ISOLATION";
      throw err;
    }
    return realFetch(url, options);
  };
}
