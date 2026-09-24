const { createProxyMiddleware } = require("http-proxy-middleware");

module.exports = function (app) {
  app.use(
    "/api",
    createProxyMiddleware({
      target: process.env.OFFICE_API_PROXY || "http://127.0.0.1:5001",
      changeOrigin: true,
    })
  );
};
