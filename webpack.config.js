const path = require("path");

var libraryEntry = "./src/canvastools/ts/ct.ts"
var libraryFileName = "ct";

var webpackSettings = {
    'prod': {
        minimize: false,
        mode: 'production',
        path: path.resolve(__dirname, './dist'),
        filename: `${libraryFileName}.js`,
        devtool: "source-map",
        tsconfig: "tsconfig.json"
    },
    'prod-min': {
        minimize: true,
        mode: 'production',
        path: path.resolve(__dirname, './dist'),
        filename: `${libraryFileName}.min.js`,
        devtool: "source-map",
        tsconfig: "tsconfig.json"
    },
    'dev': {
        minimize: false,
        mode: 'development',
        path: path.resolve(__dirname, './dist'),
        filename: `${libraryFileName}.dev.js`,
        devtool: "inline-source-map",
        tsconfig: "tsconfig.test.json"
    },
    'test': {
        minimize: false,
        mode: 'development',
        path: path.resolve(__dirname, './samples/shared/js'),
        filename: `${libraryFileName}.js`,
        devtool: "inline-source-map",
        tsconfig: "tsconfig.test.json"
    },
}

module.exports = function (env) {
    const mode = (env && env.mode) || "prod";
    var settings = webpackSettings[mode];
    if (settings == undefined) {
        settings = webpackSettings['prod'];
    }

    var config = {
        entry: libraryEntry,
        output: {
            filename: settings.filename,
            path: settings.path,
            libraryTarget: 'umd',
            globalObject: 'this'
        },
        mode: settings.mode,
        devtool: settings.devtool,
        optimization: {
            minimize: settings.minimize
        },
        devServer: {
            static: {
                directory: path.join(__dirname, 'samples')
            },
            port: 9000,
            compress: true,
        },
        module: {
            rules: [
                {
                    test: /\.tsx?$/,
                    use: [
                        {
                            loader: 'ts-loader',
                            options: {
                                configFile: settings.tsconfig
                            }
                        }
                    ],
                    exclude: /node_modules/                    
                },
                {
                    test: /\.css$/,
                    use: [
                        'style-loader',
                        'css-loader'
                    ]
                }
            ]
        },
        resolve: {
            extensions: ['.ts', '.js']
        }
    };
    return config;
};