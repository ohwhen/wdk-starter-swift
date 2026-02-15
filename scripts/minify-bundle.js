const fs = require('fs')
const Bundle = require('bare-bundle')
const esbuild = require('esbuild')

async function minifyBundle (inputPath, outputPath) {
  const raw = fs.readFileSync(inputPath)
  const bundle = Bundle.from(raw)
  const newBundle = new Bundle()

  // Track .mjs -> .js renames for resolution/import map updates
  const renamedFiles = new Map()

  let originalSize = 0
  let minifiedSize = 0
  let fileCount = 0
  let jsCount = 0
  let mjsCount = 0
  let pkgJsonCount = 0

  for (const [key, data, mode] of bundle) {
    originalSize += data.byteLength
    fileCount++

    if (key.endsWith('.mjs')) {
      // Convert ESM to CommonJS and rename to .js for JSC compatibility
      const source = data.toString('utf8')
      jsCount++
      mjsCount++

      try {
        const result = await esbuild.transform(source, {
          format: 'cjs',
          minify: true,
          loader: 'js',
          target: 'safari17'
        })

        const newKey = key.replace(/\.mjs$/, '.js')
        const minified = Buffer.from(result.code)
        minifiedSize += minified.byteLength
        newBundle.write(newKey, minified, { mode })
        renamedFiles.set(key, newKey)
      } catch (e) {
        console.warn(`Warning: Failed to convert ${key}: ${e.message}`)
        minifiedSize += data.byteLength
        newBundle.write(key, data, { mode })
      }
    } else if (key.endsWith('.js') || key.endsWith('.cjs')) {
      // Convert ALL JS files to CJS format to eliminate ESM code paths.
      // This is necessary because bare-module treats .js files as ESM
      // when the nearest package.json has "type": "module". By converting
      // everything to CJS syntax, even if bare-module somehow enters
      // the CJS path, the code will work correctly.
      const source = data.toString('utf8')
      jsCount++

      try {
        const result = await esbuild.transform(source, {
          format: 'cjs',
          minify: true,
          loader: 'js',
          target: 'safari17'
        })

        const minified = Buffer.from(result.code)
        minifiedSize += minified.byteLength
        newBundle.write(key, minified, { mode })
      } catch (e) {
        minifiedSize += data.byteLength
        newBundle.write(key, data, { mode })
      }
    } else if (key.endsWith('/package.json') || key === 'package.json') {
      // Strip "type": "module" from package.json files to prevent
      // bare-module from treating .js files as ESM. This is the root
      // cause: bare-module checks the nearest package.json's "type"
      // field, and if it's "module", it calls js_create_module which
      // is unsupported in JSC.
      const source = data.toString('utf8')

      try {
        const pkg = JSON.parse(source)

        if (pkg.type === 'module') {
          pkg.type = 'commonjs'
          pkgJsonCount++
        }

        const updated = Buffer.from(JSON.stringify(pkg))
        minifiedSize += updated.byteLength
        newBundle.write(key, updated, { mode })
      } catch (e) {
        // If JSON parse fails, keep the original
        minifiedSize += data.byteLength
        newBundle.write(key, data, { mode })
      }
    } else {
      minifiedSize += data.byteLength
      newBundle.write(key, data, { mode })
    }
  }

  // Preserve bundle metadata
  if (bundle.id) newBundle.id = bundle.id
  if (bundle.main) newBundle.main = bundle.main
  if (bundle.addons) newBundle.addons = bundle.addons
  if (bundle.assets) newBundle.assets = bundle.assets

  // Update imports/resolutions maps and main with renamed files
  if (renamedFiles.size > 0) {
    newBundle.imports = updateImportsMap(bundle.imports, renamedFiles)
    newBundle.resolutions = updateResolutionsMap(bundle.resolutions, renamedFiles)

    // Update main if it was renamed
    if (bundle.main && renamedFiles.has(bundle.main)) {
      newBundle.main = renamedFiles.get(bundle.main)
    }
  } else {
    newBundle.imports = bundle.imports
    newBundle.resolutions = bundle.resolutions
  }

  const output = newBundle.toBuffer()
  fs.writeFileSync(outputPath, output)

  const reduction = ((1 - minifiedSize / originalSize) * 100).toFixed(1)
  console.log(`Files: ${fileCount} total, ${jsCount} JS files processed`)
  if (mjsCount > 0) console.log(`ESM->CJS: ${mjsCount} .mjs files renamed to .js`)
  if (pkgJsonCount > 0) console.log(`Package.json: ${pkgJsonCount} files changed "type": "module" -> "commonjs"`)
  console.log(`Original: ${(originalSize / 1024 / 1024).toFixed(2)} MB`)
  console.log(`Minified: ${(minifiedSize / 1024 / 1024).toFixed(2)} MB`)
  console.log(`Reduction: ${reduction}%`)
  console.log(`Output: ${outputPath} (${(output.byteLength / 1024 / 1024).toFixed(2)} MB)`)
}

function updateImportsMap (imports, renamedFiles) {
  if (!imports || typeof imports !== 'object') return imports
  const updated = {}
  for (const [key, value] of Object.entries(imports)) {
    updated[key] = updateImportsValue(value, renamedFiles)
  }
  return updated
}

function updateImportsValue (value, renamedFiles) {
  if (typeof value === 'string') {
    return renamedFiles.get(value) || value
  }
  if (typeof value === 'object' && value !== null) {
    return updateImportsMap(value, renamedFiles)
  }
  return value
}

function updateResolutionsMap (resolutions, renamedFiles) {
  if (!resolutions || typeof resolutions !== 'object') return resolutions
  const updated = {}
  for (const [key, value] of Object.entries(resolutions)) {
    const newKey = renamedFiles.get(key) || key
    updated[newKey] = updateImportsMap(value, renamedFiles)
  }
  return updated
}

const input = process.argv[2]
const output = process.argv[3] || input

if (!input) {
  console.error('Usage: node minify-bundle.js <input.bundle> [output.bundle]')
  process.exit(1)
}

minifyBundle(input, output).catch(err => {
  console.error(err)
  process.exit(1)
})
