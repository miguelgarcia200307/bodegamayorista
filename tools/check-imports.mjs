// Verifica que cada nombre importado entre módulos propios exista como exportación
// (los errores de enlace de ES modules no los detecta `node --check`).
// Uso: node tools/check-imports.mjs
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const root = resolve(new URL('../', import.meta.url).pathname.replace(/^\/(.:)/, '$1'));
const walk = dir => readdirSync(dir).flatMap(name => { const path = join(dir, name); return statSync(path).isDirectory() ? walk(path) : path.endsWith('.js') ? [path] : []; });
const files = walk(join(root, 'js')).filter(path => !path.includes(`${join('js', 'vendor')}`));
const exportsOf = new Map();
const source = path => readFileSync(path, 'utf8');
function exported(path) {
  if (exportsOf.has(path)) return exportsOf.get(path);
  const text = source(path); const names = new Set();
  for (const match of text.matchAll(/export\s+(?:async\s+)?(?:function\*?|const|let|class)\s+([A-Za-z_$][\w$]*)/g)) names.add(match[1]);
  for (const match of text.matchAll(/export\s*\{([^}]*)\}(?:\s*from\s*['"]([^'"]+)['"])?/g)) match[1].split(',').map(part => part.trim()).filter(Boolean).forEach(part => names.add(part.split(/\s+as\s+/).at(-1).trim()));
  exportsOf.set(path, names);
  return names;
}
let problems = 0;
for (const file of files) {
  const text = source(file);
  for (const match of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"](\.[^'"]+)['"]/g)) {
    const target = resolve(dirname(file), match[2]);
    let names;
    try { names = exported(target); } catch { console.log(`✗ ${file}: no existe ${match[2]}`); problems += 1; continue; }
    match[1].split(',').map(part => part.trim()).filter(Boolean).forEach(part => {
      const [name, alias = name] = part.split(/\s+as\s+/).map(value => value.trim());
      if (!names.has(name)) { console.log(`✗ ${file.replace(root, '')}: ${name} no se exporta en ${match[2]}`); problems += 1; }
      // Un nombre importado no puede declararse de nuevo en el módulo.
      if (new RegExp(`^(?:export\\s+)?(?:const|let|var|function|async function|class)\\s+${alias.replace(/\$/g, '\\$')}\\b`, 'm').test(text)) { console.log(`✗ ${file.replace(root, '')}: ${alias} se importa y también se declara`); problems += 1; }
    });
  }
}
console.log(problems ? `${problems} importación(es) rota(s)` : `✓ importaciones válidas en ${files.length} módulos`);
process.exit(problems ? 1 : 0);
