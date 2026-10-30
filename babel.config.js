module.exports = function (api) {
  api.cache(true);
  return {
    presets: ["babel-preset-expo"],
    plugins: [
      // zustand uses import.meta.env.MODE (Vite syntax) — not valid in Metro classic scripts.
      ["babel-plugin-transform-import-meta", {}],
    ],
  };
};