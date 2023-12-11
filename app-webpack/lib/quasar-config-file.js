const { join, isAbsolute, basename, dirname } = require('node:path')
const { pathToFileURL } = require('node:url')
const { existsSync, readFileSync } = require('node:fs')
const fse = require('fs-extra')
const { merge } = require('webpack-merge')
const debounce = require('lodash/debounce.js')
const { build: esBuild, context: esContextBuild } = require('esbuild')
const { green, dim } = require('kolorist')

const { log, warn, fatal, tip } = require('./utils/logger.js')
const { appFilesValidations } = require('./utils/app-files-validations.js')
const { getPackageMajorVersion } = require('./utils/get-package-major-version.js')
const { resolveExtension } = require('./utils/resolve-extension.js')
const { ensureElectronArgv } = require('./utils/ensure-argv.js')
const { quasarEsbuildInjectReplacementsDefine, quasarEsbuildInjectReplacementsPlugin } = require('./plugins/esbuild.inject-replacements.js')

const urlRegex = /^http(s)?:\/\//i
const { findClosestOpenPort, localHostList } = require('./utils/net.js')
const { isMinimalTerminal } = require('./utils/is-minimal-terminal.js')
const { readFileEnv } = require('./utils/env.js')

const defaultPortMapping = {
  spa: 9000,
  ssr: 9100, // 9150 for SSR + PWA
  pwa: 9200,
  electron: 9300,
  cordova: 9400,
  capacitor: 9500
}

const quasarComponentRE = /^(Q[A-Z]|q-)/
const quasarConfigBanner = `/* eslint-disable */
/**
 * THIS FILE IS GENERATED AUTOMATICALLY.
 * 1. DO NOT edit this file directly as it won't do anything.
 * 2. EDIT the original quasar.config file INSTEAD.
 * 3. DO NOT git commit this file. It should be ignored.
 *
 * This file is still here because there was an error in
 * the original quasar.config file and this allows you to
 * investigate the Node.js stack error.
 *
 * After you fix the original file, this file will be
 * deleted automatically.
 **/
`

function clone (obj) {
  return JSON.parse(JSON.stringify(obj))
}

