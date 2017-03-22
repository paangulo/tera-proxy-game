const path = require('path');
const binarySearch = require('binary-search');
const errorStackParser = require('error-stack-parser');
const { protocol } = require('tera-data-parser');
const Wrapper = require('./dispatchWrapper');

protocol.load(require.resolve('tera-data'));

function tryIt(func) {
  try {
    return func();
  } catch (e) {
    return e;
  }
}

function normalizeName(name) {
  if (name === 'sF2pPremiumUserPermission') {
    return 'S_F2P_PremiumUser_Permission';
  } else if (name.indexOf('_') === -1) {
    return name.replace(/[A-Z]/g, '_$&').toUpperCase();
  } else {
    return name;
  }
}

function getHookName(hook) {
  const callbackName = (hook.callback && hook.callback.name) || '<unknown>';
  const moduleName = hook.moduleName || '<unknown>';
  return `${callbackName} @ ${moduleName}`;
}

function getMessageName(identifier, version, originalName) {
  if (typeof identifier === 'string') {
    const append = (identifier !== originalName) ? ` (original: "${originalName}")` : '';
    return `${identifier}<${version}>${append}`;
  } else if (typeof identifier === 'number') {
    const name = protocol.map.code.get(identifier) || `(opcode ${identifier})`;
    return `${name}<${version}>`;
  } else {
    return '(?)';
  }
}

function errStack(err = new Error(), removeFront = true) {
  const stack = errorStackParser.parse(err);

  // remove node internals from end
  while (!path.isAbsolute(stack[stack.length - 1].fileName)) {
    stack.pop();
  }

  // remove tera-proxy-game internals from end
  while (stack[stack.length - 1].fileName.match(/tera-proxy-game[\\/]lib/)) {
    stack.pop();
  }

  if (removeFront) {
    // remove tera-proxy-game internals from front
    while (stack[0].fileName.match(/tera-proxy-game[\\/]lib/)) {
      stack.shift();
    }
  }

  return stack.map(frame => frame.source).join('\n');
}

function logError(message, data) {
  console.error(Array.isArray(message) ? message.join('\n') : message);

  if (data) {
    console.error('Data:');
    console.error(data);
  }
}

class Dispatch {
  constructor(connection) {
    this.connection = connection;
    this.modules = new Map();

    // hooks:
    // { <code>:
    //   [ { <order>
    //     , hooks:
    //       [ { <code>, <order>, <definitionVersion>, <type>, <moduleName>, <callback> }
    //       ]
    //     }
    //   ]
    // }
    this.hooks = new Map();
  }

  reset() {
    for (const name of this.modules.keys()) {
      this.unload(name);
    }

    this.modules.clear();
    this.hooks.clear();
  }

  load(name, from = module, ...args) {
    const mod = this.modules.get(name);
    if (mod) return mod;

    if (typeof from.require !== 'function' && typeof from === 'function') {
      // `from` is a function, so use itself the module constructor
      from = { require: (ModuleConstructor => () => ModuleConstructor)(from) };
    }

    try {
      const ModuleConstructor = from.require(name);
      const wrapper = new Wrapper(this, name);
      const mod = new ModuleConstructor(wrapper, ...args);
      this.modules.set(name, mod);

      console.log('[dispatch] loaded "%s"', name);
      return mod;
    } catch (e) {
      logError([
        `[dispatch] load: error initializing module "${name}"`,
        `error: ${e.message}`,
        errStack(e),
      ]);
    }
  }

  unload(name) {
    const mod = this.modules.get(name);

    if (!mod) {
      logError([
        `[dispatch] unload: cannot unload non-loaded module "${name}"`,
        errStack(),
      ]);
      return false;
    }

    for (const orderings of this.hooks.values()) {
      for (const ordering of orderings) {
        ordering.hooks = ordering.hooks.filter(hook => hook.moduleName !== name);
      }
    }

    if (typeof mod.destructor === 'function') {
      try {
        mod.destructor();
      } catch (e) {
        logError([
          `[dispatch] unload: error running destructor for module "${name}"`,
          `error: ${e.message}`,
          errStack(e),
        ]);
      }
    }

    this.modules.delete(name);
    return true;
  }

