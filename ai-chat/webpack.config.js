const path = require('path');

module.exports = {
  entry: './src/index.jsx',
  output: {
    filename: 'ai-chat-bundle.js',
    path: path.resolve(__dirname, '../chrome/content/zotero/ai-chat'),
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
      },
      {
        test: /\.(woff|woff2|eot|ttf|otf)$/i,
        type: 'asset/resource',
        generator: {
          filename: 'fonts/[name][ext]'
        }
      }
    ]
  },
  resolve: {
    extensions: ['.js', '.jsx']
  },
  // 不打包这些，从父窗口获取
  externals: {
    // 如果需要访问 Zotero API，通过 window.parent.Zotero
  },
  devtool: 'source-map'
};
