const path = require('path');

module.exports = {
  entry: './src/index.jsx',
  output: {
    filename: 'code-pane-bundle.js',
    path: path.resolve(__dirname, '../chrome/content/zotero/code-pane'),
    clean: true
  },
  module: {
    rules: [
      {
        test: /\.jsx?$/,
        exclude: /node_modules/,
        use: {
          loader: 'babel-loader',
          options: {
            presets: ['@babel/preset-react']
          }
        }
      },
      {
        test: /\.css$/,
        use: ['style-loader', 'css-loader']
      },
      {
        test: /\.svg$/,
        type: 'asset/inline'
      },
      {
        test: /\.(png|jpe?g|gif)$/i,
        type: 'asset/inline'
      }
    ]
  },
  resolve: {
    extensions: ['.js', '.jsx']
  },
  devtool: 'source-map'
};
