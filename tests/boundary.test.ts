import { test, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import ts from 'typescript';
async function files(dir: string): Promise<string[]> {
  return (
    await Promise.all(
      (await fs.readdir(dir, { withFileTypes: true })).map((e) =>
        e.isDirectory() ? files(`${dir}/${e.name}`) : [`${dir}/${e.name}`],
      ),
    )
  ).flat();
}
test('portable entrypoint and core contain no OS imports or host process access', async () => {
  for (const file of [...(await files('src/core')), 'src/index.ts']) {
    const source = await fs.readFile(file, 'utf8');
    expect(source, file).not.toMatch(
      /\bprocess\s*(?:\.\s*(?:platform|cwd|env)|\[)/,
    );
    const tree = ts.createSourceFile(
      file,
      source,
      ts.ScriptTarget.Latest,
      true,
    );
    function visit(node: ts.Node) {
      if (ts.isIdentifier(node) && ['process', 'Buffer'].includes(node.text))
        throw new Error(`Forbidden host identifier in ${file}: ${node.text}`);
      const parent = node.parent;
      const isModule =
        parent &&
        (((ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) &&
          parent.moduleSpecifier === node) ||
          (ts.isCallExpression(parent) &&
            (parent.expression.kind === ts.SyntaxKind.ImportKeyword ||
              parent.expression.getText(tree) === 'require')));
      if (
        isModule &&
        ts.isStringLiteral(node) &&
        /^(?:node:)?(?:fs|path|os|child_process)(?:\/|$)/.test(node.text)
      )
        throw new Error(`Forbidden OS module in ${file}: ${node.text}`);
      ts.forEachChild(node, visit);
    }
    visit(tree);
  }
});
test('Node backend launches only the selected shell, with no helper CLI', async () => {
  for (const file of await files('src/node')) {
    const source = await fs.readFile(file, 'utf8');
    expect(source).not.toMatch(
      /\b(?:python3|stdbuf|setsid|execFile|execSync)\b/,
    );
  }
});
