import { readFileSync } from 'node:fs';
import { parse } from 'acorn';

const file = process.argv[2] ?? 'dist/webview.js';
const source = readFileSync(file, 'utf8');

/**
 * 用 acorn 解析真实语法树，而不是手写字符串/注释掩码。上一版掩码器不识别
 * 正则字面量，可能把文件末尾的真实代码当成字符串，导致注入的 process.env 漏检。
 */
let ast;
try {
  ast = parse(source, {
    ecmaVersion: 'latest',
    sourceType: 'module',
    locations: true,
    allowHashBang: true,
    allowAwaitOutsideFunction: true,
  });
} catch (error) {
  console.error(`check-webview-bundle: ${file} 解析失败：${error.message}`);
  process.exit(1);
}

const GLOBAL_NAMES = new Set(['process', 'global', 'Buffer', '__dirname', '__filename']);
const findings = [];
const guarded = [];

function containsTypeofProcess(node) {
  let found = false;
  const visit = (current) => {
    if (found || !current || typeof current.type !== 'string') {
      return;
    }
    if (
      current.type === 'UnaryExpression' &&
      current.operator === 'typeof' &&
      current.argument.type === 'Identifier' &&
      current.argument.name === 'process'
    ) {
      found = true;
      return;
    }
    for (const key of Object.keys(current)) {
      if (key === 'start' || key === 'end' || key === 'loc' || key === 'range') {
        continue;
      }
      const value = current[key];
      if (Array.isArray(value)) {
        for (const child of value) {
          visit(child);
        }
      } else {
        visit(value);
      }
    }
  };
  visit(node);
  return found;
}

function isGuardedByTypeof(ancestors) {
  for (let index = ancestors.length - 1; index >= 0; index--) {
    const ancestor = ancestors[index];
    const test =
      ancestor.type === 'IfStatement' ||
      ancestor.type === 'ConditionalExpression' ||
      ancestor.type === 'WhileStatement' ||
      ancestor.type === 'DoWhileStatement' ||
      ancestor.type === 'ForStatement'
        ? ancestor.test
        : ancestor.type === 'LogicalExpression'
          ? ancestor
          : null;
    if (test && containsTypeofProcess(test)) {
      return true;
    }
  }
  return false;
}

function isReferenceIdentifier(node, parent) {
  if (!parent) {
    return false;
  }
  if (parent.type === 'MemberExpression') {
    return parent.object === node || parent.computed;
  }
  if (
    (parent.type === 'Property' ||
      parent.type === 'MethodDefinition' ||
      parent.type === 'PropertyDefinition') &&
    parent.key === node &&
    !parent.computed
  ) {
    return false;
  }
  if (parent.type === 'VariableDeclarator' && parent.id === node) {
    return false;
  }
  if (
    (parent.type === 'FunctionDeclaration' ||
      parent.type === 'FunctionExpression' ||
      parent.type === 'ArrowFunctionExpression') &&
    (parent.id === node || parent.params.includes(node))
  ) {
    return false;
  }
  if (
    (parent.type === 'ClassDeclaration' || parent.type === 'ClassExpression') &&
    parent.id === node
  ) {
    return false;
  }
  if (
    (parent.type === 'LabeledStatement' ||
      parent.type === 'BreakStatement' ||
      parent.type === 'ContinueStatement') &&
    parent.label === node
  ) {
    return false;
  }
  if (
    (parent.type === 'ImportSpecifier' ||
      parent.type === 'ImportDefaultSpecifier' ||
      parent.type === 'ImportNamespaceSpecifier' ||
      parent.type === 'ExportSpecifier') &&
    (parent.local === node || parent.imported === node || parent.exported === node)
  ) {
    return false;
  }
  if (parent.type === 'CatchClause' && parent.param === node) {
    return false;
  }
  return true;
}

function addFinding(node, name) {
  findings.push({
    name,
    line: node.loc.start.line,
    column: node.loc.start.column + 1,
    excerpt: source.slice(Math.max(0, node.start - 40), node.end + 60).replace(/\s+/g, ' '),
  });
}

function visit(node, ancestors = []) {
  if (!node || typeof node.type !== 'string') {
    return;
  }

  if (node.type === 'Identifier' && GLOBAL_NAMES.has(node.name)) {
    const parent = ancestors[ancestors.length - 1];
    if (isReferenceIdentifier(node, parent)) {
      const isTypeofArgument =
        parent?.type === 'UnaryExpression' &&
        parent.operator === 'typeof' &&
        parent.argument === node;
      const isEnv =
        node.name === 'process' &&
        parent?.type === 'MemberExpression' &&
        parent.object === node &&
        ((!parent.computed &&
          parent.property.type === 'Identifier' &&
          parent.property.name === 'env') ||
          (parent.computed &&
            parent.property.type === 'Literal' &&
            parent.property.value === 'env'));

      if (isEnv) {
        addFinding(node, node.name);
      } else if (isTypeofArgument || (node.name === 'process' && isGuardedByTypeof(ancestors))) {
        guarded.push({ name: node.name });
      } else {
        addFinding(node, node.name);
      }
    }
  }

  for (const key of Object.keys(node)) {
    if (key === 'start' || key === 'end' || key === 'loc' || key === 'range') {
      continue;
    }
    const value = node[key];
    if (Array.isArray(value)) {
      for (const child of value) {
        if (child && typeof child.type === 'string') {
          visit(child, [...ancestors, node]);
        }
      }
    } else if (value && typeof value.type === 'string') {
      visit(value, [...ancestors, node]);
    }
  }
}

visit(ast);

if (findings.length > 0) {
  console.error(`check-webview-bundle: ${file} 含未受保护的 Node 全局引用`);
  for (const finding of findings) {
    console.error(
      `  ${finding.name} at ${finding.line}:${finding.column}  ...${finding.excerpt}...`,
    );
  }
  process.exit(1);
}

const summary = ['process', 'global', 'Buffer', '__dirname', '__filename']
  .map((name) => {
    const count = guarded.filter((item) => item.name === name).length;
    return count > 0 ? `${name}: ${count} guarded` : `${name}: 0`;
  })
  .join(', ');
console.log(
  `check-webview-bundle: OK (${file}, ${Buffer.byteLength(source, 'utf8')} bytes) — ${summary}`,
);
