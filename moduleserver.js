const pth = require("path"), fs = require("fs")
const resolve = require("resolve")
const {parse: parseURL} = require("url")
const crypto = require("crypto")

class Cached {
  constructor(content, headers) {
    this.content = content
    this.headers = headers
  }
}

class ModuleServer {
  constructor(options) {
    this.root = unwin(options.root)
    this.maxParent = options.maxParent == null ? 1 : options.maxParent
    if (this.root.charAt(this.root.length - 1) != "/") this.root += "/"
    // Maps from paths (relative to root dir) to cache entries
    this.cache = Object.create(null)
    this.handleRequest = this.handleRequest.bind(this)
  }

  handleRequest(req, resp) {
    let url = parseURL(req.url)
    let handle = /^\/_m\/(.*)/.exec(url.pathname)
    if (!handle) return false

    let send = (status, text, headers) => {
      let hds = {"access-control-allow-origin": "*",
                 "x-request-url": req.url}
      if (!headers || typeof headers == "string") hds["content-type"] = headers || "text/plain"
      else Object.assign(hds, headers)
      resp.writeHead(status, hds)
      resp.end(text)
    }

    // Modules paths in URLs represent "up one directory" as "__".
    // Convert them to ".." for filesystem path resolution.
    let path = undash(handle[1])
    let cached = this.cache[path]
    if (!cached) {
      if (countParentRefs(path) > this.maxParent) { send(403, "Access denied"); return true }
      let fullPath = unwin(pth.resolve(this.root, path)), code
      try { code = fs.readFileSync(fullPath, "utf8") }
      catch { send(404, "Not found"); return true }
      let {code: resolvedCode, error} = this.resolveImports(fullPath, code)
      if (error) { send(500, error); return true }
      cached = this.cache[path] = new Cached(resolvedCode, {
        "content-type": "application/javascript; charset=utf-8",
        "etag": '"' + hash(resolvedCode) + '"'
      })
      // Drop cache entry when the file changes.
      let watching = fs.watch(fullPath, () => {
        watching.close()
        this.cache[path] = null
      })
    }
    let noneMatch = req.headers["if-none-match"]
    if (noneMatch && noneMatch.indexOf(cached.headers.etag) > -1) { send(304, null); return true }
    send(200, cached.content, cached.headers)
    return true
  }

  // Resolve a module path to a relative filepath where
  // the module's file exists.
  resolveModule(basePath, path) {
    let resolved
    try { resolved = resolve.sync(path, {basedir: basePath, packageFilter}) }
    catch(e) { return {error: e.toString()} }

    // Builtin modules resolve to strings like "fs". Try again with
    // slash which makes it possible to locally install an equivalent.
    if (resolved.indexOf("/") == -1) {
      try { resolved = resolve.sync(path + "/", {basedir: basePath, packageFilter}) }
      catch(e) { return {error: e.toString()} }
    }

    return {path: "/_m/" + unwin(pth.relative(this.root, resolved))}
  }

  resolveImports(basePath, code) {
    ImportPattern.lastIndex = 0
    let m, result = "", pos = 0
    while (m = ImportPattern.exec(code)) {
      let end = m.index + m[0].length, start = end - m[1].length, source = (0, eval)(m[1])
      result += code.slice(pos, start)
      let {error, path} = this.resolveModule(pth.dirname(basePath), source)
      if (error) return {error}
      result += JSON.stringify(dash(path))
      pos = end
    }
    result += code.slice(pos)
    return {code: result}
  }
}
module.exports = ModuleServer

const String = /'(?:[^\\']|\\.)*'|"(?:[^\\"]|\\.)*"/.source
const Braces = /\{[^}]*\}/.source
const S = /(?:\s|\/\/.*|\/\*.*?\*\/)*/.source
const Id = /[\w$]+/.source
const ImportPattern = new RegExp(
  `(?:\n|;|^)${S}(?:import${S}(?:${Id}${S},${S})?(?:(?:${Braces}|${Id}|\\*${S}as${S}${Id})${S}from${S})?|` +
    `export${S}${Braces}${S}from${S})(${String})${S}(?=\n|;|$)`,
  "g")

function dash(path) { return path.replace(/(^|\/)\.\.(?=$|\/)/g, "$1__") }
function undash(path) { return path.replace(/(^|\/)__(?=$|\/)/g, "$1..") }

const unwin = pth.sep == "\\" ? s => s.replace(/\\/g, "/") : s => s

function packageFilter(pkg) {
  if (pkg.module) pkg.main = pkg.module
  else if (pkg.jnext) pkg.main = pkg.jsnext
  return pkg
}

function hash(str) {
  let sum = crypto.createHash("sha1")
  sum.update(str)
  return sum.digest("hex")
}

function countParentRefs(path) {
  let re = /(^|\/)\.\.(?=\/|$)/g, count = 0
  while (re.exec(path)) count++
  return count
}
