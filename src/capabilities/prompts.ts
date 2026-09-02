import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import { icebergVersionSchema as versionSchema } from '../shared/iceberg-version.js';

export function registerPrompts(server: McpServer, defaultVersion: string): void {
  server.registerPrompt(
    'iceberg-java-usage',
    {
      argsSchema: z.strictObject({
        goal: z.string().trim().min(3).max(2_000),
        type: z.string().max(1_000).optional(),
        version: versionSchema.default(defaultVersion),
      }),
      description:
        'Ground a Java implementation task in exact Iceberg API types, members, stability, and optional source evidence.',
      title: 'Implement with the Iceberg Java API',
    },
    ({ goal, type, version }) => ({
      description: `Investigate an Iceberg Java API task against ${version}.`,
      messages: [
        {
          content: {
            text: [
              `Goal: ${goal}`,
              `Target Iceberg version: ${version}`,
              type === undefined ? undefined : `Starting type: ${type}`,
              'Use iceberg_api_search and exact type/member lookups before proposing code.',
              'Check stability evidence and local source when behavior is not explicit in Javadoc.',
              'Cite the exact qualified types and published URLs used. Do not invent methods.',
            ]
              .filter((line) => line !== undefined)
              .join('\n'),
            type: 'text',
          },
          role: 'user',
        },
      ],
    }),
  );

  server.registerPrompt(
    'iceberg-api-migration',
    {
      argsSchema: z.strictObject({
        from_version: versionSchema,
        goal: z.string().trim().min(3).max(2_000),
        package_name: z.string().max(500).optional(),
        to_version: versionSchema,
      }),
      description:
        'Compare exact published API identities before planning an Iceberg Java version migration.',
      title: 'Plan an Iceberg API migration',
    },
    ({ from_version: fromVersion, goal, package_name: packageName, to_version: toVersion }) => ({
      description: `Plan an Iceberg API migration from ${fromVersion} to ${toVersion}.`,
      messages: [
        {
          content: {
            text: [
              `Migration goal: ${goal}`,
              `Compare ${fromVersion} to ${toVersion}.`,
              packageName === undefined ? undefined : `Limit initial analysis to ${packageName}.`,
              'Use iceberg_api_compare_versions for packages, types, and members, then inspect affected exact types.',
              'Distinguish removed identities from behavior changes that require source or release-note evidence.',
              'Produce a staged migration plan with compatibility risks and verification steps.',
            ]
              .filter((line) => line !== undefined)
              .join('\n'),
            type: 'text',
          },
          role: 'user',
        },
      ],
    }),
  );

  server.registerPrompt(
    'iceberg-catalog-investigation',
    {
      argsSchema: z.strictObject({
        question: z.string().trim().min(3).max(2_000),
      }),
      description:
        'Investigate REST Catalog configuration and metadata read-only before considering any mutation.',
      title: 'Investigate an Iceberg REST Catalog',
    },
    ({ question }) => ({
      description: 'Investigate a configured Iceberg REST Catalog safely.',
      messages: [
        {
          content: {
            text: [
              `Question: ${question}`,
              'Start with iceberg_catalog_get_config and use only advertised read tools.',
              'Follow opaque pagination cursors until the relevant evidence is complete.',
              'Do not request or expose credential values; credential-scope results contain keys only.',
              'If a mutation might be needed, stop after read-only evidence and explain its impact and preconditions.',
            ].join('\n'),
            type: 'text',
          },
          role: 'user',
        },
      ],
    }),
  );
}
