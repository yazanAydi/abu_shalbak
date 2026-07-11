/** Suppress @zxing/browser source-map warnings (published package omits .ts sources). */
function patchSourceMapLoaderExclude(webpackConfig) {
  const rules = webpackConfig.module?.rules ?? [];

  for (const rule of rules) {
    patchRule(rule);
    if (Array.isArray(rule.oneOf)) {
      for (const oneOfRule of rule.oneOf) patchRule(oneOfRule);
    }
  }

  webpackConfig.ignoreWarnings = [
    ...(webpackConfig.ignoreWarnings ?? []),
    (warning) => {
      const msg = warning?.message ?? warning?.details ?? "";
      return (
        typeof msg === "string" &&
        msg.includes("Failed to parse source map") &&
        msg.includes("@zxing")
      );
    },
  ];

  return webpackConfig;
}

function patchRule(rule) {
  if (!rule) return;

  const uses = normalizeUses(rule);
  const hasSourceMapLoader = uses.some(
    (u) => typeof u.loader === "string" && u.loader.includes("source-map-loader")
  );
  if (!hasSourceMapLoader && !(typeof rule.loader === "string" && rule.loader.includes("source-map-loader"))) {
    return;
  }

  const prev = rule.exclude;
  const list = prev ? (Array.isArray(prev) ? prev : [prev]) : [];
  rule.exclude = [...list, /@zxing/];
}

function normalizeUses(rule) {
  if (Array.isArray(rule.use)) return rule.use;
  if (rule.use) return [rule.use];
  if (rule.loader) return [{ loader: rule.loader }];
  return [];
}

module.exports = {
  webpack: {
    configure: patchSourceMapLoaderExclude,
  },
};
