
// Metro transformer shim that patches import.meta for web builds.
// import.meta is ESM-only and crashes when the bundle is served as a classic script.
const upstreamTransformer = require(process.env._METRO_ORIGINAL_TRANSFORMER || 'metro-react-native-babel-transformer');

module.exports = {
  ...upstreamTransformer,
  async transform(config) {
    const result = await upstreamTransformer.transform(config);
    if (config.options && config.options.platform === 'web' && result.output) {
      for (const item of result.output) {
        if (item.data && item.data.code && typeof item.data.code === 'string') {
          // Replace import.meta.env with a compatible shim
          item.data.code = item.data.code
            .replace(/import.meta.env/g, '(typeof process !== 'undefined' ? process.env : {})');
        }
      }
    }
    return result;
  },
};
