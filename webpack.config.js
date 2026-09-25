const path = require('path');
const webpack = require('webpack');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const BundleAnalyzerPlugin = require('webpack-bundle-analyzer').BundleAnalyzerPlugin;
const CopyWebpackPlugin = require('copy-webpack-plugin');
const GenerateServiceWorkerPlugin = require('./src/build/generate-service-worker-plugin');
const EagerDynamicImportPlugin = require('./src/build/eager-dynamic-import-plugin');

const isProduction = process.env.NODE_ENV === 'production';
const isStandalone = !!process.env.STANDALONE;
const base = {
  mode: isProduction ? 'production' : 'development'
};
const dist = path.resolve(__dirname, 'dist');
const nodeCompatibilityAliases = {
  'scratch-vm$': path.resolve(__dirname, '../scratch-vm/src/index.js'),
  'scratch-sb1-converter$': path.resolve(__dirname, '../scratch-vm/node_modules/scratch-sb1-converter/index.js'),
  '@turbowarp/scratch-storage$': path.resolve(__dirname, 'node_modules/@turbowarp/scratch-storage/src/index.js'),
  'text-encoding$': path.resolve(__dirname, 'src/scaffolding/text-encoding/index.js'),
  '@vernier/godirect$': path.resolve(__dirname, '../scratch-vm/node_modules/@vernier/godirect/src/godirect.js')
};
const compiledProjectJavaScriptRules = [{
  test: /\.(?:png|svg|wav)$/,
  include: /scratch-storage[\\/]src[\\/]builtins/,
  loader: path.resolve(__dirname, 'src/build/bytes-loader.js')
}, {
  test: /\.[cm]?js$/,
  include: [path.resolve(__dirname, '../scratch-vm/src'), /node_modules[\\/]@vernier[\\/]godirect[\\/]src/],
  type: 'javascript/auto',
  loader: 'babel-loader',
  options: {babelrc: false, presets: [['@babel/preset-env', {modules: false}]]}
}];
const compiledProjectAudioRule = {
  test: /\.(?:mp3|wav)$/i,
  exclude: /scratch-storage[\\/]src[\\/]builtins/,
  use: [{
    // The compiler only needs extension block definitions, not sample bytes.
    loader: path.resolve(__dirname, 'src', 'build', 'noop-loader.js')
  }]
};

const getVersion = () => {
  if (process.env.VERSION) {
    return process.env.VERSION;
  }
  if (isStandalone) {
    const now = new Date();
    const dateString = `${now.getFullYear()}-${(now.getMonth() + 1).toString().padStart(2, '0')}-${now.getDate().toString().padStart(2, '0')}`;
    const packageJSON = require('./package.json');
    const version = packageJSON.version;
    return `Standalone v${version} (${dateString})`;
  }
  return null;
};
const version = getVersion();

const commonFrontendPlugins = () => [
  new webpack.DefinePlugin({
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV || 'development')
  })
];

const makeWebsite = () => ({
  ...base,
  devtool: isStandalone ? '' : 'source-map',
  output: {
    filename: isProduction ? 'js/[name].[contenthash].js' : 'js/[name].js',
    path: dist
  },
  entry: {
    p4: './src/p4/index.js'
  },
  resolve: {
    alias: {
      svelte: path.resolve('node_modules', 'svelte'),
      ...nodeCompatibilityAliases
    },
    extensions: ['.mjs', '.js', '.svelte'],
    mainFields: ['svelte', 'browser', 'module', 'main']
  },
  optimization: {
    splitChunks: {
      chunks: 'all',
      minChunks: 2
    }
  },
  module: {
    rules: [
      ...compiledProjectJavaScriptRules,
      compiledProjectAudioRule,
      {
        test: /\.png|\.svg$/i,
        exclude: /scratch-storage[\\/]src[\\/]builtins/,
        use: isStandalone ? {
          loader: 'url-loader'
        } : {
          loader: 'file-loader',
          options: {
            name: 'assets/[name].[contenthash].[ext]'
          }
        }
      },
      {
        test: /\.(html|svelte)$/,
        use: 'svelte-loader'
      },
    ]
  },
  plugins: [
    ...commonFrontendPlugins(),
    new CopyWebpackPlugin({
      patterns: [
        {
          from: 'static'
        },
        {from: 'generated/specialized-worker.js'},
        {from: 'generated/rollup.browser.js'},
        {from: 'generated/bindings_wasm_bg.wasm'}
      ]
    }),
    new webpack.DefinePlugin({
      'process.env.ENABLE_SERVICE_WORKER': JSON.stringify(process.env.ENABLE_SERVICE_WORKER),
      'process.env.STANDALONE': JSON.stringify(isStandalone ? true : false),
      'process.env.VERSION': JSON.stringify(version),
    }),
    new HtmlWebpackPlugin({
      filename: 'index.html',
      template: './src/p4/template.ejs',
      chunks: ['p4']
    }),
    new GenerateServiceWorkerPlugin(),
    ...(isStandalone ? [new EagerDynamicImportPlugin()] : []),
    ...(process.env.BUNDLE_ANALYZER === 'p4' ? [new BundleAnalyzerPlugin()] : [])
  ],
  devServer: {
    contentBase: './dist/',
    compress: true,
    overlay: true,
    inline: false,
    host: '0.0.0.0',
    port: 8947
  },
});

const makeNode = () => ({
  ...base,
  devtool: '',
  target: 'node',
  output: {
    filename: '[name].js',
    path: dist,
    library: 'packager',
    libraryTarget: 'umd'
  },
  node: {
    __dirname: false,
  },
  entry: {
    packager: './src/packager/node/export.js'
  },
  resolve: {
    alias: nodeCompatibilityAliases,
    extensions: ['.mjs', '.js']
  },
  externals: {
    '@turbowarp/jszip': '@turbowarp/jszip',
    '@turbowarp/sbdl': '@turbowarp/sbdl',
    '@fiahfy/icns': '@fiahfy/icns',
    'cross-fetch': 'cross-fetch',
    'sha.js': 'sha.js',
    'specialized-link': 'commonjs ./specialized-link.cjs',
  },
  module: {
    rules: [
      ...compiledProjectJavaScriptRules,
      compiledProjectAudioRule,
      {
        test: /\.png|\.svg$/i,
        exclude: /scratch-storage[\\/]src[\\/]builtins/,
        use: 'file-loader'
      }
    ]
  },
  plugins: [
    ...commonFrontendPlugins(),
    new CopyWebpackPlugin({patterns: [{from: 'generated/specialized-link.cjs'}]}),
    ...(process.env.BUNDLE_ANALYZER === 'node' ? [new BundleAnalyzerPlugin()] : [])
  ],
});

module.exports = [

  ...(process.env.BUILD_MODE === 'node' ? [
    makeNode()
  ] : [
    makeWebsite()
  ])
];
