/**
 * Minimal, dependency-free config schema.
 *
 * Why this exists: the plugin is installed as a *linked* package into a DSH
 * profile (`link:<dir>`), so it resolves modules from its own directory only —
 * `@deepseek-ai/schemastery` is not reachable from there. Cordis needs exactly
 * one thing from a plugin's `Config` export: a Standard Schema
 * (`Config['~standard'].validate(value)`), so this module implements that
 * protocol directly.
 *
 * It also mirrors the native Schemastery graph markers (`meta`, `type`, and the
 * `Symbol.for('schemastery')` brand) so the DSH config-schema dump recognises it
 * and can render the declared fields instead of reporting "unsupported".
 *
 * @module dsh-connect-telegram/config-schema
 */

const SCHEMASTER_BRAND = Symbol.for('schemastery')

/**
 * One schema node.
 *
 * DSH reflects on `meta`, `type` and the Schemastery brand; Cordis calls
 * `~standard.validate`; plugins conventionally also call the schema itself to
 * normalize a config object (`Config(raw)`). Schemastery schemas are functions,
 * so this factory returns a callable too — `Config(raw)` validates and returns
 * the normalized value, throwing on invalid input.
 *
 * @param {'object' | 'string' | 'number' | 'boolean' | 'array'} type - declared type.
 * @param {object} meta - Schemastery-shaped metadata (`default`, `description`, `required`).
 * @param {(value: unknown, path: (string | number)[]) => { value?: unknown, issues?: object[] }} validate
 *   validator returning either a normalized value or accumulated issues.
 * @returns {Function & object} the callable schema node.
 */
function makeSchema(type, meta, validate) {
  /**
   * Normalize a config value, throwing the aggregated issues when invalid.
   * @param {unknown} value - raw configuration.
   * @returns {unknown} normalized configuration.
   */
  function normalize(value) {
    const result = validate(value, [])
    if (result.issues !== undefined) {
      const detail = result.issues
        .map((entry) => (entry.path?.length ? `${entry.message} (at ${entry.path.join('.')})` : entry.message))
        .join('; ')
      throw new TypeError(`invalid config: ${detail}`)
    }
    return result.value
  }

  // A function is required: Cordis and the DSH schema dump both treat a
  // Schemastery schema as a callable object.
  const node = function schema(value) {
    return normalize(value)
  }
  node.type = type
  node.meta = meta
  node[SCHEMASTER_BRAND] = true
  node.validateValue = validate
  node.resolve = (value) => [normalize(value), undefined]
  Object.defineProperty(node, '~standard', {
    enumerable: false,
    configurable: true,
    get: () => ({
      version: 1,
      vendor: 'dsh-connect-telegram',
      validate: (value) => {
        const result = validate(value, [])
        return result.issues === undefined ? { value: result.value } : { issues: result.issues }
      },
    }),
  })
  return node
}

/**
 * Build one issue entry in the Standard Schema shape.
 * @param {string} message - human readable problem.
 * @param {(string | number)[]} path - location in the config object.
 * @returns {{ message: string, path: (string | number)[] }} issue.
 */
const issue = (message, path) => ({ message, path: [...path] })

/**
 * Schema for a string field.
 * @param {{ default?: string, description?: string, required?: boolean }} [meta] - field metadata.
 * @returns {Function & object} schema node.
 */
export function stringField(meta = {}) {
  return makeSchema('string', meta, (value, path) => {
    if (value === undefined) {
      if (meta.default !== undefined) return { value: meta.default }
      if (meta.required === false) return { value: undefined }
      return { issues: [issue('is required', path)] }
    }
    if (typeof value !== 'string') return { issues: [issue('must be a string', path)] }
    return { value }
  })
}

/**
 * Schema for a number field with optional integer stepping and bounds.
 * @param {{ default?: number, description?: string, min?: number, max?: number, step?: number }} [meta] - field metadata.
 * @returns {Function & object} schema node.
 */
export function numberField(meta = {}) {
  return makeSchema('number', meta, (value, path) => {
    if (value === undefined) {
      if (meta.default !== undefined) return { value: meta.default }
      return { issues: [issue('is required', path)] }
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) return { issues: [issue('must be a finite number', path)] }
    if (meta.step === 1 && !Number.isInteger(value)) return { issues: [issue('must be an integer', path)] }
    if (meta.min !== undefined && value < meta.min) return { issues: [issue(`must be >= ${meta.min}`, path)] }
    if (meta.max !== undefined && value > meta.max) return { issues: [issue(`must be <= ${meta.max}`, path)] }
    return { value }
  })
}

/**
 * Schema for a boolean field.
 * @param {{ default?: boolean, description?: string }} [meta] - field metadata.
 * @returns {Function & object} schema node.
 */
export function booleanField(meta = {}) {
  return makeSchema('boolean', meta, (value, path) => {
    if (value === undefined) {
      if (meta.default !== undefined) return { value: meta.default }
      return { issues: [issue('is required', path)] }
    }
    if (typeof value !== 'boolean') return { issues: [issue('must be a boolean', path)] }
    return { value }
  })
}

/**
 * Schema for an array of numbers.
 * @param {{ default?: number[], description?: string }} [meta] - field metadata.
 * @returns {Function & object} schema node.
 */
export function numberArrayField(meta = {}) {
  const node = makeSchema('array', meta, (value, path) => {
    if (value === undefined) return { value: meta.default ?? [] }
    if (!Array.isArray(value)) return { issues: [issue('must be an array of numbers', path)] }
    const issues = []
    value.forEach((entry, index) => {
      if (typeof entry !== 'number' || !Number.isFinite(entry)) {
        issues.push(issue('must be a finite number', [...path, index]))
      }
    })
    return issues.length > 0 ? { issues } : { value: [...value] }
  })
  // Schemastery exposes the element schema as `inner`; the JSON-Schema
  // projection reads it to emit `items`, and rejects an array schema without it.
  node.inner = numberField({})
  return node
}

/**
 * Schema for one object with declared fields.
 *
 * Unknown keys are rejected on purpose: a typo in a profile patch (for example
 * `alowedUsers`) would otherwise silently leave the bot open to everyone.
 *
 * @param {Record<string, SchemaNode>} fields - declared fields.
 * @param {{ description?: string }} [meta] - object metadata.
 * @returns {Function & object} schema node.
 */
export function objectField(fields, meta = {}) {
  const node = makeSchema('object', meta, (value, path) => {
    if (value === undefined || value === null) value = {}
    if (typeof value !== 'object' || Array.isArray(value)) return { issues: [issue('must be an object', path)] }
    const issues = []
    const result = {}
    for (const [key, field] of Object.entries(fields)) {
      const outcome = field.validateValue(value[key], [...path, key])
      if (outcome.issues !== undefined) issues.push(...outcome.issues)
      else if (outcome.value !== undefined) result[key] = outcome.value
    }
    for (const key of Object.keys(value)) {
      if (!Object.hasOwn(fields, key)) issues.push(issue('is not a recognized option', [...path, key]))
    }
    return issues.length > 0 ? { issues } : { value: result }
  })
  // Schemastery exposes the declared shape as `dict`; the schema dump walks it.
  node.dict = fields
  return node
}


