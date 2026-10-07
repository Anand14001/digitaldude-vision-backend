/**
 * Emits the API contract the web client needs to stay in step: every enum in
 * the data model plus the permission registry, as TypeScript unions and const
 * arrays.
 *
 * Run with `npm run emit:contract`. The web project pulls the result in with
 * its own `npm run sync:contract`, so the two codebases share a contract
 * without sharing a build - rename a permission here and the UI stops
 * compiling until it is updated.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Prisma } from '@prisma/client';
import { ALL_PERMISSIONS, PERMISSION_GROUPS } from '../permissions/registry';

const OUT_DIR = path.resolve(__dirname, '../../contract');
const OUT_FILE = path.join(OUT_DIR, 'contract.ts');

const union = (values: readonly string[]) =>
  values.map((value) => `'${value}'`).join(' | ');

function build(): string {
  const enums = Prisma.dmmf.datamodel.enums;

  const enumBlocks = enums
    .map((definition) => {
      const values = definition.values.map((v) => v.name);
      return [
        `export type ${definition.name} = ${union(values)};`,
        `export const ${toConstName(definition.name)}: readonly ${definition.name}[] = [`,
        ...values.map((value) => `  '${value}',`),
        '];',
      ].join('\n');
    })
    .join('\n\n');

  const groupBlocks = PERMISSION_GROUPS.map(
    (group) =>
      `  {\n    module: '${group.module}',\n    label: ${JSON.stringify(group.label)},\n    permissions: [\n${group.permissions
        .map((p) => `      { key: '${p.key}', label: ${JSON.stringify(p.label)} },`)
        .join('\n')}\n    ],\n  },`,
  ).join('\n');

  return `/**
 * GENERATED FILE - do not edit by hand.
 * Produced by digital-dude-api: npm run emit:contract
 * Generated at ${new Date().toISOString()}
 */

${enumBlocks}

/** Every permission key the API recognises. */
export type PermissionKey =
  | ${ALL_PERMISSIONS.map((p) => `'${p}'`).join('\n  | ')};

export const PERMISSION_KEYS: readonly PermissionKey[] = [
${ALL_PERMISSIONS.map((p) => `  '${p}',`).join('\n')}
];

export interface PermissionGroupDefinition {
  module: string;
  label: string;
  permissions: { key: PermissionKey; label: string }[];
}

/** Grouped for the permission matrix in Settings. */
export const PERMISSION_GROUPS: readonly PermissionGroupDefinition[] = [
${groupBlocks}
];
`;
}

/** ProjectStatus -> PROJECT_STATUS_VALUES */
function toConstName(name: string): string {
  return `${name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toUpperCase()}_VALUES`;
}

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(OUT_FILE, build(), 'utf8');
console.log(
  `Contract written to ${path.relative(process.cwd(), OUT_FILE)} ` +
    `(${Prisma.dmmf.datamodel.enums.length} enums, ${ALL_PERMISSIONS.length} permissions)`,
);
