// Lint configuration. It exists to catch defects that have actually shipped here, not to enforce style:
// a merge once dropped four imports from public/app.js and the SPA rendered a blank page for every user.
// `no-undef` catches a use without an import; `shipproof/named-imports-exist` catches an import of a name the
// target module does not export (a link-time crash in the browser, since the frontend has no build step).
import fs from 'node:fs';
import path from 'node:path';
import js from '@eslint/js';
import globals from 'globals';
import * as espree from 'espree';

const exportCache = new Map(); // absolute path -> { mtimeMs, names: Set<string> | null }

function patternNames(node, out) {
  if (!node) return out;
  if (node.type === 'Identifier') out.push(node.name);
  else if (node.type === 'ObjectPattern') node.properties.forEach((p) => patternNames(p.type === 'RestElement' ? p.argument : p.value, out));
  else if (node.type === 'ArrayPattern') node.elements.forEach((e) => patternNames(e, out));
  else if (node.type === 'AssignmentPattern') patternNames(node.left, out);
  else if (node.type === 'RestElement') patternNames(node.argument, out);
  return out;
}
const specName = (n) => (n.type === 'Literal' ? String(n.value) : n.name);

// Export names of an ES module file, following `export * from`. Returns null when the file cannot be parsed.
function exportsOf(file, seen = new Set()) {
  if (seen.has(file)) return new Set();
  seen.add(file);
  let stat;
  try { stat = fs.statSync(file); } catch { return null; }
  const hit = exportCache.get(file);
  if (hit && hit.mtimeMs === stat.mtimeMs) return hit.names;
  let names = null;
  try {
    const ast = espree.parse(fs.readFileSync(file, 'utf8'), { ecmaVersion: 'latest', sourceType: 'module' });
    names = new Set();
    for (const node of ast.body) {
      if (node.type === 'ExportDefaultDeclaration') names.add('default');
      else if (node.type === 'ExportNamedDeclaration') {
        const d = node.declaration;
        if (d?.id) names.add(d.id.name);
        if (d?.type === 'VariableDeclaration') d.declarations.forEach((v) => patternNames(v.id, []).forEach((n) => names.add(n)));
        node.specifiers.forEach((s) => names.add(specName(s.exported)));
      } else if (node.type === 'ExportAllDeclaration') {
        if (node.exported) names.add(specName(node.exported));
        else {
          const inner = exportsOf(path.resolve(path.dirname(file), node.source.value), seen);
          inner?.forEach((n) => n !== 'default' && names.add(n));
        }
      }
    }
  } catch { names = null; }
  exportCache.set(file, { mtimeMs: stat.mtimeMs, names });
  return names;
}

const namedImportsExist = {
  meta: { type: 'problem', docs: { description: 'Relative imports must resolve to a file that exports every imported name.' }, schema: [] },
  create(context) {
    const dir = path.dirname(context.filename);
    const check = (sourceNode, wanted) => {
      const spec = sourceNode.value;
      if (typeof spec !== 'string' || !spec.startsWith('.')) return;
      const target = path.resolve(dir, spec);
      if (!fs.existsSync(target)) return context.report({ node: sourceNode, message: `Cannot resolve "${spec}".` });
      if (!wanted.length || /\.(json|cjs|py)$/.test(target)) return;
      const names = exportsOf(target);
      if (!names) return; // unparseable target: no claim either way
      for (const { name, node } of wanted) {
        if (!names.has(name)) context.report({ node, message: `"${spec}" does not export "${name}".` });
      }
    };
    return {
      ImportDeclaration(node) {
        check(node.source, node.specifiers.flatMap((s) => (s.type === 'ImportSpecifier' ? [{ name: specName(s.imported), node: s }]
          : s.type === 'ImportDefaultSpecifier' ? [{ name: 'default', node: s }] : [])));
      },
      ExportNamedDeclaration(node) { if (node.source) check(node.source, node.specifiers.map((s) => ({ name: specName(s.local), node: s }))); },
      ExportAllDeclaration(node) { check(node.source, []); },
      ImportExpression(node) { if (node.source.type === 'Literal') check(node.source, []); },
    };
  },
};

export default [
  { ignores: ['node_modules/', 'data/', 'docs/', 'gatekeeper-main/', 'playtest-agent-main/', 'oqed-main/', '**/*.min.js'] },
  js.configs.recommended,
  {
    files: ['**/*.{js,mjs}'],
    plugins: { shipproof: { rules: { 'named-imports-exist': namedImportsExist } } },
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: { ...globals.node } },
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    rules: {
      'shipproof/named-imports-exist': 'error',
      'no-undef': 'error',
      // Empty catch blocks are a deliberate idiom here (best-effort cleanup, optional probes).
      'no-empty': ['error', { allowEmptyCatch: true }],
      // Reviewed and found deliberate: initialise-then-overwrite locals, and control-character sanitisers in proof.js.
      'no-useless-assignment': 'off',
      'no-control-regex': 'off',
      'no-useless-escape': 'warn',
      'preserve-caught-error': 'warn',
      'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none', varsIgnorePattern: '^_', ignoreRestSiblings: true }],
    },
  },
  { files: ['public/**/*.js'], languageOptions: { globals: { ...globals.browser } } },
  { files: ['tests/**/*.js'], languageOptions: { globals: { ...globals.node, ...globals.browser } } },
];
