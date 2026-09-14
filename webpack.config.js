const path = require('path')

module.exports = {
  target: 'node',
  entry: './src/index.ts',
  mode: 'production',
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: 'index.js',
    libraryTarget: 'commonjs2',
  },
  resolve: {
    extensions: ['.ts', '.js'],
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        use: 'ts-loader',
        exclude: /node_modules/,
      },
    ],
  },
  // NOTE: ghostty-web is deliberately NOT external - it must be bundled,
  // since Tabby does not provide it. Its UMD build inlines the Ghostty WASM
  // module as a base64 data: URI, so dist/index.js is fully self-contained
  // and there is no separate .wasm file to ship.
  externals: [
    '@angular/common',
    '@angular/core',
    '@angular/platform-browser',
    'rxjs',
    'rxjs/operators',
    'tabby-core',
    'tabby-terminal',
    'electron',
    /^electron\/.*$/,
  ],
}