  createHook(name, version, opts, cb) {
    // parse args
    if (version) {
      if (typeof version !== 'number' && typeof version !== 'string') {
        cb = opts;
        opts = version;
        version = '*';

        if (!process.env.NO_WARN_IMPLIED_VERSION) {
          logError([
            `[dispatch] hook: using implied latest version for "${name}"`,
            errStack(),
          ]);
        }
      }
    }

    if (opts && typeof opts !== 'object') {
      cb = opts;
      opts = {};
    }

    if (typeof cb !== 'function') {
      cb = () => {};

      logError([
        `[dispatch] hook: last argument not a function (given: ${typeof cb})`,
        errStack(),
      ]);
    }

    // retrieve opcode
    let code;
    if (name === '*') {
      code = name;
      if (typeof version === 'number') {
        logError([
          `[dispatch] hook: * hook must request version '*' or 'raw' (given: ${version})`,
          errStack(),
        ]);

        version = '*';
      }
    } else {
      const normalizedName = normalizeName(name);
      code = protocol.map.name.get(normalizedName);
      if (code == null) {
        logError([
          `[dispatch] hook: unrecognized hook target ${getMessageName(normalizedName, version, name)}`,
          errStack(),
        ]);

        code = '_UNKNOWN';
      }
    }

    // check version
    if (typeof version !== 'number') {
      if (version === 'latest') version = '*';
      if (version !== '*' && version !== 'raw') {
        // TODO warning
        version = '*';
      }
    }

    return {
      code,
      order: opts.order || 0,
      definitionVersion: version,
      type: opts.type || 'real',
      callback: cb,
    };
  }

  hook(...args) {
    const hook = this.createHook(...args);
    const { code, order } = hook;

    if (!this.hooks.has(code)) {
      this.hooks.set(code, []);
    }

    const ordering = this.hooks.get(code);
    const index = binarySearch(ordering, order, (a, b) => a.order - b.order);
    if (index < 0) {
      ordering.splice(~index, 0, { order, hooks: [hook] });
    } else {
      ordering[index].hooks.push(hook);
    }

    return hook;
  }

  unhook(hook) {
    if (!this.hooks.has(hook.code)) return;

    const ordering = this.hooks.get(hook.code);
    const group = ordering.find(o => o.order === hook.order);
    if (group) group.hooks = group.hooks.filter(h => h !== hook);
  }

  write(outgoing, name, version, data) {
    if (!this.connection) return false;

    if (Buffer.isBuffer(name)) {
      data = name;
    } else {
      const normalizedName = normalizeName(name);

      if (!data && typeof version === 'object') {
        data = version;
        version = '*';

        if (!process.env.NO_WARN_IMPLIED_VERSION) {
          logError(`[dispatch] write: using implied latest version for "${normalizedName}"\n${errStack()}`);
        }
      }

      try {
        data = protocol.write(normalizedName, version, data);
      } catch (e) {
        logError([
          `[dispatch] write: failed to generate ${getMessageName(normalizedName, version, name)}`,
          `error: ${e.message}`,
          errStack(e, false),
        ], data);
        return false;
      }

      data = this.handle(data, !outgoing, true);
      if (data === false) return false;
    }
    this.connection[outgoing ? 'sendServer' : 'sendClient'](data);
    return true;
  }

  handle(data, fromServer, fake = false) {
    const code = data.readUInt16LE(2);
    for (const target of ['*', code]) {
      if (!this.hooks.has(target)) continue;

      for (const order of this.hooks.get(target)) {
        for (const hook of order.hooks) {
          if (hook.type !== 'all') {
            if (!fake && hook.type === 'fake') continue;
            if (fake && hook.type === 'real') continue;
          }

          if (hook.definitionVersion === 'raw') {
            const result = tryIt(() => hook.callback(code, data, fromServer, fake));

            if (result instanceof Error) {
              logError([
                `[dispatch] handle: error running raw hook for ${getMessageName(code, hook.definitionVersion)}`,
                `hook: ${getHookName(hook)}`,
                `error: ${result.message}`,
                errStack(result),
              ], data.toString('hex'));
              continue;
            } else if (Buffer.isBuffer(result)) {
              data = result;
            } else if (result === false) {
              return false;
            }
          } else { // normal hook
            const event = tryIt(() => protocol.parse(code, hook.definitionVersion, data));

            if (event instanceof Error) {
              logError([
                `[dispatch] handle: failed to parse ${getMessageName(code, hook.definitionVersion)}`,
                `hook: ${getHookName(hook)}`,
                `error: ${event.message}`,
                errStack(event, false),
              ], data.toString('hex'));
              return data;
            }

            const result = tryIt(() => hook.callback(event, fake));
            if (result instanceof Error) {
              logError([
                `[dispatch] handle: error running hook for ${getMessageName(code, hook.definitionVersion)}`,
                `hook: ${getHookName(hook)}`,
                `error: ${result.message}`,
                errStack(result),
              ], event);
            } else if (result === true) {
              try {
                data = protocol.write(code, hook.definitionVersion, event);
              } catch (e) {
                logError([
                  `[dispatch] handle: failed to generate ${getMessageName(code, hook.definitionVersion)}`,
                  `hook: ${getHookName(hook)}`,
                  `error: ${e.message}`,
                  errStack(e, false),
                ], event);
              }
            } else if (result === false) {
              return false;
            }
          }
        }
      }
    }

    // return value
    return data;
  }
}

module.exports = Dispatch;