function escapeHTMLTagContent (str) {
  return str ? str.replace(/[<>]/g, '') : ''
}
function escapeHTMLAttribute (str) {
  return str ? str.replace(/\"/g, '') : ''
}

function formatPublicPath (publicPath) {
  if (!publicPath) {
    return '/'
  }

  if (!publicPath.endsWith('/')) {
    publicPath = `${ publicPath }/`
  }

  if (urlRegex.test(publicPath) === true) {
    return publicPath
  }

  if (!publicPath.startsWith('/')) {
    publicPath = `/${ publicPath }`
  }

  return publicPath
}

function formatRouterBase (publicPath) {
  if (!publicPath || !publicPath.startsWith('http')) {
    return publicPath
  }

  const match = publicPath.match(/^(https?\:)\/\/(([^:\/?#]*)(?:\:([0-9]+))?)([\/]{0,1}[^?#]*)(\?[^#]*|)(#.*|)$/)
  return formatPublicPath(match[ 5 ] || '')
}

function parseAssetProperty (prefix) {
  return asset => {
    if (typeof asset === 'string') {
      return {
        path: asset[ 0 ] === '~' ? asset.substring(1) : prefix + `/${ asset }`
      }
    }

    return {
      ...asset,
      path: typeof asset.path === 'string'
        ? (asset.path[ 0 ] === '~' ? asset.path.substring(1) : prefix + `/${ asset.path }`)
        : asset.path
    }
  }
}

function getUniqueArray (original) {
  return Array.from(new Set(original))
}

function uniquePathFilter (value, index, self) {
  return self.map(obj => obj.path).indexOf(value.path) === index
}

function uniqueRegexFilter (value, index, self) {
  return self.map(regex => regex.toString()).indexOf(value.toString()) === index
}

let cachedExternalHost, addressRunning = false

async function onAddress ({ host, port }, mode) {
  if (
    [ 'cordova', 'capacitor' ].includes(mode)
    && (!host || localHostList.includes(host.toLowerCase()))
  ) {
    if (cachedExternalHost) {
      host = cachedExternalHost
    }
    else {
      const { getExternalIP } = require('./utils/get-external-ip.js')
      host = await getExternalIP()
      cachedExternalHost = host
    }
  }

  try {
    const openPort = await findClosestOpenPort(port, host)
    if (port !== openPort) {
      warn()
      warn(`️️Setting port to closest one available: ${ openPort }`)
      warn()

      port = openPort
    }
  }
  catch (e) {
    warn()

    if (e.message === 'ERROR_NETWORK_PORT_NOT_AVAIL') {
      warn('Could not find an open port. Please configure a lower one to start searching with.')
    }
    else if (e.message === 'ERROR_NETWORK_ADDRESS_NOT_AVAIL') {
      warn('Invalid host specified. No network address matches. Please specify another one.')
    }
    else {
      warn('Unknown network error occurred')
      console.error(e)
    }

    warn()

    if (addressRunning === false) {
      process.exit(1)
    }

    return null
  }

  addressRunning = true
  return { host, port }
}

module.exports.QuasarConfigFile = class QuasarConfigFile {
  #ctx
  #opts
  #versions = {}
  #address
  #isWatching = false

  #tempFile

  #cssVariables
  #storeProvider
  #transformAssetUrls
  #vueDevtools
  #electronInspectPort

  constructor ({ ctx, host, port, verifyAddress, watch }) {
    this.#ctx = ctx
    this.#opts = { host, port, verifyAddress }

    if (watch !== void 0) {
      this.#opts.watch = debounce(watch, 550)
    }

    const { appPaths } = ctx

    const quasarConfigFileExtension = appPaths.quasarConfigOutputFormat === 'esm' ? 'mjs' : appPaths.quasarConfigOutputFormat

    // if filename syntax gets changed, then also update the "clean" cmd
    this.#tempFile = `${ appPaths.quasarConfigFilename }.temporary.compiled.${ Date.now() }.${ quasarConfigFileExtension }`

    log(`Using ${ basename(appPaths.quasarConfigFilename) } in "${ appPaths.quasarConfigInputFormat }" format`)
  }

  async init () {
    const { appPaths, cacheProxy, appExt } = this.#ctx

    this.#cssVariables = cacheProxy.getModule('cssVariables')
    this.#storeProvider = cacheProxy.getModule('storeProvider')

    const { transformAssetUrls } = cacheProxy.getModule('quasarMeta')
    this.#transformAssetUrls = transformAssetUrls

    await appExt.registerAppExtensions()

    if (this.#ctx.mode.pwa) {
      // Enable this when workbox bumps version (as of writing these lines, we're handling v6 & v7)
      // this.#versions.workbox = getPackageMajorVersion('workbox-webpack-plugin', appPaths.appDir)
    }
    else if (this.#ctx.mode.capacitor) {
      const { capVersion } = cacheProxy.getModule('capCli')

      const getCapPluginVersion = capVersion <= 2
        ? () => true
        : name => {
          const version = getPackageMajorVersion(name, appPaths.capacitorDir)
          return version === void 0
            ? false
            : version || true
        }

      Object.assign(this.#versions, {
        capacitor: capVersion,
        capacitorPluginApp: getCapPluginVersion('@capacitor/app'),
        capacitorPluginSplashscreen: getCapPluginVersion('@capacitor/splash-screen')
      })
    }
  }

  read () {
    const esbuildConfig = this.#createEsbuildConfig()
    return this.#opts.watch !== void 0
      ? this.#buildAndWatch(esbuildConfig)
      : this.#build(esbuildConfig)
  }

  // start watching for changes
  watch () {
    this.#isWatching = true
  }

  #createEsbuildConfig () {
    const { appPaths } = this.#ctx

    return {
      platform: 'node',
      format: appPaths.quasarConfigOutputFormat,
      bundle: true,
      packages: 'external',
      alias: {
        'quasar/wrappers': appPaths.quasarConfigOutputFormat === 'esm' ? 'quasar/wrappers/index.mjs' : 'quasar/wrappers/index.js'
      },
      banner: {
        js: quasarConfigBanner
      },
      define: quasarEsbuildInjectReplacementsDefine,
      resolveExtensions: [ appPaths.quasarConfigOutputFormat === 'esm' ? '.mjs' : '.cjs', '.js', '.mts', '.ts', '.json' ],
      entryPoints: [ appPaths.quasarConfigFilename ],
      outfile: this.#tempFile,
      plugins: [ quasarEsbuildInjectReplacementsPlugin ]
    }
  }

  async #build (esbuildConfig) {
    try {
      await esBuild(esbuildConfig)
    }
    catch (e) {
      fse.removeSync(this.#tempFile)
      console.log()
      console.error(e)
      fatal('Could not compile the quasar.config file because it has errors.', 'FAIL')
    }

    let quasarConfigFn
    try {
      const fnResult = await import(
        pathToFileURL(this.#tempFile)
      )

      quasarConfigFn = fnResult.default || fnResult
    }
    catch (e) {
      console.log()
      console.error(e)
      fatal(
        'The quasar.config file has runtime errors. Please check the Node.js stack above against the'
        + ` temporarily created ${ basename(this.#tempFile) } file, fix the original file`
        + ' then DELETE the temporary one ("quasar clean --qconf" can be used).',
        'FAIL'
      )
    }

    return this.#computeConfig(quasarConfigFn, true)
  }

  async #buildAndWatch (esbuildConfig) {
    let firstBuildIsDone

    const { appPaths } = this.#ctx
    const { updateAppPackageJson } = this.#ctx.pkg
    const tempFile = this.#tempFile

    esbuildConfig.plugins.push({
      name: 'quasar:watcher',
      setup: build => {
        let isFirst = true

        build.onStart(() => {
          if (isFirst === false) {
            log()
            log('The quasar.config file (or its dependencies) changed. Reading it again...')
            updateAppPackageJson()
          }
        })

        build.onEnd(async result => {
          if (isFirst === false && this.#isWatching === false) {
            // not ready yet; watch() has not been issued yet
            return
          }

          if (result.errors.length !== 0) {
            fse.removeSync(tempFile)

            const msg = 'Could not compile the quasar.config file because it has errors.'

            if (isFirst === true) {
              fatal(msg, 'FAIL')
            }

            warn(msg + ' Please fix them.\n')
            return
          }

          let quasarConfigFn

          // ensure we grab the latest version
          if (appPaths.quasarConfigOutputFormat === 'cjs') {
            delete require.cache[ tempFile ]
          }

          try {
            const result = appPaths.quasarConfigOutputFormat === 'esm'
              ? await import(pathToFileURL(tempFile) + '?t=' + Date.now()) // we also need to cache bust it, hence the ?t= param
              : require(tempFile)

            quasarConfigFn = result.default || result
          }
          catch (e) {
            // free up memory immediately
            if (appPaths.quasarConfigOutputFormat === 'cjs') {
              delete require.cache[ tempFile ]
            }

            console.log()
            console.error(e)

            const msg = 'Importing quasar.config file results in error. Please check the'
              + ` Node.js stack above against the temporarily created ${ basename(tempFile) } file`
              + ' and fix the original file then DELETE the temporary one ("quasar clean --qconf" can be used).'

            if (isFirst === true) {
              fatal(msg, 'FAIL')
            }

            warn(msg + '\n')
            return
          }

          // free up memory immediately
          if (appPaths.quasarConfigOutputFormat === 'cjs') {
            delete require.cache[ tempFile ]
          }

          const quasarConf = await this.#computeConfig(quasarConfigFn, isFirst)

          if (quasarConf === void 0) {
            return
          }

          if (isFirst === true) {
            isFirst = false
            firstBuildIsDone(quasarConf)
            return
          }

          log('Scheduled to apply quasar.config changes in 550ms')
          this.#opts.watch(quasarConf)
        })
      }
    })

    const esbuildCtx = await esContextBuild(esbuildConfig)
    await esbuildCtx.watch()

    return new Promise(res => { // eslint-disable-line promise/param-names
      firstBuildIsDone = res
    })
  }

  // return void 0 if it encounters errors
  // and quasarConf otherwise
  async #computeConfig (quasarConfigFn, failOnError) {
    if (typeof quasarConfigFn !== 'function') {
      fse.removeSync(this.#tempFile)

      const msg = 'The default export value of the quasar.config file is not a function.'

      if (failOnError === true) {
        fatal(msg, 'FAIL')
      }

      warn(msg + ' Please fix it.\n')
      return
    }

    let userCfg

    try {
      userCfg = await quasarConfigFn(this.#ctx)
    }
    catch (e) {
      console.log()
      console.error(e)

      const msg = 'The quasar.config file has runtime errors.'
        + ' Please check the Node.js stack above against the'
        + ` temporarily created ${ basename(this.#tempFile) } file`
        + ' then DELETE it ("quasar clean --qconf" can be used).'

      if (failOnError === true) {
        fatal(msg, 'FAIL')
      }

      warn(msg + ' Please fix the errors in the original file.\n')
      return
    }

    if (Object(userCfg) !== userCfg) {
      fse.removeSync(this.#tempFile)

      const msg = 'The quasar.config file does not default exports an Object.'

      if (failOnError === true) {
        fatal(msg, 'FAIL')
      }

      warn(msg + ' Please fix it.\n')
      return
    }

    fse.removeSync(this.#tempFile)

    const { appPaths } = this.#ctx

    const rawQuasarConf = merge({
      ctx: this.#ctx,

      boot: [],
      css: [],
      extras: [],
      animations: [],

      framework: {
        components: [],
        directives: [],
        plugins: [],
        config: {}
      },

      vendor: {
        add: [],
        remove: []
      },

      eslint: {
        include: [],
        exclude: [],
        rawWebpackEslintPluginOptions: {},
        rawEsbuildEslintOptions: {}
      },

      sourceFiles: {},
      bin: {},
      htmlVariables: {},

      devServer: {
        server: {}
      },

      build: {
        esbuildTarget: {},
        vueLoaderOptions: {
          transformAssetUrls: {}
        },
        sassLoaderOptions: {},
        scssLoaderOptions: {},
        stylusLoaderOptions: {},
        lessLoaderOptions: {},
        tsLoaderOptions: {},
        env: {},
        rawDefine: {},
        envFiles: [],
        webpackTranspileDependencies: [],
        uglifyOptions: {
          compress: {},
          mangle: {}
        },
        htmlMinifyOptions: {}
      },

      ssr: {
        middlewares: []
      },
      pwa: {},
      electron: {
        preloadScripts: [],
        unPackagedInstallParams: [],
        packager: {},
        builder: {}
      },
      cordova: {},
      capacitor: {
        capacitorCliPreparationParams: []
      },
      bex: {
        contentScripts: []
      }
    }, userCfg)

    const metaConf = {
      debugging: this.#ctx.dev === true || this.#ctx.debug === true,
      needsAppMountHook: false,
      vueDevtools: false,
      versions: { ...this.#versions }, // used by entry templates
      css: { ...this.#cssVariables }
    }

    if (rawQuasarConf.animations === 'all') {
      rawQuasarConf.animations = this.#ctx.cacheProxy.getModule('animations')
    }

    try {
      await this.#ctx.appExt.runAppExtensionHook('extendQuasarConf', async hook => {
        log(`Extension(${ hook.api.extId }): Extending quasar.config file configuration...`)
        await hook.fn(rawQuasarConf, hook.api)
      })
    }
    catch (e) {
      console.log()
      console.error(e)

      if (failOnError === true) {
        fatal('One of your installed App Extensions failed to run', 'FAIL')
      }

      warn('One of your installed App Extensions failed to run.\n')
      return
    }

    const cfg = {
      ...rawQuasarConf,
      metaConf
    }

    // we need to know if using SSR + PWA immediately
    if (this.#ctx.mode.ssr) {
      cfg.ssr = merge({
        pwa: false,
        pwaOfflineHtmlFilename: 'offline.html',
        manualStoreHydration: false,
        manualPostHydrationTrigger: false,
        prodPort: 3000 // gets superseded in production by an eventual process.env.PORT
      }, cfg.ssr)
    }

    // if DEV and not BEX mode (BEX does not use a regular devserver)
    if (this.#ctx.dev && this.#ctx.mode.bex !== true) {
      if (this.#opts.host) {
        cfg.devServer.host = this.#opts.host
      }
      else if (!cfg.devServer.host) {
        cfg.devServer.host = '0.0.0.0'
      }

      if (this.#opts.port) {
        cfg.devServer.port = this.#opts.port
        tip('You are using the --port parameter. It is recommended to use a different devServer port for each Quasar mode to avoid browser cache issues')
      }
      else if (!cfg.devServer.port) {
        cfg.devServer.port = defaultPortMapping[ this.#ctx.modeName ]
          + (this.#ctx.mode.ssr === true && cfg.ssr.pwa === true ? 50 : 0)
      }
      else {
        tip(
          'You (or an AE) specified an explicit quasar.config file > devServer > port. It is recommended to use'
          + ' a different devServer > port for each Quasar mode to avoid browser cache issues.'
          + ' Example: ctx.mode.ssr ? 9100 : ...'
        )
      }

      if (
        this.#address
        && this.#address.from.host === cfg.devServer.host
        && this.#address.from.port === cfg.devServer.port
      ) {
        cfg.devServer.host = this.#address.to.host
        cfg.devServer.port = this.#address.to.port
      }
      else {
        const addr = {
          host: cfg.devServer.host,
          port: cfg.devServer.port
        }
        const to = this.#opts.verifyAddress === true
          ? await onAddress(addr, this.#ctx.modeName)
          : addr

        // if network error while running
        if (to === null) {
          const msg = 'Network error encountered while following the quasar.config file host/port config.'

          if (failOnError === true) {
            fatal(msg, 'FAIL')
          }

          warn(msg + ' Reconfigure and save the file again.\n')
          return
        }

        cfg.devServer = merge({ open: true }, cfg.devServer, to)
        this.#address = {
          from: addr,
          to: {
            host: cfg.devServer.host,
            port: cfg.devServer.port
          }
        }
      }
    }

    if (cfg.css.length > 0) {
      cfg.css = cfg.css.filter(_ => _)
        .map(parseAssetProperty('src/css'))
        .filter(asset => asset.path)
        .filter(uniquePathFilter)
    }

    if (cfg.boot.length > 0) {
      cfg.boot = cfg.boot.filter(_ => _)
        .map(parseAssetProperty('boot'))
        .filter(asset => asset.path)
        .filter(uniquePathFilter)
    }

    if (cfg.extras.length > 0) {
      cfg.extras = getUniqueArray(cfg.extras)
    }

    if (cfg.animations.length > 0) {
      cfg.animations = getUniqueArray(cfg.animations)
    }

    if (![ 'kebab', 'pascal', 'combined' ].includes(cfg.framework.autoImportComponentCase)) {
      cfg.framework.autoImportComponentCase = 'kebab'
    }

    // special case where a component can be designated for a framework > config prop
    const { config } = cfg.framework

    if (config.loading) {
      const { spinner } = config.loading
      if (quasarComponentRE.test(spinner)) {
        cfg.framework.components.push(spinner)
      }
    }

    if (config.notify) {
      const { spinner } = config.notify
      if (quasarComponentRE.test(spinner)) {
        cfg.framework.components.push(spinner)
      }
    }

    cfg.framework.components = getUniqueArray(cfg.framework.components)
    cfg.framework.directives = getUniqueArray(cfg.framework.directives)
    cfg.framework.plugins = getUniqueArray(cfg.framework.plugins)

    Object.assign(cfg.metaConf, {
      hasLoadingBarPlugin: cfg.framework.plugins.includes('LoadingBar'),
      hasMetaPlugin: cfg.framework.plugins.includes('Meta')
    })

    cfg.eslint = merge({
      warnings: false,
      errors: false,
      fix: false,
      formatter: 'stylish',
      cache: true,
      include: [],
      exclude: [],
      rawWebpackEslintPluginOptions: {},
      rawEsbuildEslintOptions: {}
    }, cfg.eslint)

    cfg.build = merge({
      vueLoaderOptions: {
        transformAssetUrls: clone(this.#transformAssetUrls)
      },
      vueOptionsAPI: true,
      vueRouterMode: 'hash',

      minify: cfg.metaConf.debugging !== true
        && (this.#ctx.mode.bex !== true || cfg.bex.minify === true),

      sourcemap: cfg.metaConf.debugging === true,

      // need to force extraction for SSR due to
      // missing functionality in vue-loader
      extractCSS: this.#ctx.prod || this.#ctx.mode.ssr,
      distDir: join('dist', this.#ctx.modeName),
      webpackTranspile: true,
      htmlFilename: 'index.html',
      webpackShowProgress: true,
      webpackDevtool: this.#ctx.dev
        ? 'eval-cheap-module-source-map'
        : 'source-map',

      uglifyOptions: {
        compress: {
          // turn off flags with small gains to speed up minification
          arrows: false,
          collapse_vars: false, // 0.3kb
          comparisons: false,
          computed_props: false,
          hoist_funs: false,
          hoist_props: false,
          hoist_vars: false,
          inline: false,
          loops: false,
          negate_iife: false,
          properties: false,
          reduce_funcs: false,
          reduce_vars: false,
          switches: false,
          toplevel: false,
          typeofs: false,

          // a few flags with noticeable gains/speed ratio
          // numbers based on out of the box vendor bundle
          booleans: true, // 0.7kb
          if_return: true, // 0.4kb
          sequences: true, // 0.7kb
          unused: true, // 2.3kb

          // required features to drop conditional branches
          conditionals: true,
          dead_code: true,
          evaluate: true
        },
        mangle: {
          safari10: true
        }
      },

      htmlMinifyOptions: {
        removeComments: true,
        collapseWhitespace: true,
        removeAttributeQuotes: true,
        collapseBooleanAttributes: true,
        removeScriptTypeAttributes: true
        // more options:
        // https://github.com/kangax/html-minifier#options-quick-reference
      },

      rawDefine: {
        // quasar
        __QUASAR_VERSION__: JSON.stringify(this.#ctx.pkg.quasarPkg.version),
        __QUASAR_SSR__: this.#ctx.mode.ssr === true,
        __QUASAR_SSR_SERVER__: false,
        __QUASAR_SSR_CLIENT__: false,
        __QUASAR_SSR_PWA__: false,

        // vue
        __VUE_OPTIONS_API__: cfg.build.vueOptionsAPI !== false,
        __VUE_PROD_DEVTOOLS__: cfg.metaConf.debugging,

        // vue-i18n
        __VUE_I18N_FULL_INSTALL__: true,
        __VUE_I18N_LEGACY_API__: true,
        __VUE_I18N_PROD_DEVTOOLS__: cfg.metaConf.debugging,
        __INTLIFY_PROD_DEVTOOLS__: cfg.metaConf.debugging
      },

      alias: {
        src: appPaths.srcDir,
        app: appPaths.appDir,
        components: appPaths.resolve.src('components'),
        layouts: appPaths.resolve.src('layouts'),
        pages: appPaths.resolve.src('pages'),
        assets: appPaths.resolve.src('assets'),
        boot: appPaths.resolve.src('boot'),
        stores: appPaths.resolve.src('stores')
      }
    }, cfg.build)

    if (cfg.vendor.disable !== true) {
      cfg.vendor.add = cfg.vendor.add.length > 0
        ? new RegExp(cfg.vendor.add.filter(v => v).join('|'))
        : void 0

      cfg.vendor.remove = cfg.vendor.remove.length > 0
        ? new RegExp(cfg.vendor.remove.filter(v => v).join('|'))
        : void 0
    }

    if (cfg.build.webpackTranspileDependencies === true) {
      cfg.build.webpackTranspileDependencies = cfg.build.webpackTranspileDependencies.filter(uniqueRegexFilter)
      cfg.metaConf.webpackTranspileBanner = green('yes (Babel)')
    }
    else {
      cfg.metaConf.webpackTranspileBanner = dim('no')
    }

    if (!cfg.build.esbuildTarget.browser) {
      cfg.build.esbuildTarget.browser = [ 'es2019', 'edge88', 'firefox78', 'chrome87', 'safari13.1' ]
    }

    if (!cfg.build.esbuildTarget.node) {
      cfg.build.esbuildTarget.node = 'node16'
    }

    if (this.#ctx.mode.ssr) {
      cfg.build.vueRouterMode = 'history'
    }
    else if (this.#ctx.mode.cordova || this.#ctx.mode.capacitor || this.#ctx.mode.electron || this.#ctx.mode.bex) {
      Object.assign(cfg.build, {
        htmlFilename: 'index.html',
        vueRouterMode: 'hash',
        gzip: false
      })
    }

    if (this.#ctx.dev === true && this.#ctx.mode.bex) {
      // we want to differentiate the folder
      // otherwise we can't run dev and build simultaneously;
      // it's better regardless because it's easier to select the dev folder
      // when loading the browser extension

      const name = basename(cfg.build.distDir)

      cfg.build.distDir = join(
        dirname(cfg.build.distDir),
        name === 'bex' ? 'bex--dev' : `bex-dev--${ name }`
      )
    }

    if (!isAbsolute(cfg.build.distDir)) {
      cfg.build.distDir = appPaths.resolve.app(cfg.build.distDir)
    }

    cfg.build.publicPath
      = cfg.build.publicPath && [ 'spa', 'pwa', 'ssr' ].includes(this.#ctx.modeName)
        ? formatPublicPath(cfg.build.publicPath)
        : ([ 'capacitor', 'cordova', 'electron', 'bex' ].includes(this.#ctx.modeName) ? '' : '/')

    /* careful if you configure the following; make sure that you really know what you are doing */
    cfg.build.vueRouterBase = cfg.build.vueRouterBase !== void 0
      ? cfg.build.vueRouterBase
      : formatRouterBase(cfg.build.publicPath)

    // when adding new props here be sure to update
    // all impacted devserver diffs (look for this.registerDiff() calls)
    cfg.sourceFiles = merge({
      rootComponent: 'src/App.vue',
      router: 'src/router/index',
      store: `src/${ this.#storeProvider.pathKey }/index`,
      indexHtmlTemplate: 'index.html',
      pwaRegisterServiceWorker: 'src-pwa/register-service-worker',
      pwaServiceWorker: 'src-pwa/custom-service-worker',
      pwaManifestFile: 'src-pwa/manifest.json',
      electronMain: 'src-electron/electron-main',
      bexManifestFile: 'src-bex/manifest.json'
    }, cfg.sourceFiles)

    if (appFilesValidations(appPaths, cfg.sourceFiles) === false) {
      if (failOnError === true) {
        fatal('Files validation not passed successfully', 'FAIL')
      }

      warn('Files validation not passed successfully. Please fix the issues.\n')
      return
    }

    // do we have a store?
    const storePath = appPaths.resolve.app(cfg.sourceFiles.store)
    Object.assign(cfg.metaConf, {
      hasStore: resolveExtension(storePath) !== void 0,
      storePackage: this.#storeProvider.name
    })

    // make sure we have preFetch in config
    cfg.preFetch = cfg.preFetch || false

    if (this.#ctx.mode.capacitor & cfg.capacitor.capacitorCliPreparationParams.length === 0) {
      cfg.capacitor.capacitorCliPreparationParams = [ 'sync', this.#ctx.targetName ]
    }

    // (backward compatibility for upstream)
    // webpack-dev-server 4.5.0 introduced a change in behavior
    // along with deprecation notices; so we transform it automatically
    // for a better experience for our developers
    if (typeof cfg.devServer.server === 'string') {
      cfg.devServer.server = {
        type: cfg.devServer.server
      }
    }
    else if (cfg.devServer.https !== void 0) {
      const { https } = cfg.devServer

      delete cfg.devServer.https

      if (https !== false) {
        cfg.devServer.server = {
          type: 'https'
        }

        if (Object(https) === https) {
          cfg.devServer.server.options = https
        }
      }
    }

    if (this.#ctx.dev && cfg.devServer.server.type === 'https') {
      const { options } = cfg.devServer.server

      if (options === void 0) {
        const { getCertificate } = await import('@quasar/ssl-certificate')
        const sslCertificate = getCertificate({ log, fatal })
        cfg.devServer.server.options = {
          key: sslCertificate,
          cert: sslCertificate
        }
      }
      else {
        // we now check if config is specifying a file path
        // and we actually read the contents so we can later supply correct
        // params to the node HTTPS server
        [ 'ca', 'pfx', 'key', 'cert' ].forEach(prop => {
          if (typeof options[ prop ] === 'string') {
            try {
              options[ prop ] = readFileSync(options[ prop ])
            }
            catch (e) {
              console.error(e)
              console.log()
              delete options[ prop ]
              warn(`The devServer.server.options.${ prop } file could not be read. Removed the config.`)
            }
          }
        })
      }
    }

    if (this.#ctx.mode.ssr) {
      if (cfg.ssr.manualPostHydrationTrigger !== true) {
        cfg.metaConf.needsAppMountHook = true
      }

      if (cfg.ssr.middlewares.length > 0) {
        cfg.ssr.middlewares = cfg.ssr.middlewares.filter(_ => _)
          .map(parseAssetProperty('app/src-ssr/middlewares'))
          .filter(asset => asset.path)
          .filter(uniquePathFilter)
      }

      if (cfg.ssr.pwa === true) {
        // install pwa mode if it's missing
        const { addMode } = require('../lib/modes/pwa/pwa-installation.js')
        await addMode({ ctx: this.#ctx, silent: true })
        cfg.build.rawDefine.__QUASAR_SSR_PWA__ = true
      }

      this.#ctx.mode.pwa = cfg.ctx.mode.pwa = cfg.ssr.pwa === true
    }

    if (this.#ctx.dev) {
      const originalSetup = cfg.devServer.setupMiddlewares
      const openInEditor = require('launch-editor-middleware')

      if (this.#ctx.mode.bex === true) {
        cfg.devServer.devMiddleware = cfg.devServer.devMiddleware || {}
        cfg.devServer.devMiddleware.writeToDisk = true
      }

      cfg.devServer = merge({
        hot: true,
        allowedHosts: 'all',
        compress: true,
        open: true,
        client: {
          overlay: {
            warnings: false
          }
        },
        server: {
          type: 'http'
        },
        devMiddleware: {
          publicPath: cfg.build.publicPath,
          stats: false
        }
      },
      this.#ctx.mode.ssr === true
        ? {
            devMiddleware: {
              index: false
            },
            static: {
              serveIndex: false
            }
          }
        : {
            historyApiFallback: cfg.build.vueRouterMode === 'history'
              ? { index: `${ cfg.build.publicPath || '/' }${ cfg.build.htmlFilename }` }
              : false,
            devMiddleware: {
              index: cfg.build.htmlFilename
            }
          },
      cfg.devServer,
      {
        setupMiddlewares: (middlewares, opts) => {
          const { app } = opts

          if (!this.#ctx.mode.ssr) {
            const express = require('express')

            if (cfg.build.ignorePublicFolder !== true) {
              app.use((cfg.build.publicPath || '/'), express.static(appPaths.resolve.app('public'), {
                maxAge: 0
              }))
            }

            if (this.#ctx.mode.cordova) {
              const folder = appPaths.resolve.cordova(`platforms/${ this.#ctx.targetName }/platform_www`)
              app.use('/', express.static(folder, { maxAge: 0 }))
            }
          }

          app.use('/__open-in-editor', openInEditor(void 0, appPaths.appDir))

          return originalSetup
            ? originalSetup(middlewares, opts)
            : middlewares
        }
      })

      if (this.#ctx.vueDevtools === true || cfg.devServer.vueDevtools === true) {
        if (this.#vueDevtools === void 0) {
          const host = localHostList.includes(cfg.devServer.host.toLowerCase())
            ? 'localhost'
            : cfg.devServer.host

          this.#vueDevtools = {
            host,
            port: await findClosestOpenPort(11111, '0.0.0.0')
          }
        }

        cfg.metaConf.vueDevtools = { ...this.#vueDevtools }
      }

      if (this.#ctx.mode.cordova || this.#ctx.mode.capacitor || this.#ctx.mode.electron) {
        if (this.#ctx.mode.electron) {
          cfg.devServer.server.type = 'http'
        }
      }
      else if (cfg.devServer.open) {
        cfg.metaConf.openBrowser = !isMinimalTerminal
          ? cfg.devServer.open
          : false
      }

      delete cfg.devServer.open
    }

    if (cfg.build.gzip) {
      const gzip = cfg.build.gzip === true
        ? {}
        : cfg.build.gzip
      let ext = [ 'js', 'css' ]

      if (gzip.extensions) {
        ext = gzip.extensions
        delete gzip.extensions
      }

      cfg.build.gzip = merge({
        algorithm: 'gzip',
        test: new RegExp('\\.(' + ext.join('|') + ')$'),
        threshold: 10240,
        minRatio: 0.8
      }, gzip)
    }

    if (this.#ctx.mode.pwa) {
      cfg.pwa = merge({
        workboxMode: 'GenerateSW',
        injectPwaMetaTags: true,
        swFilename: 'sw.js', // should be .js (as it's the distribution file, not the input file)
        manifestFilename: 'manifest.json',
        useCredentialsForManifestTag: false
      }, cfg.pwa)

      if (![ 'GenerateSW', 'InjectManifest' ].includes(cfg.pwa.workboxMode)) {
        const msg = `Workbox strategy "${ cfg.pwa.workboxMode }" is invalid. `
          + 'Valid quasar.config file > pwa > workboxMode options are: GenerateSW or InjectManifest.'

        if (failOnError === true) {
          fatal(msg, 'FAIL')
        }

        warn(msg + ' Please fix it.\n')
        return
      }

      cfg.build.env.SERVICE_WORKER_FILE = `${ cfg.build.publicPath }${ cfg.pwa.swFilename }`
      cfg.metaConf.pwaManifestFile = appPaths.resolve.app(cfg.sourceFiles.pwaManifestFile)

      // resolve extension
      const swPath = appPaths.resolve.app(cfg.sourceFiles.pwaServiceWorker)
      cfg.sourceFiles.pwaServiceWorker = resolveExtension(swPath) || cfg.sourceFiles.pwaServiceWorker
    }
    else if (this.#ctx.mode.bex) {
      cfg.metaConf.bexManifestFile = appPaths.resolve.app(cfg.sourceFiles.bexManifestFile)
    }

    if (this.#ctx.dev) {
      const getUrl = hostname => `http${ cfg.devServer.server.type === 'https' ? 's' : '' }://${ hostname }:${ cfg.devServer.port }${ cfg.build.publicPath }`
      const hostname = cfg.devServer.host === '0.0.0.0'
        ? 'localhost'
        : cfg.devServer.host

      cfg.metaConf.APP_URL = getUrl(hostname)
      cfg.metaConf.getUrl = getUrl
    }
    else if (this.#ctx.mode.cordova || this.#ctx.mode.capacitor || this.#ctx.mode.bex) {
      cfg.metaConf.APP_URL = 'index.html'
    }

    Object.assign(cfg.build.env, {
      NODE_ENV: this.#ctx.prod ? 'production' : 'development',
      CLIENT: true,
      SERVER: false,
      DEV: this.#ctx.dev === true,
      PROD: this.#ctx.prod === true,
      DEBUGGING: cfg.metaConf.debugging === true,
      MODE: this.#ctx.modeName,
      VUE_ROUTER_MODE: cfg.build.vueRouterMode,
      VUE_ROUTER_BASE: cfg.build.vueRouterBase
    })

    if (cfg.metaConf.APP_URL) {
      cfg.build.env.APP_URL = cfg.metaConf.APP_URL
    }

    // get the env variables from host project env files
    const { fileEnv, usedEnvFiles, envFromCache } = readFileEnv({
      ctx: this.#ctx,
      quasarConf: cfg
    })

    cfg.metaConf.fileEnv = fileEnv

    if (envFromCache === false && usedEnvFiles.length !== 0) {
      log(`Using .env files: ${ usedEnvFiles.join(', ') }`)
    }

    if (this.#ctx.mode.electron) {
      if (!userCfg.electron?.preloadScripts) {
        cfg.electron.preloadScripts = [ 'electron-preload' ]
      }

      if (this.#ctx.dev) {
        if (this.#electronInspectPort === void 0) {
          this.#electronInspectPort = await findClosestOpenPort(userCfg.electron?.inspectPort || 5858, '127.0.0.1')
          console.log('############ PORT', this.#electronInspectPort, 'from', userCfg.electron?.inspectPort || 5858)
        }

        console.log('inspectPort in cfg', cfg.electron.inspectPort)
        cfg.electron.inspectPort = this.#electronInspectPort
      }
      else {
        const { ensureInstall, getDefaultName } = await this.#ctx.cacheProxy.getModule('electron')

        const icon = appPaths.resolve.electron('icons/icon.png')
        const builderIcon = process.platform === 'linux'
          // backward compatible (linux-512x512.png)
          ? (existsSync(icon) === true ? icon : appPaths.resolve.electron('icons/linux-512x512.png'))
          : appPaths.resolve.electron('icons/icon')

        cfg.electron = merge({
          packager: {
            asar: true,
            icon: appPaths.resolve.electron('icons/icon'),
            overwrite: true
          },
          builder: {
            appId: 'quasar-app',
            icon: builderIcon,
            productName: this.#ctx.pkg.appPkg.productName || this.#ctx.pkg.appPkg.name || 'Quasar App',
            directories: {
              buildResources: appPaths.resolve.electron('')
            }
          }
        }, cfg.electron, {
          packager: {
            dir: join(cfg.build.distDir, 'UnPackaged'),
            out: join(cfg.build.distDir, 'Packaged')
          },
          builder: {
            directories: {
              app: join(cfg.build.distDir, 'UnPackaged'),
              output: join(cfg.build.distDir, 'Packaged')
            }
          }
        })

        if (cfg.ctx.bundlerName) {
          cfg.electron.bundler = cfg.ctx.bundlerName
        }
        else if (!cfg.electron.bundler) {
          cfg.electron.bundler = getDefaultName()
        }

        ensureElectronArgv(cfg.electron.bundler, this.#ctx)

        if (cfg.electron.bundler === 'packager') {
          if (cfg.ctx.targetName) {
            cfg.electron.packager.platform = cfg.ctx.targetName
          }
          if (cfg.ctx.archName) {
            cfg.electron.packager.arch = cfg.ctx.archName
          }
        }
        else {
          cfg.electron.builder = {
            config: cfg.electron.builder
          }

          if (cfg.ctx.targetName === 'mac' || cfg.ctx.targetName === 'darwin' || cfg.ctx.targetName === 'all') {
            cfg.electron.builder.mac = []
          }

          if (cfg.ctx.targetName === 'linux' || cfg.ctx.targetName === 'all') {
            cfg.electron.builder.linux = []
          }

          if (cfg.ctx.targetName === 'win' || cfg.ctx.targetName === 'win32' || cfg.ctx.targetName === 'all') {
            cfg.electron.builder.win = []
          }

          if (cfg.ctx.archName) {
            cfg.electron.builder[ cfg.ctx.archName ] = true
          }

          if (cfg.ctx.publish) {
            cfg.electron.builder.publish = cfg.ctx.publish
          }
        }

        ensureInstall(cfg.electron.bundler)
      }
    }

    cfg.htmlVariables = merge({
      ctx: cfg.ctx,
      process: { env: cfg.build.env },
      productName: escapeHTMLTagContent(this.#ctx.pkg.appPkg.productName),
      productDescription: escapeHTMLAttribute(this.#ctx.pkg.appPkg.description)
    }, cfg.htmlVariables)

    if (this.#ctx.mode.capacitor && cfg.metaConf.versions.capacitorPluginSplashscreen && cfg.capacitor.hideSplashscreen !== false) {
      cfg.metaConf.needsAppMountHook = true
    }

    return cfg
  }
}
